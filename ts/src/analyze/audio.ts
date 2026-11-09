/**
 * 声音的**客观量**：响度包络、整片 LUFS、静音段、每镜平均响度。
 *
 * 为什么只做这些：H3 提示词要写 `overall_soundscape` / `non_diegetic_music`，
 * 但「这是对白还是音乐」光看音量判不出来——那需要频谱/ASR，会引入模型依赖。
 * 所以这里只给**测出来的数字**，措辞留给写提示词的人；宁可少一个结论，
 * 也不要拿 -18 LUFS 去编「热闹的电子舞曲」。
 *
 * 数据来源：ffmpeg `ebur128` 滤镜。它每 100ms 打一行 `t/M/S/I`（M=瞬时响度、
 * S=短时、I=积分），信息量大且不需要额外依赖。
 */
import { VdlError } from '../core/errors';
import { ffmpegBin } from '../core/ffmpeg';
import { exec } from './proc';

export interface AudioPoint {
  t_ms: number;
  /** 瞬时响度（LUFS）。数字静音约 -70，不是 -∞ */
  momentary: number;
  /** 短时响度（3s 窗） */
  short: number;
}

export interface Silence {
  start_ms: number;
  end_ms: number;
}

export interface SceneAudio {
  index: number;
  /** 该镜内所有瞬时响度的平均（LUFS） */
  meanLufs: number;
  /** 该镜内静音占比 0–1 */
  silentRatio: number;
}

export interface AudioSummary {
  hasTrack: boolean;
  /** 整片积分响度（LUFS）；没有音轨为 null */
  integratedLufs: number | null;
  loudnessRange: number | null;
  truePeakDb: number | null;
  /** 下采样后的包络（≤ 600 点） */
  points: AudioPoint[];
  silences: Silence[];
  /** 全片静音时长占比 */
  silentRatio: number;
  sceneLevels: SceneAudio[];
  /** 判静音的阈值（LUFS），写进结果方便复现 */
  silenceThreshold: number;
}

const EMPTY: AudioSummary = {
  hasTrack: false, integratedLufs: null, loudnessRange: null, truePeakDb: null,
  points: [], silences: [], silentRatio: 0, sceneLevels: [], silenceThreshold: -50,
};

/**
 * 解析 ebur128 的日志。
 *
 * 一行长这样（数值可能带负号与小数）：
 *   `[Parsed_ebur128_0 @ …] t: 0.199977  TARGET:-23 LUFS  M:-120.7 S:-120.7  I: -70.0 LUFS  LRA: 0.0 LU …`
 * 末尾还有一段汇总（`I: -18.2 LUFS` / `LRA: 3.3 LU` / `Peak: -6.2 dBFS`）。
 */
export function parseEbur128(log: string): {
  points: AudioPoint[]; integratedLufs: number | null; loudnessRange: number | null; truePeakDb: number | null;
} {
  const points: AudioPoint[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = /\]\s*t:\s*([\d.]+)\s+.*?\bM:\s*(-?[\d.]+)\s+S:\s*(-?[\d.]+)/.exec(line);
    if (!m) continue;
    points.push({
      t_ms: Math.round(Number(m[1]) * 1000),
      momentary: Number(m[2]),
      short: Number(m[3]),
    });
  }
  // 汇总只在最后出现一次，但要先剔掉逐帧行：那些行同样带 `I:` 与 `LRA:`，
  // 不剔就会拿到「最后 100ms 的积分值」而不是整片积分（实测踩到：-25 vs -18.2）。
  const summary = log.split(/\r?\n/).filter((line) => !line.includes('TARGET:')).join('\n');
  const last = (re: RegExp): number | null => {
    let value: number | null = null;
    for (const line of summary.split(/\r?\n/)) {
      const hit = re.exec(line);
      if (hit) value = Number(hit[1]);
    }
    return value;
  };
  return {
    points,
    integratedLufs: last(/\bI:\s*(-?[\d.]+)\s*LUFS/g),
    loudnessRange: last(/\bLRA:\s*(-?[\d.]+)\s*LU/g),
    truePeakDb: last(/\bPeak:\s*(-?[\d.]+)\s*dBFS/g),
  };
}

