/**
 * 分镜切分：把 `scdet` 吐出的「切点时间」拼成段。
 *
 * 为什么不用「抽固定间隔帧再比相似度」：那是自己实现场景检测，误差不可控；
 * ffmpeg 的 scdet 是现成的、确定性的，且能和后面抽帧共用同一个 ffmpeg。
 *
 * 纯函数部分（解析/拼段/合并碎段）留在这里，单测不需要 ffmpeg。
 */

export interface SceneCut {
  t_ms: number;
  /** scdet 的分数（0-100），只用于排查阈值是否合适，不进最终契约 */
  score: number;
}

export interface Scene {
  index: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  /** 该镜中点采样帧的平均亮度（0-255），取不到时为 null —— 不编造 */
  luma: number | null;
}

/**
 * 解析 `metadata=print:file=-` 的输出：
 *   `... lavfi.scd.score=12.3 lavfi.scd.time=1.234`
 * 两行顺序在实测中稳定（先 score 后 time），但这里不依赖顺序：
 * score 先记下，遇到 time 就配对，然后清空。
 */
export function parseScdet(output: string): SceneCut[] {
  const cuts: SceneCut[] = [];
  let score = Number.NaN;
  for (const line of output.split(/\r?\n/)) {
    const s = /lavfi\.scd\.score=([\d.]+)/.exec(line);
    if (s) score = Number(s[1]);
    const t = /lavfi\.scd\.time=([\d.]+)/.exec(line);
    if (!t) continue;
    cuts.push({ t_ms: Math.round(Number(t[1]) * 1000), score: Number.isFinite(score) ? score : 0 });
    score = Number.NaN;
  }
  return cuts;
}

/** 碎段下限：比这更短的段多半是闪白/转场误切，并进上一段而不是当成一个镜头。 */
export const MIN_SCENE_MS = 300;

/**
 * 切点 → 段。
 *
 * 三个必须处理的脏数据：
 * 1. 切点在 0 或超出片长（scdet 会报 0 点）→ 丢掉；
 * 2. 相邻切点重复（同一帧报多次）→ 去重；
 * 3. 段太短 → 并入上一段，否则「一个镜头被切成 5 段」，第 2 条断言就没法过。
 */
export function buildScenes(durationMs: number, cuts: SceneCut[], minMs = MIN_SCENE_MS): Scene[] {
  const duration = Math.max(0, Math.round(durationMs));
  const marks = [...new Set(
    cuts.map((c) => Math.round(c.t_ms))
      .filter((t) => t > 0 && t < duration)
      .sort((a, b) => a - b),
  )];

  const raw: Array<[number, number]> = [];
  let start = 0;
  for (const at of marks) {
    raw.push([start, at]);
    start = at;
  }
  raw.push([start, duration]);

  // 合并碎段：把 [s,e] 里 e-s < minMs 的并入前一段；第一段太短就与后一段合并
  const merged: Array<[number, number]> = [];
  for (const [s, e] of raw) {
    const prev = merged[merged.length - 1];
    if (prev && (e - s < minMs || prev[1] - prev[0] < minMs)) {
      prev[1] = e;
      continue;
    }
    merged.push([s, e]);
  }

  return merged.map(([s, e], i) => ({
    index: i + 1,
    start_ms: s,
    end_ms: e,
    duration_ms: e - s,
    luma: null,
  }));
}
