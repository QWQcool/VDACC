/**
 * 异步 ffmpeg：合并/写标签动辄几十秒，`spawnSync` 会把整个事件循环卡住——
 * 期间 SSE 不推、取消按钮不响应，更谈不上并发。
 *
 * 取消策略：200ms 轮询当前任务作用域的 cancelled 回调，命中就 kill 子进程；
 * 已经写了一半的中间文件由调用方清理（各引擎原本就有清理路径）。
 */
import { DownloadCancelled, isCancelled } from './cancel';

export interface FfmpegResult {
  code: number;
  stderr: string;
  killed: boolean;
}

export function ffmpegBin(): string {
  return process.env.VDL_FFMPEG || 'ffmpeg';
}

export async function runFfmpeg(
  args: string[], opts: { timeoutMs?: number } = {},
): Promise<FfmpegResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([ffmpegBin(), ...args], {
      stdout: 'ignore',
      stderr: 'pipe',
      windowsHide: true,
    });
  } catch (err) {
    // 找不到 ffmpeg 时 Bun.spawn 直接抛；用 -2 让调用方区分「没装」与「跑失败」
    return { code: -2, stderr: (err as Error).message, killed: false };
  }

  let killed = false;
  let timedOut = false;
  const poll = setInterval(() => {
    if (!killed && proc.exitCode === null && isCancelled()) {
      killed = true;
      try { proc.kill(); } catch { /* 进程可能已退出 */ }
    }
  }, 200);

  const timeout = opts.timeoutMs
    ? setTimeout(() => {
      if (proc.exitCode === null) {
        timedOut = true;
        try { proc.kill(); } catch { /* ignore */ }
      }
    }, opts.timeoutMs)
    : null;

  const stderr = await new Response(proc.stderr as ReadableStream).text();
  const code = await proc.exited;
  clearInterval(poll);
  if (timeout) clearTimeout(timeout);

  if (killed) throw new DownloadCancelled('已取消（ffmpeg 已终止）');
  if (timedOut) {
    return { code: -1, stderr: `${stderr}\n[timeout ${opts.timeoutMs}ms]`.trim(), killed: false };
  }
  return { code, stderr, killed };
}
