/**
 * 全局限速（3.1）。
 *
 * 为什么用「按已写字节反推目标耗时」而不是令牌桶/漏桶：
 * 下载器是单流顺序落盘，只需要**平均速率**不超限，不需要突发控制。
 * 目标耗时 = 已写字节 / 速率；实际耗时比它短就睡差值。这样：
 * - 速率恒定，不依赖每块的到达节奏（CDN 分块大小差异很大）；
 * - 续传时只要从 0 开始计数，就不会因为「历史已写字节」被误判成超速。
 *
 * 已知边界（不假装更精确）：
 * - 限速作用于**单条流**。B站 是视频+音频两条流分别限速，音轨占比小，
 *   整体速率会略高于设定值（实测 480P 音轨约 5%）；
 * - `--limit` 不约束 yt-dlp 通用引擎（那是它自己的 `--limit-rate`，不在本模块管辖）；
 * - 每个块写完才 sleep，所以单块很大时进度会呈现「跳一格停一下」。
 */

let limitBytesPerSec = 0;

/** 0 / 负数 / NaN 都表示「不限速」，与关闭开关等价。 */
export function setLimitBytesPerSec(n: number) {
  limitBytesPerSec = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function currentLimitBytesPerSec(): number {
  return limitBytesPerSec;
}

const UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };

/**
 * 解析人写的速率：`2M` / `1.5m` / `300K` / `1048576`（纯数字按 B/s）。
 * 也容忍 `2MB`、`2M/s` 这类写法。非法输入返回 null，由调用方决定报错还是忽略——
 * 这里不猜，猜错会变成「以为限了速其实没有」。
 */
export function parseLimit(text: string): number | null {
  const raw = (text || '').trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)(?:b)?(?:\/s)?$/.exec(raw);
  if (!m) return null;
  const value = Number(m[1]) * UNITS[m[2]];
  if (!Number.isFinite(value)) return null;
  return Math.round(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 每写完一块调用一次。
 * @param written 自 `startedAt` 起已写字节数（续传时只算本次新增，不含断点前的部分）
 * @param startedAt 本次流开始的时间戳（ms）
 */
export async function throttle(written: number, startedAt: number): Promise<void> {
  if (!limitBytesPerSec) return;
  const targetMs = (Math.max(0, written) / limitBytesPerSec) * 1000;
  const wait = targetMs - (Date.now() - startedAt);
  if (wait > 0) await sleep(Math.ceil(wait));
}
