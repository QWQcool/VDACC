/**
 * 粗剪清单（A1 的「可执行产物」）。
 *
 * 分镜表回答「这段有哪几个镜头」，但剪片子的人要的是「从哪切、哪段可以删」。
 * 这里把已经量出来的东西（分镜边界、静音段）翻成两份能被工具直接吃掉的产物：
 *
 *   cutlist.csv  切点与删除段，带时间码、理由、动作（人看 / Excel / 脚本都行）
 *   cutlist.edl  CMX3600 EDL：**保留段**按源顺序排成一条时间线，Premiere / 达芬奇可直接导入
 *
 * 刻意的保守：**只删长静音**。黑场、口头语、闪白这些需要模型或语谱判断，
 * 猜错了会删掉正片内容；静音是唯一可以只靠客观量就下结论的。
 *
 * 时间码按 NDF（非丢帧）四舍五入到整帧；fps 取整用（29.97 → 30），
 * 并在返回值的 warnings 里写明——EDL 的丢帧时间码会把整条时间线算歪，宁可用 30 近似。
 */
import type { AnalysisResult } from './index';

export interface CutlistOptions {
  /** 默认取分析结果的 fps；取不到用 25 */
  fps?: number;
  /** 短于这个长度的静音不删（默认 1000ms） */
  minSilenceMs?: number;
  /** 删静音时两端各留一点，避免切在字头字尾（默认 120ms） */
  padMs?: number;
  /** 短于这个长度的保留段并进相邻（默认 200ms，避免切出一堆碎片） */
  minKeepMs?: number;
}

export interface CutPoint {
  at_ms: number;
  kind: 'scene' | 'silence-in' | 'silence-out';
  scene: number | null;
  reason: string;
}

export interface DropRange {
  start_ms: number;
  end_ms: number;
  reason: string;
}

export interface Cutlist {
  fps: number;
  total_ms: number;
  cuts: CutPoint[];
  drops: DropRange[];
  keeps: Array<{ start_ms: number; end_ms: number }>;
  dropped_ms: number;
  warnings: string[];
}

