/**
 * A3：把一次分析的结果归纳成「风格卡」。
 *
 * 边界（写在前面的原因）：
 * - 卡里的**数字**都来自实测（分镜时长、亮度、响度、各类分布），可以直接引用；
 * - 卡里的**词**只是对视觉描述做词频统计，不是识别结论——「红黑主色调」出现 9 次
 *   不等于模型认定了主色调，只说明 9 个镜头的描述里都这么写；
 * - **不产出成品 H3 提示词**：那要按 4–15s 拼接、还要写 soundscape 措辞，
 *   而且没有 H3 通道就无法验证，属于 A4/A5（仍冻结）。
 *
 * 一句话：这张卡是给写提示词的人（或 Agent）看的原料清单，不是自动生成器。
 */
import { basename } from 'node:path';
import type { AnalysisResult } from './index';

export interface StyleCard {
  schema: 1;
  source: string;
  duration_ms: number;
  pacing: {
    shots: number;
    mean_ms: number;
    median_ms: number;
    min_ms: number;
    max_ms: number;
    cuts_per_minute: number;
  };
  shotSizes: Array<[string, number]>;
  cameras: Array<[string, number]>;
  luma: { mean: number | null; min: number | null; max: number | null; dark: number; bright: number };
  sound: {
    has_track: boolean;
    integrated_lufs: number | null;
    loudness_range: number | null;
    silent_ratio: number;
  };
  /** 描述里的高频词（**词频统计**，不是识别） */
  keywords: { setting: Array<[string, number]>; lighting: Array<[string, number]> };
  coverage: { scenes: number; with_visual: number; with_camera: number; with_audio: number };
  limits: string[];
}