/**
 * 静音段：瞬时响度低于阈值且持续够久。
 *
 * 阈值默认 -50 LUFS：数字静音是 -70，安静的房间底噪在 -50 上下；
 * 低于它才敢说「这里基本没有声音」。短于 300ms 的不算（那是换气/停顿，不是空镜）。
 */
export function findSilences(
  points: AudioPoint[], threshold = -50, minMs = 300,
): { silences: Silence[]; ratio: number } {
  if (!points.length) return { silences: [], ratio: 0 };
  const silences: Silence[] = [];
  let start: number | null = null;
  for (const point of points) {
    const quiet = point.momentary <= threshold;
    if (quiet && start === null) start = point.t_ms;
    if (!quiet && start !== null) {
      if (point.t_ms - start >= minMs) silences.push({ start_ms: start, end_ms: point.t_ms });
      start = null;
    }
  }
  if (start !== null) {
    const end = points[points.length - 1].t_ms;
    if (end - start >= minMs) silences.push({ start_ms: start, end_ms: end });
  }
  const totalQuiet = silences.reduce((sum, s) => sum + (s.end_ms - s.start_ms), 0);
  const span = points[points.length - 1].t_ms - points[0].t_ms;
  return { silences, ratio: span > 0 ? Math.round((totalQuiet / span) * 1000) / 1000 : 0 };
}

/** 每镜平均响度：只统计落在镜头区间内的采样点；一个点都没有就报 -70（数字静音）。 */
export function sceneLevels(
  points: AudioPoint[],
  scenes: Array<{ index: number; start_ms: number; end_ms: number }>,
  threshold = -50,
): SceneAudio[] {
  return scenes.map((scene) => {
    const inside = points.filter((p) => p.t_ms >= scene.start_ms && p.t_ms < scene.end_ms);
    if (!inside.length) return { index: scene.index, meanLufs: -70, silentRatio: 1 };
    const mean = inside.reduce((sum, p) => sum + p.momentary, 0) / inside.length;
    const quiet = inside.filter((p) => p.momentary <= threshold).length;
    return {
      index: scene.index,
      meanLufs: Math.round(mean * 10) / 10,
      silentRatio: Math.round((quiet / inside.length) * 1000) / 1000,
    };
  });
}

/** 包络下采样到 ≤ max 点：给界面/JSON 用，原精度对写提示词没有意义。 */
export function downsample(points: AudioPoint[], max = 600): AudioPoint[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out: AudioPoint[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  return out;
}

/**
 * 跑一遍 ebur128 取声音数据。
 *
 * 注意 loglevel 必须是 info：ebur128 的逐帧数值只打在 info 日志里，
 * 用我们惯常的 `-loglevel error` 会一行都拿不到（这个坑很隐蔽）。
 * 无音轨（纯视频）时返回 `hasTrack: false`，不是错误。
 */
export async function analyzeAudio(
  file: string,
  scenes: Array<{ index: number; start_ms: number; end_ms: number }>,
  opts: { silenceThreshold?: number; timeoutMs?: number } = {},
): Promise<AudioSummary> {
  const threshold = opts.silenceThreshold ?? -50;
  const res = await exec(ffmpegBin(), [
    '-hide_banner', '-nostdin', '-loglevel', 'info',
    '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], opts.timeoutMs ?? 10 * 60_000);
  if (res.code === -2) throw new VdlError('ffmpeg_missing', '找不到 ffmpeg，无法分析声音');
  const log = `${res.stderr}\n`;
  if (res.code !== 0) {
    // 没有音轨时 ffmpeg 会报 "Output file does not contain any stream"
    if (/does not contain any stream|matches no streams/i.test(log)) {
      return { ...EMPTY, silenceThreshold: threshold };
    }
    throw new VdlError('audio_failed', `ebur128 分析失败 code=${res.code}：${log.slice(-300)}`);
  }

  const parsed = parseEbur128(log);
  if (!parsed.points.length) return { ...EMPTY, silenceThreshold: threshold };
  const quiet = findSilences(parsed.points, threshold);
  return {
    hasTrack: true,
    integratedLufs: parsed.integratedLufs,
    loudnessRange: parsed.loudnessRange,
    truePeakDb: parsed.truePeakDb,
    points: downsample(parsed.points),
    silences: quiet.silences,
    silentRatio: quiet.ratio,
    sceneLevels: sceneLevels(parsed.points, scenes, threshold),
    silenceThreshold: threshold,
  };
}
