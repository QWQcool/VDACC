/**
 * JS ↔ 原生 的唯一通道（设计稿 §5 的 reqId 协议）。
 *
 * 协议：
 *   JS:   window.VDACC_BRIDGE.post(reqId, method, payloadJson)   ← @JavascriptInterface
 *   原生: evaluateJavascript("__VDACC_BRIDGE_RESOLVE__('reqId', json)")
 *
 * 为什么必须异步：M1 起 `transfer.start` / `media.mux` 是秒级以上的操作，
 * 同步桥会把 JS 线程整段卡住（WebView 里就是界面假死）。reqId 让慢操作不阻塞渲染。
 *
 * 为什么自己管 Map 而不是让原生直接回调函数：WebView 的 JS 对象没法安全地跨线程持有，
 * 字符串 reqId 是唯一能可靠穿过 JavaBridge 线程 / UI 线程 / evaluateJavascript 的东西。
 */
export type BridgeErrorCode =
  | 'bridge_unavailable'
  | 'timeout'
  | 'bad_response'
  | 'unsupported_method'
  | 'io_error'
  | (string & {});

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/** 原生侧回复的信封（Kotlin 侧必须按这个形状回）。 */
export type BridgeEnvelope =
  | { ok: true; data?: unknown }
  | { ok: false; error?: { code?: string; message?: string } };

/** 传输层：把一次调用交给原生。可被 selftest 替换成假桥。 */
export type BridgeTransport = (reqId: string, method: string, payloadJson: string) => void;

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const pending = new Map<string, Pending>();
let seq = 0;
let transport: BridgeTransport | null = null;

/** 默认传输：从页面注入的 window.VDACC_BRIDGE 发出。 */
function defaultTransport(reqId: string, method: string, payloadJson: string): void {
  const api = (globalThis as unknown as { VDACC_BRIDGE?: { post?: unknown } }).VDACC_BRIDGE;
  if (!api || typeof api.post !== 'function') {
    throw new BridgeError(
      'bridge_unavailable',
      '页面里没有 window.VDACC_BRIDGE.post —— 这个页面不是由 Android 壳加载的，或壳没有注册桥',
    );
  }
  (api.post as (a: string, b: string, c: string) => void)(reqId, method, payloadJson);
}

/** 替换传输层（selftest / 单测用）。传 null 恢复默认。 */
export function setBridgeTransport(next: BridgeTransport | null): void {
  transport = next;
}

export type CallOptions = {
  /** 默认 15s。慢操作（合并/下载）由原生自己推进度事件，不走这里。 */
  timeoutMs?: number;
};

export function call<T = unknown>(method: string, payload?: unknown, options: CallOptions = {}): Promise<T> {
  const reqId = `r${(seq += 1)}`;
  const timeoutMs = options.timeoutMs ?? 15000;
  const payloadJson = payload === undefined ? '{}' : JSON.stringify(payload);

  return new Promise<T>((resolve, reject) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        pending.delete(reqId);
        reject(new BridgeError('timeout', `${method} 超过 ${timeoutMs}ms 没有回应`));
      }, timeoutMs)
      : null;

    pending.set(reqId, { method, resolve: resolve as (v: unknown) => void, reject, timer });

    try {
      (transport ?? defaultTransport)(reqId, method, payloadJson);
    } catch (error) {
      const entry = pending.get(reqId);
      pending.delete(reqId);
      if (entry?.timer) clearTimeout(entry.timer);
      reject(error);
    }
  });
}

/**
 * 原生回填结果。**由 Kotlin 侧通过 evaluateJavascript 调用**，不要在引擎里直接调。
 * 入参 json 是字符串（原生侧做过转义），解析失败按 bad_response 报，不吞。
 */
export function resolveBridgeCall(reqId: string, resultJson: string): void {
  const entry = pending.get(reqId);
  if (!entry) return; // 超时后迟到的回复，直接丢弃
  pending.delete(reqId);
  if (entry.timer) clearTimeout(entry.timer);

  let envelope: BridgeEnvelope;
  try {
    envelope = JSON.parse(resultJson) as BridgeEnvelope;
  } catch {
    entry.reject(new BridgeError('bad_response', `${entry.method} 的返回值不是 JSON`));
    return;
  }

  if (envelope && envelope.ok === true) {
    entry.resolve(envelope.data);
    return;
  }
  const error = (envelope as { error?: { code?: string; message?: string } } | null)?.error;
  entry.reject(new BridgeError(error?.code ?? 'bad_response', error?.message ?? `${entry.method} 失败`));
}

/** 方便排查：当前还在等回复的调用数（正常应为 0）。 */
export function pendingBridgeCalls(): number {
  return pending.size;
}

// 原生就靠这个全局名字回填，名字改了两边一起改。
(globalThis as unknown as { __VDACC_BRIDGE_RESOLVE__?: unknown }).__VDACC_BRIDGE_RESOLVE__ = resolveBridgeCall;