const round = (n: number, digits = 1): number => Math.round(n * 10 ** digits) / 10 ** digits;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** 把一段中文描述切成词组计数。标点与连接词都当分隔符，过短的丢掉。 */
export function keyPhrases(text: string | undefined, limit = 5): Array<[string, number]> {
  if (!text) return [];
  const counts = new Map<string, number>();
  for (const raw of String(text).split(/[、，,；;·\s/｜|（）()]+/)) {
    const token = raw.trim();
    if (token.length < 2) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function tally(values: Array<string | undefined>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const token = (value || '').trim();
    if (!token) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * 运镜归到「主类」再统计。
 *
 * 逐镜写的是「移（横移）」「拉（大幅拉远）」这类带限定的值——对写提示词有用，
 * 但直接做分布会把「拉」「拉（轻微）」「拉（大幅拉远）」算成三类，看不出节奏。
 * 括号里的限定词只在分镜行里保留，卡里按主类汇总。
 */
export function cameraFamily(value: string | undefined): string {
  const text = (value || '').trim();
  if (!text) return '';
  return text.replace(/[（(].*$/, '').trim() || text;
}

/**
 * 亮度阈值是**判读口径**，不是标准：<40 记暗、>110 记亮（取 16×16 灰度均值的量纲，
 * 与 `lumaOfGray` 一致）。写进卡里是为了让别人能复算，不是因为 40/110 有理论意义。
 */
export const DARK_LUMA = 40;
export const BRIGHT_LUMA = 110;

export function buildStyleCard(result: AnalysisResult): StyleCard {
  const scenes = result.scenes || [];
  const durations = scenes.map((s) => s.duration_ms).filter((n) => Number.isFinite(n) && n > 0);
  const lumas = scenes.map((s) => s.luma).filter((n): n is number => typeof n === 'number');
  const visuals = scenes.map((s) => s.visual).filter(Boolean);
  const durationMin = (result.metrics?.duration_ms || 0) / 60000;

  return {
    schema: 1,
    source: basename(result.source?.path || ''),
    duration_ms: result.metrics?.duration_ms || 0,
    pacing: {
      shots: scenes.length,
      mean_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      median_ms: median(durations),
      min_ms: durations.length ? Math.min(...durations) : 0,
      max_ms: durations.length ? Math.max(...durations) : 0,
      cuts_per_minute: durationMin > 0 ? round(scenes.length / durationMin) : 0,
    },
    shotSizes: tally(visuals.map((v) => v!.shotSize)),
    // 主类汇总（详见 cameraFamily）；逐镜的限定词仍在 scenes[].visual.camera 里
    cameras: tally(visuals.map((v) => cameraFamily(v!.camera))),
    luma: {
      mean: lumas.length ? round(lumas.reduce((a, b) => a + b, 0) / lumas.length) : null,
      min: lumas.length ? round(Math.min(...lumas)) : null,
      max: lumas.length ? round(Math.max(...lumas)) : null,
      dark: lumas.filter((n) => n < DARK_LUMA).length,
      bright: lumas.filter((n) => n > BRIGHT_LUMA).length,
    },
    sound: {
      has_track: !!result.audio?.hasTrack,
      integrated_lufs: result.audio?.integratedLufs ?? null,
      loudness_range: result.audio?.loudnessRange ?? null,
      silent_ratio: result.audio?.silentRatio ?? 0,
    },
    keywords: {
      setting: keyPhrases(visuals.map((v) => v!.setting).join('、')),
      lighting: keyPhrases(visuals.map((v) => v!.lighting).join('、')),
    },
    coverage: {
      scenes: scenes.length,
      with_visual: visuals.length,
      with_camera: visuals.filter((v) => v!.camera).length,
      with_audio: scenes.filter((s) => typeof s.db === 'number').length,
    },
    limits: [
      '数字来自实测（分镜/亮度/响度）；词只来自视觉描述的词频，不是识别结论',
      '不含 H3 三字段成品提示词：4–15s 拼接与 soundscape 措辞需要人写，且没有 H3 通道无法验证（A4/A5 冻结）',
      '「对白还是音乐」未判定：需要频谱分析或 ASR',
    ],
  };
}

const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

/** 人读的 Markdown；与 JSON 同源，不额外加工。 */
export function renderStyleCardMarkdown(card: StyleCard): string {
  const lines: string[] = [];
  lines.push(`# 风格卡 · ${card.source}`);
  lines.push('');
  lines.push(`片长 ${(card.duration_ms / 1000).toFixed(1)}s · ${card.pacing.shots} 镜 · `
    + `每分钟 ${card.pacing.cuts_per_minute} 次切`);
  lines.push('');
  lines.push('## 节奏');
  lines.push('');
  lines.push('| 平均镜长 | 中位 | 最短 | 最长 |');
  lines.push('|---|---|---|---|');
  lines.push(`| ${(card.pacing.mean_ms / 1000).toFixed(2)}s | ${(card.pacing.median_ms / 1000).toFixed(2)}s | `
    + `${(card.pacing.min_ms / 1000).toFixed(2)}s | ${(card.pacing.max_ms / 1000).toFixed(2)}s |`);
  lines.push('');
  lines.push('## 景别分布（来自视觉描述）');
  lines.push('');
  lines.push(card.shotSizes.length
    ? card.shotSizes.map(([name, n]) => `- ${name}：${n}（${pct(n, card.coverage.with_visual)}）`).join('\n')
    : '- 没有视觉描述，无法统计');
  lines.push('');
  lines.push('## 运镜分布（来自首尾帧判读）');
  lines.push('');
  lines.push(card.cameras.length
    ? card.cameras.map(([name, n]) => `- ${name}：${n}`).join('\n')
    : '- 没有运镜判读（需要 `--pair-frames` + 描述文件）');
  lines.push('');
  lines.push('## 亮度（16×16 灰度均值）');
  lines.push('');
  if (card.luma.mean === null) {
    lines.push('- 没有可用亮度数据');
  } else {
    lines.push(`- 平均 ${card.luma.mean}，最低 ${card.luma.min}，最高 ${card.luma.max}`);
    lines.push(`- 偏暗（<${DARK_LUMA}）${card.luma.dark} 镜，偏亮（>${BRIGHT_LUMA}）${card.luma.bright} 镜`);
  }
  lines.push('');
  lines.push('## 声音（实测）');
  lines.push('');
  lines.push(card.sound.has_track
    ? `- 积分响度 ${card.sound.integrated_lufs ?? '—'} LUFS，响度范围 ${card.sound.loudness_range ?? '—'} LU，`
      + `静音占比 ${(card.sound.silent_ratio * 100).toFixed(1)}%`
    : '- 无音轨');
  lines.push('');
  lines.push('## 高频描述词（词频统计，不是识别结论）');
  lines.push('');
  lines.push(`- 场景：${card.keywords.setting.map(([w, n]) => `${w}(${n})`).join('、') || '—'}`);
  lines.push(`- 光线：${card.keywords.lighting.map(([w, n]) => `${w}(${n})`).join('、') || '—'}`);
  lines.push('');
  lines.push('## 覆盖度');
  lines.push('');
  lines.push(`- ${card.coverage.with_visual}/${card.coverage.scenes} 镜有视觉描述，`
    + `${card.coverage.with_camera} 镜有运镜，${card.coverage.with_audio} 镜有响度`);
  lines.push('');
  lines.push('## 这张卡不含什么');
  lines.push('');
  for (const limit of card.limits) lines.push(`- ${limit}`);
  lines.push('');
  return lines.join('\n');
}
