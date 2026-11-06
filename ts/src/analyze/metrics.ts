/**
 * 客观指标：**只报 ffprobe 直接算出来的东西**。
 *
 * 为什么不做「估算码率」「估算清晰度」：这些数字一猜就会和实际文件对不上，
 * 而用户拿它做决策（要不要重下、够不够切）。fps 这类分数值（30000/1001）
 * 要真的除出来，不能截成 30 就当 29.97 不存在。
 */

export interface VideoMetrics {
  duration_ms: number;
  bytes: number;
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  acodec: string;
  /** 总码率（bit/s）：ffprobe 有时不给，那就留 null */
  bitrate: number | null;
}

function parseRate(text: string): number {
  const raw = String(text || '').trim();
  if (!raw || raw === '0/0') return 0;
  const [a, b] = raw.split('/');
  const num = Number(a);
  const den = b === undefined ? 1 : Number(b);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return Math.round((num / den) * 1000) / 1000;
}

/** ffprobe `-print_format json` 的结果 → 分析用的指标；结构不对返回 null（不猜）。 */
export function summarizeFfprobe(json: any): VideoMetrics | null {
  const format = json?.format;
  const streams: any[] = Array.isArray(json?.streams) ? json.streams : [];
  const video = streams.find((s) => s?.codec_type === 'video');
  if (!format || !video) return null;

  const durationMs = Math.round(Number(format.duration || video.duration || 0) * 1000);
  const bitrate = Number(format.bit_rate || 0);
  return {
    duration_ms: durationMs,
    bytes: Number(format.size || 0),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    fps: parseRate(video.avg_frame_rate || video.r_frame_rate),
    vcodec: String(video.codec_name || ''),
    acodec: String(streams.find((s) => s?.codec_type === 'audio')?.codec_name || ''),
    bitrate: bitrate > 0 ? bitrate : null,
  };
}
