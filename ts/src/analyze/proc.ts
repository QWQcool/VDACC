/**
 * 分析链路的子进程封装。
 *
 * 为什么要单独开一个：`core/ffmpeg.runFfmpeg` 刻意 `stdout: 'ignore'`
 * （合并、写标签只看退码，stdout 里没有有用信息），而分析要读 stdout：
 * `scdet` 的切点时间、`ffprobe` 的 JSON、灰度帧的 256 个像素。
 * 直接改 runFfmpeg 会动到下载链路，没必要。
 */
import { ffmpegBin } from '../core/ffmpeg';

/** ffprobe 与 ffmpeg 通常同目录：给了 VDL_FFMPEG 就顺手推出同目录的 ffprobe。 */
export function ffprobeBin(): string {
  if (process.env.VDL_FFPROBE) return process.env.VDL_FFPROBE;
  const ff = process.env.VDL_FFMPEG;
  if (!ff) return 'ffprobe';
  const cut = ff.search(/[\\/][^\\/]+$/);
  if (cut < 0) return 'ffprobe';
  const dir = ff.slice(0, cut);
  const exe = ff.toLowerCase().endsWith('.exe') ? '.exe' : '';
  return `${dir}${ff[cut]}ffprobe${exe}`;
}

export interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * 跑一个外部命令并同时收 stdout/stderr。
 *
 * 必须**并发**读两条流：ffmpeg 的 stderr 日志能到几十 KB，
 * 先读完 stdout 再读 stderr 会在管道写满时双向卡死。
 * `code === -2` 表示命令根本起不来（没装 ffmpeg），调用方据此报 `ffmpeg_missing`。
 */
export async function exec(bin: string, args: string[], timeoutMs = 0): Promise<ExecResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  } catch (error) {
    return { code: -2, stdout: Buffer.alloc(0), stderr: (error as Error).message };
  }

  const timer = timeoutMs > 0
    ? setTimeout(() => { try { proc.kill(); } catch { /* 已退出 */ } }, timeoutMs)
    : null;

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream)
      .arrayBuffer().then((b) => Buffer.from(b)).catch(() => Buffer.alloc(0)),
    new Response(proc.stderr as ReadableStream)
      .text().catch(() => ''),
  ]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
}

/** ffmpeg 的简写：参数固定加 `-hide_banner -loglevel error`，免得日志混进解析。 */
export function ffmpeg(args: string[], timeoutMs = 0): Promise<ExecResult> {
  return exec(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', ...args], timeoutMs);
}
