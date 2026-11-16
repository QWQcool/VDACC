/**
 * 测试用的环境能力探测（**不是测试文件**，`*.test.ts` 才会被 bun 收集）。
 *
 * 起因（2026-11-16 复原后实测）：没有安装 ffmpeg 时，`bun test` 会显示
 * `308 pass / 2 skip`，但两条 skip 只是安静地跳过，根本看不出「这台机器缺 ffmpeg」——
 * 更糟的是另外两处探测写法不一致：`analyze.test.ts` 用 `ffmpegBin()`（认 `VDL_FFMPEG`），
 * `server.test.ts` 用 `Bun.which('ffmpeg')`（只认 PATH）。同一个环境里一条跑了、一条跳过。
 *
 * 所以：能力探测集中在这里，查找规则与引擎完全一致；再用 `capabilities.test.ts`
 * 把结果**打印在测试输出里**，缺什么一眼能看到，而不是从 skip 数去猜。
 */
import { ffmpegBin } from '../src/core/ffmpeg';

/** 与引擎同一条查找规则（`VDL_FFMPEG` 优先，其次 PATH）。 */
export const FFMPEG_PATH = Bun.which(ffmpegBin());
export const HAS_FFMPEG = Boolean(FFMPEG_PATH);

/** ffmpeg 版本号（`9.0.2-essentials_build-...`）；拿不到就空串，绝不抛。 */
export function ffmpegVersion(): string {
  if (!FFMPEG_PATH) return '';
  try {
    const run = Bun.spawnSync([FFMPEG_PATH, '-version'], { stdout: 'pipe', stderr: 'pipe' });
    const text = new TextDecoder().decode(run.stdout);
    return /ffmpeg version (\S+)/i.exec(text)?.[1] || '';
  } catch {
    return '';
  }
}

/** 依赖 ffmpeg 的用例把这句话拼进用例名，跳过时也能在输出里读到「为什么」。 */
export const FFMPEG_MISSING = '本机没有 ffmpeg（scripts/setup.ps1 可安装，或用 VDL_FFMPEG 指定）';
