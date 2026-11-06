/**
 * 抽帧预算与选点。
 *
 * 借鉴 claude-video 的两条经验（`docs/style-transfer-plan.md` §9）：
 * - 短视频给足帧（<30s → 30 帧），长视频封顶（>10min → 100 帧），
 *   否则一个 40 分钟的直播回放会抽出上千张图，既慢又没人看；
 * - **每个镜头至少一帧**，而不是均匀切时间轴——均匀切会把长镜头抽成多张、
 *   把快剪段整段漏掉。
 *
 * 取不到画面时 `luma` 留 null：宁可少一个数字，也不填一个猜的亮度。
 */
import type { Scene } from './scenes';

export const SHORT_VIDEO_MS = 30_000;
export const LONG_VIDEO_MS = 600_000;
export const SHORT_FRAMES = 30;
export const LONG_FRAMES = 100;

/** 帧预算：30s 以内 30 帧，10min 以上 100 帧，中间线性过渡（30→100）。 */
export function frameBudget(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return SHORT_FRAMES;
  if (durationMs <= SHORT_VIDEO_MS) return SHORT_FRAMES;
  if (durationMs >= LONG_VIDEO_MS) return LONG_FRAMES;
  const k = (durationMs - SHORT_VIDEO_MS) / (LONG_VIDEO_MS - SHORT_VIDEO_MS);
  return Math.round(SHORT_FRAMES + k * (LONG_FRAMES - SHORT_FRAMES));
}

export interface FramePick {
  /** 采样时刻（毫秒）——取镜头中点，避开转场黑帧 */
  t_ms: number;
  scene: number;
}

/**
 * 每个镜头一个中点采样；镜头数超过预算时**均匀抽稀**（保留首尾）。
 * 抽稀用 index 映射而不是「取前 N 个」，否则 100 个镜头只分析开头 30 个。
 */
export function planFrames(scenes: Scene[], durationMs: number, maxFrames?: number): FramePick[] {
  if (!scenes.length) {
    // 一镜到底或检测不到切点时，均匀撒预算帧（至少 1 帧）
    const budget = Math.max(1, maxFrames ?? frameBudget(durationMs));
    const step = durationMs / budget;
    return Array.from({ length: budget }, (_, i) => ({
      t_ms: Math.round(step * i + step / 2),
      scene: 1,
    }));
  }

  const picks = scenes.map((s) => ({
    t_ms: Math.round((s.start_ms + s.end_ms) / 2),
    scene: s.index,
  }));
  const budget = Math.max(1, maxFrames ?? frameBudget(durationMs));
  if (picks.length <= budget) return picks;
  if (budget === 1) return [picks[0]];

  const out: FramePick[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < budget; i += 1) {
    const at = Math.round((i * (picks.length - 1)) / (budget - 1));
    const one = picks[at];
    if (seen.has(one.scene)) continue;
    seen.add(one.scene);
    out.push(one);
  }
  return out;
}

/**
 * 16×16 灰度帧的平均亮度（0-255）。
 *
 * 为什么在抽帧时顺带取：一次 ffmpeg 调用同时出 JPEG（给人看/后续 VLM）
 * 和 16×16 灰度（算客观指标），比再跑一遍解码省一个数量级的 IO。
 */
export function lumaOfGray(bytes: Buffer): number | null {
  if (!bytes.length) return null;
  let sum = 0;
  for (const b of bytes) sum += b;
  return Math.round((sum / bytes.length) * 10) / 10;
}