/** 毫秒 → `hh:mm:ss:ff`（NDF）。负数与 NaN 一律归零，别让一条脏数据毁掉整份 EDL。 */
export function timecode(ms: number, fps: number): string {
  const safeFps = Math.max(1, Math.round(fps || 25));
  const total = Math.max(0, Math.round((Number(ms) || 0) * safeFps / 1000));
  const frames = total % safeFps;
  const secs = Math.floor(total / safeFps);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}:${pad(frames)}`;
}

const dur = (a: { start_ms: number; end_ms: number }) => Math.max(0, a.end_ms - a.start_ms);

/** 合并重叠/相接的区间（输入按 start 排序）。 */
function mergeRanges(ranges: Array<{ start_ms: number; end_ms: number }>) {
  const out: Array<{ start_ms: number; end_ms: number }> = [];
  for (const r of ranges.slice().sort((a, b) => a.start_ms - b.start_ms)) {
    const last = out[out.length - 1];
    if (last && r.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, r.end_ms);
    else out.push({ ...r });
  }
  return out;
}

export function buildCutlist(
  result: Pick<AnalysisResult, 'metrics' | 'scenes' | 'audio'>,
  opts: CutlistOptions = {},
): Cutlist {
  const warnings: string[] = [];
  const fps = Math.max(1, Math.round(opts.fps || result.metrics?.fps || 25));
  if (opts.fps === undefined && result.metrics?.fps && Math.abs(result.metrics.fps - fps) > 0.01) {
    warnings.push(`源片 ${result.metrics.fps} fps，清单按 ${fps} fps 出时间码（NDF 近似）`);
  }
  const total = Math.max(0, Number(result.metrics?.duration_ms) || 0);
  const minSilence = Math.max(0, opts.minSilenceMs ?? 1000);
  const pad = Math.max(0, opts.padMs ?? 120);
  const minKeep = Math.max(0, opts.minKeepMs ?? 200);

  // 1) 候选删除段：只认「够长的静音」，两端各让 pad 出来
  const rawDrops: DropRange[] = [];
  const silences = Array.isArray(result.audio?.silences) ? result.audio!.silences : [];
  if (!result.audio?.hasTrack) {
    warnings.push('没有音轨：只能给出镜头切点，不删任何片段');
  }
  for (const s of silences) {
    const start = Math.max(0, s.start_ms + pad);
    const end = Math.min(total, s.end_ms - pad);
    if (end - start < minSilence) continue;
    rawDrops.push({ start_ms: start, end_ms: end, reason: `静音 ${(dur(s) / 1000).toFixed(1)}s` });
  }

  // 2) 合并重叠，再把过短的「保留缝」也吃掉（否则 EDL 里会是一堆 <200ms 的碎片）
  let merged = mergeRanges(rawDrops).map((r) => ({
    ...r,
    reason: rawDrops.find((d) => d.start_ms === r.start_ms)?.reason || '静音',
  }));
  for (let i = 1; i < merged.length; i += 1) {
    const gap = merged[i].start_ms - merged[i - 1].end_ms;
    if (gap > 0 && gap < minKeep) {
      merged[i - 1] = {
        start_ms: merged[i - 1].start_ms,
        end_ms: merged[i].end_ms,
        reason: `${merged[i - 1].reason} + 过短缝`,
      };
      merged.splice(i, 1);
      i -= 1;
    }
  }
  merged = merged.filter((d) => dur(d) > 0);

  // 3) 保留段 = 全片的补集
  const keeps: Array<{ start_ms: number; end_ms: number }> = [];
  let cursor = 0;
  for (const d of merged) {
    if (d.start_ms > cursor) keeps.push({ start_ms: cursor, end_ms: d.start_ms });
    cursor = Math.max(cursor, d.end_ms);
  }
  if (cursor < total) keeps.push({ start_ms: cursor, end_ms: total });

  // 4) 切点：镜头边界 + 每个删除段的两端
  const cuts: CutPoint[] = [];
  for (const scene of result.scenes || []) {
    if (scene.start_ms <= 0) continue;
    cuts.push({
      at_ms: scene.start_ms,
      kind: 'scene',
      scene: scene.index,
      reason: `镜头 ${scene.index} 开始`,
    });
  }
  for (const d of merged) {
    cuts.push({ at_ms: d.start_ms, kind: 'silence-in', scene: null, reason: `进入${d.reason}` });
    cuts.push({ at_ms: d.end_ms, kind: 'silence-out', scene: null, reason: `离开${d.reason}` });
  }
  cuts.sort((a, b) => a.at_ms - b.at_ms);

  const dropped = merged.reduce((sum, d) => sum + dur(d), 0);
  return {
    fps,
    total_ms: total,
    cuts,
    drops: merged,
    keeps,
    dropped_ms: dropped,
    warnings,
  };
}

const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** 切点与删除段混在一张表：`type` 列区分，`action` 列直接告诉脚本该干嘛。 */
export function renderCutlistCsv(list: Cutlist): string {
  const rows = ['type,action,start_tc,end_tc,start_ms,end_ms,scene,reason'];
  for (const c of list.cuts) {
    rows.push([
      c.kind, 'cut', timecode(c.at_ms, list.fps), timecode(c.at_ms, list.fps),
      String(Math.round(c.at_ms)), String(Math.round(c.at_ms)),
      c.scene === null ? '' : String(c.scene), csvCell(c.reason),
    ].join(','));
  }
  for (const d of list.drops) {
    rows.push([
      'silence', 'drop', timecode(d.start_ms, list.fps), timecode(d.end_ms, list.fps),
      String(Math.round(d.start_ms)), String(Math.round(d.end_ms)), '', csvCell(d.reason),
    ].join(','));
  }
  return `${rows.join('\n')}\n`;
}

/**
 * CMX3600 EDL：每条事件 = 一段保留内容（源时间码 → 记录时间码连续）。
 * `AX` 是「辅助源」的标准 reel 名，剪辑软件认它。
 */
export function renderCutlistEdl(list: Cutlist, title = 'VDACC cut'): string {
  const safeTitle = String(title || 'VDACC cut').replace(/[\r\n]+/g, ' ').slice(0, 60);
  const lines = [`TITLE: ${safeTitle}`, 'FCM: NON-DROP FRAME', ''];
  let record = 0;
  list.keeps.forEach((keep, i) => {
    const len = Math.max(0, keep.end_ms - keep.start_ms);
    if (!len) return;
    const event = String(i + 1).padStart(3, '0');
    lines.push(
      `${event}  AX       V     C        `
      + `${timecode(keep.start_ms, list.fps)} ${timecode(keep.end_ms, list.fps)} `
      + `${timecode(record, list.fps)} ${timecode(record + len, list.fps)}`,
    );
    record += len;
  });
  lines.push('');
  return `${lines.join('\n')}\n`;
}
