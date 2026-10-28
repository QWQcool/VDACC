/**
 * 原生流式下载的 JS 侧（`transfer.start` / `transfer.cancel`）。
 *
 * 与 `bridge.call()` 的区别：下载的进度是**持续推送**的，不是一问一答。
 * `transfer.start` 立刻返回 jobId，之后原生通过
 * `window.__VDACC_EVENT__('transfer', jobId, {...})` 推 `start/progress/done/failed/cancelled`。
 * 所以这里维护一张 jobId → 监听器 的表，并把事件包成 Promise。
 *
 * 为什么要缓冲「先到的事件」：`transfer.start` 一返回原生就开始跑了，
 * 而监听器要等 `call()` 的 Promise resolve 之后才挂上——中间有个微任务间隙，
 * 小文件可能在这个间隙里就把 `start` 甚至 `done` 发完了。丢 `done` 会让调用方永远挂着。
 */
import { call } from './bridge';

export type TransferEvent = {
  status: 'start' | 'progress' | 'done' | 'cancelled' | 'failed';
  bytes?: number;
  total?: number;
  resumeFrom?: number;
  path?: string;
  name?: string;
  outKind?: string;
  code?: string;
  message?: string;
};

export type TransferResult = {
  path: string;
  bytes: number;
  name: string;
  outKind: string;
};

export type TransferHandle = {
  jobId: string;
  /** 开始下载前 `.part` 已有的字节数；>0 说明这次是续传。 */
  resumeFrom: number;
  done: Promise<TransferResult>;
  cancel: () => Promise<boolean>;
};

type Listener = (event: TransferEvent) => void;

const listeners = new Map<string, Listener>();
/** 监听器挂上之前就到的事件，最多留几条（够覆盖 start/progress/done） */
const early = new Map<string, TransferEvent[]>();

function transferError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function dispatch(name: string, jobId: string, json: string): void {
  if (name !== 'transfer') return;
  let event: TransferEvent;
  try {
    event = JSON.parse(json) as TransferEvent;
  } catch {
    return;
  }
  const listener = listeners.get(jobId);
  if (listener) {
    listener(event);
    return;
  }
  const buffer = early.get(jobId) ?? [];
  buffer.push(event);
  // 只留最后 8 条：早期事件本来只是给「start/progress」看的，不必无限攒
  if (buffer.length > 8) buffer.shift();
  early.set(jobId, buffer);
}

(globalThis as unknown as { __VDACC_EVENT__?: unknown }).__VDACC_EVENT__ = dispatch;

export type StartOptions = {
  url: string;
  name: string;
  referer?: string;
  userAgent?: string;
  onProgress?: (bytes: number, total: number) => void;
};

export async function startTransfer(options: StartOptions): Promise<TransferHandle> {
  const started = await call<{ jobId: string; name: string; resumeFrom: number }>(
    'transfer.start',
    {
      url: options.url,
      name: options.name,
      referer: options.referer ?? '',
      userAgent: options.userAgent ?? '',
    },
  );

  const jobId = started.jobId;
  let settle!: (result: TransferResult) => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<TransferResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const listener: Listener = (event) => {
    if (event.status === 'start' || event.status === 'progress') {
      options.onProgress?.(event.bytes ?? 0, event.total ?? 0);
      return;
    }
    listeners.delete(jobId);
    early.delete(jobId);
    if (event.status === 'done') {
      const bytes = event.bytes ?? 0;
      options.onProgress?.(bytes, bytes);
      settle({
        path: event.path ?? '',
        bytes,
        name: event.name ?? started.name,
        outKind: event.outKind ?? '',
      });
      return;
    }
    if (event.status === 'cancelled') {
      fail(transferError('cancelled', `已取消（已写 ${event.bytes ?? 0} 字节，可续传）`));
      return;
    }
    fail(transferError(event.code ?? 'EIO', event.message ?? '下载失败'));
  };

  listeners.set(jobId, listener);
  // 回放监听器挂上之前就到达的事件
  const buffered = early.get(jobId);
  early.delete(jobId);
  if (buffered) for (const event of buffered) listener(event);

  return {
    jobId,
    resumeFrom: started.resumeFrom ?? 0,
    done,
    cancel: async () => {
      const res = await call<{ cancelled: boolean }>('transfer.cancel', { jobId });
      return !!res?.cancelled;
    },
  };
}

/** 按 jobId 取消（页面在拿到 handle 之前也可能需要取消，所以单独导出）。 */
export async function cancelTransferById(jobId: string): Promise<boolean> {
  const res = await call<{ cancelled: boolean }>('transfer.cancel', { jobId });
  return !!res?.cancelled;
}

/** 正在等待结果的 job 数（排查用，正常应回到 0）。 */
export function pendingTransfers(): number {
  return listeners.size;
}
