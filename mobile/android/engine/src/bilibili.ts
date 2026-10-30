/**
 * 端上 B站引擎（M2）。
 *
 * 与桌面端 `ts/src/engines/bilibili_api.ts` 同一条链路（view → playurl → DASH 折叠），
 * 但端上没有 ffmpeg：
 * - **合并**交给桥的 `media.mux`（MediaExtractor/MediaMuxer 纯封装，不解码）；
 * - **超过阈值就拆轨**（150MB，设计稿 §13 决策 5），把视频/音频分别落成
 *   `.video.mp4` 与 `.audio.m4a`，并如实说明「没有合并」；
 * - **字幕/弹幕**是文本，直接走 `writeTextAndPublish`。
 *
 * 三条如实报告的规矩（与桌面端一致）：
 * 1. 显式点名档位就必须命中，不许静默换成别的清晰度；
 * 2. 实际字节 < Range 探测值 95% 报 `incomplete_media`（合并成功只说明封装跑通了）；
 * 3. 合并失败**不回滚已下好的流**，改成拆轨 + 一条明确 warning。
 */
import { UA, request } from '../../../../ts/src/core/http';
import { loggedIn } from './account';
import { VdlError } from '../../../../ts/src/core/errors';
import { safeName } from '../../../../ts/src/core/naming';
import { format, type Format, type Part, type ProbeResult } from '../../../../ts/src/core/types';
import { call } from '../shims/bridge';
import { startTransfer } from '../shims/transfer';
import { writeTextAndPublish } from './staging';

const API = 'https://api.bilibili.com';
const REFERER = 'https://www.bilibili.com/';
/** 按**宽度**归档：宽银幕 1920×816 / 4096×1740 按高度会整体下移一档（桌面端踩过）。 */
const BUCKETS: Array<[number, string]> = [
  [3840, '4K'], [2560, '2K'], [1920, '1080P'], [1280, '720P'], [854, '480P'],
];
/** 超过这个体积不合并，直接拆轨（手机上多写一遍 150MB 的代价比「播放器不支持」小）。 */
export const DEFAULT_MAX_MUX_BYTES = 150 * 1024 * 1024;

export function bucketOf(width: number): [number, string] {
  for (const [limit, label] of BUCKETS) if (width >= limit) return [limit, label];
  return [0, '标清'];
}

export function codecScore(codec: string): number {
  const low = (codec || '').toLowerCase();
  if (low.startsWith('avc')) return 2;
  if (low.startsWith('hev') || low.startsWith('hvc')) return 1;
  return 0;
}

export type DashUrls = { video: string; audio: string };

/**
 * 把 playurl 的 dash 折成「一档一条」的 formats，同时留下地址表。
 *
 * 为什么要按宽度分组取最优：同一档位 B站会给 avc/hevc/av1 多条，
 * 全部列出来会让用户看到「1080P / 1080P / 1080P」。avc 优先是因为兼容性最好
 * （老播放器与系统相册对 hevc 支持不一），与桌面端同一规则。
 */
export function foldDash(
  dash: any,
  durationMs: number,
): { formats: Format[]; urls: Map<string, DashUrls> } {
  const videos: any[] = Array.isArray(dash?.video) ? dash.video : [];
  const audios: any[] = Array.isArray(dash?.audio) ? dash.audio : [];
  const bestAudio = audios.slice()
    .sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0];
  const seconds = (Number(durationMs) || 0) / 1000;

  const groups = new Map<number, any[]>();
  for (const item of videos) {
    const [limit] = bucketOf(Number(item.width || 0));
    if (!groups.has(limit)) groups.set(limit, []);
    groups.get(limit)!.push(item);
  }

  const formats: Format[] = [];
  const urls = new Map<string, DashUrls>();
  for (const limit of [...groups.keys()].sort((a, b) => b - a)) {
    const best = groups.get(limit)!
      .slice()
      .sort((a, b) => codecScore(b.codecs) - codecScore(a.codecs)
        || Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0];
    const id = `bili-${limit || 'sd'}`;
    const totalBw = Number(best.bandwidth || 0) + Number(bestAudio?.bandwidth || 0);
    formats.push(format({
      id,
      // 竖屏/非标档位用「宽×高」：只报高度会让 720×1280 显示成「1280P」
      label: BUCKETS.find(([l]) => l === limit)?.[1] || `${best.width}×${best.height}`,
      width: Number(best.width || 0),
      height: Number(best.height || 0),
      ext: 'mp4',
      vcodec: String(best.codecs || '').split('.')[0],
      acodec: bestAudio ? String(bestAudio.codecs || '').split('.')[0] : '',
      fps: Number(best.frameRate || 0) || 0,
      bytes: Math.round((totalBw * seconds) / 8) || null,
      bitrate: Math.round(totalBw) || null,
    }));
    urls.set(id, {
      video: best.baseUrl || best.base_url || '',
      audio: bestAudio ? (bestAudio.baseUrl || bestAudio.base_url || '') : '',
    });
  }

  // 推荐 1080P：默认勾 4K 会变成 1.4GB/集，用户一次误点就是几十 GB
  const preferred = formats.find((f) => f.width === 1920)
    || formats.find((f) => f.width <= 1920) || formats[0];
  if (preferred) preferred.recommended = true;
  return { formats, urls };
}

export type BilibiliTarget = {
  kind: 'video' | 'ep' | 'ss';
  bvid?: string;
  page: number;
  epId?: string;
  seasonId?: string;
};

export function parseTarget(input: string): BilibiliTarget {
  const raw = (input || '').trim();
  // 允许直接贴 BV 号（桌面端同样接受裸 BV）
  const url = /^BV[0-9A-Za-z]{10}$/.test(raw) ? `https://www.bilibili.com/video/${raw}` : raw;
  const ep = /\/bangumi\/play\/ep(\d+)/.exec(url);
  if (ep) return { kind: 'ep', page: 1, epId: ep[1] };
  const ss = /\/bangumi\/play\/ss(\d+)/.exec(url);
  if (ss) return { kind: 'ss', page: 1, seasonId: ss[1] };
  const bv = /(BV[0-9A-Za-z]{10})/.exec(url);
  if (!bv) {
    throw new VdlError('bad_input', `识别不出 BV 号或番剧 ID：${input}`,
      '手机端还不能跟随 b23.tv 短链，请贴 bilibili.com 的完整链接或 BV 号');
  }
  let page = 1;
  try {
    page = Number(new URL(url).searchParams.get('p') || 1) || 1;
  } catch {
    // 不是标准 URL（裸 BV），用默认 P1
  }
  return { kind: 'video', bvid: bv[1], page };
}

async function apiJson(path: string, referer: string): Promise<any> {
  const name = path.split('?')[0];
  const res = await request(API + path, {
    headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json, text/plain, */*' },
    timeoutMs: 20_000,
  });
  const text = await res.text();
  // 接口层错误 != 下载失败：那时还没开始下载，报「下载失败」会让用户白查
  if (!res.ok) throw new VdlError(`http_${res.status}`, `B站接口 ${name} HTTP ${res.status}`);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new VdlError('api_error', `B站接口 ${name} 返回的不是 JSON（可能被风控）`);
  }
  if (data?.code !== 0) {
    const message = String(data?.message || '').trim();
    const label = `B站接口 ${name} 返回 code=${data?.code}${message ? ` ${message}` : ''}`;
    if (Number(data?.code) === -404) throw new VdlError('not_found', label);
    throw new VdlError('api_error', label, '按平台提示确认稿件/账号/地区状态；这不是下载失败');
  }
  return data.result ?? data.data;
}

/**
 * 清晰度提示必须跟着**登录态**走。
 *
 * 早先端上不能登录，这句话是常量；现在登录了还照说，就会出现「提示说只有匿名档，
 * 而下面的档位明明是 1080P」的自相矛盾——用户只会认为工具在乱报。
 */
async function dashWarnings(dash: any): Promise<string[]> {
  const warnings: string[] = [];
  const audio = Array.isArray(dash?.audio) ? dash.audio : [];
  if (!audio.length) warnings.push('这个视频没有音频轨，产物会是无声视频');
  warnings.push(await loggedIn('bilibili')
    ? '已登录，清晰度以账号实际权益为准（大会员另有 1080P+/4K 档）'
    : '未登录：清晰度以匿名放行为准（4K/1080P 通常需要登录，可在「设置 → 账号」登录）');
  return warnings;
}

export type SubtitleTarget = { bvid?: string; cid?: number; epId?: string };

export type BilibiliProbeInternal = {
  probe: ProbeResult;
  urls: Map<string, DashUrls>;
  sub: SubtitleTarget;
};

/** 内部 probe：下载要用同一份地址表与字幕上下文，所以不拆成两个函数。 */
export async function probeImpl(input: string): Promise<BilibiliProbeInternal> {
  const target = parseTarget(input);
  return target.kind === 'video' ? probeVideo(target) : probeBangumi(target);
}

/** 对外 probe：只返回契约形状，地址表不外泄（下载时内部重新 probe）。 */
export async function probeBilibili(input: string): Promise<ProbeResult> {
  return (await probeImpl(input)).probe;
}

async function probeVideo(target: BilibiliTarget): Promise<BilibiliProbeInternal> {
  const bvid = target.bvid!;
  const view = await apiJson(`/x/web-interface/view?bvid=${bvid}`,
    `https://www.bilibili.com/video/${bvid}`);
  const pages: any[] = view.pages || [];
  const page = Math.min(Math.max(1, target.page), Math.max(1, pages.length));
  const current = pages[page - 1] || { cid: view.cid, part: '' };
  const referer = `https://www.bilibili.com/video/${bvid}?p=${page}`;

  const play = await apiJson(
    `/x/player/playurl?bvid=${bvid}&cid=${current.cid}&qn=120&fnval=4048&fourk=1`, referer);
  if (!play?.dash) {
    throw new VdlError('no_stream', '没有 DASH 流（可能需要登录或该视频受限）',
      '手机端不支持登录；桌面端用 vdl auth bilibili 后可以拿到 1080P/4K');
  }

  const durationMs = Number(play.timelength || 0) || Number(view.duration || 0) * 1000;
  const { formats, urls } = foldDash(play.dash, durationMs);
  if (!formats.length) throw new VdlError('no_stream', '没有视频轨');

  const parts: Part[] = pages.length > 1 ? pages.map((p) => ({
    index: Number(p.page || 0),
    title: p.part || `P${p.page}`,
    duration_ms: Number(p.duration || 0) * 1000,
    url: `https://www.bilibili.com/video/${bvid}?p=${p.page}`,
    selected: Number(p.page) === page,
  })) : [];

  const probe: ProbeResult = {
    schema: 2,
    ok: true,
    platform: 'bilibili',
    engine: 'bilibili-api-mobile',
    media: {
      id: bvid,
      title: view.title || 'B站视频',
      author: view.owner?.name || '',
      duration_ms: durationMs || null,
      thumbnail: view.pic || '',
      source_url: `https://www.bilibili.com/video/${bvid}${pages.length > 1 ? `?p=${page}` : ''}`,
      platform: 'bilibili',
      parts,
    },
    formats,
    warnings: await dashWarnings(play.dash),
    error: null,
  };
  return { probe, urls, sub: { bvid, cid: Number(current.cid) } };
}

async function probeBangumi(target: BilibiliTarget): Promise<BilibiliProbeInternal> {
  const query = target.kind === 'ep' ? `ep_id=${target.epId}` : `season_id=${target.seasonId}`;
  const referer = target.kind === 'ep'
    ? `https://www.bilibili.com/bangumi/play/ep${target.epId}`
    : `https://www.bilibili.com/bangumi/play/ss${target.seasonId}`;

  const season = await apiJson(`/pgc/view/web/season?${query}`, referer);
  const episodes: any[] = season.episodes || [];
  if (!episodes.length) throw new VdlError('no_stream', '这个番剧没有可播放的剧集');

  const index = target.kind === 'ep'
    ? Math.max(0, episodes.findIndex((e) => String(e.id) === String(target.epId)))
    : 0;
  const ep = episodes[index];
  const epReferer = `https://www.bilibili.com/bangumi/play/ep${ep.id}`;

  const play = await apiJson(
    `/pgc/player/web/v2/playurl?ep_id=${ep.id}&fnval=12240&fourk=1`, epReferer);
  const dash = play?.video_info?.dash || play?.dash;
  if (!dash) {
    throw new VdlError('no_stream', '没有 DASH 流（可能需要大会员或该集受限）');
  }

  const durationMs = Number(ep.duration || 0) || Number(play.timelength || 0);
  const { formats, urls } = foldDash(dash, durationMs);
  if (!formats.length) throw new VdlError('no_stream', '没有视频轨');

  const parts: Part[] = episodes.map((e, i) => ({
    index: i + 1,
    title: e.long_title || e.title || `EP${i + 1}`,
    duration_ms: Number(e.duration || 0),
    url: `https://www.bilibili.com/bangumi/play/ep${e.id}`,
    selected: i === index,
  }));

  const probe: ProbeResult = {
    schema: 2,
    ok: true,
    platform: 'bilibili',
    engine: 'bilibili-pgc-mobile',
    media: {
      id: `ep${ep.id}`,
      title: season.season_title || 'B站番剧',
      author: '',
      duration_ms: durationMs || null,
      thumbnail: season.cover || ep.cover || '',
      source_url: epReferer,
      platform: 'bilibili',
      parts,
    },
    formats,
    warnings: await dashWarnings(dash),
    error: null,
  };
  return { probe, urls, sub: { epId: String(ep.id) } };
}

/* ───────────────────────────── 大小探测与进度 ───────────────────────────── */

/** 从 `content-range: bytes 0-0/21154992` 取总字节；`*` 或畸形值返回 0。 */
export function parseContentRangeTotal(header: string | null): number {
  const m = /\/(\d+)\s*$/.exec(header || '');
  return m ? Number(m[1]) : 0;
}

/**
 * 两轨共用一个分母。planned 是 Range 探到的真实总字节，
 * 探不到就退回 playurl 的带宽估算（带宽缺失时为 0，界面只会显示已写字节）。
 */
export function aggregateProgress(
  base: number, written: number, planned: number, streamTotal: number,
): [number, number] {
  if (planned > 0) return [base + written, planned];
  return [base + written, streamTotal > 0 ? base + streamTotal : 0];
}

async function probeStreamSize(url: string): Promise<number> {
  if (!url) return 0;
  try {
    const res = await request(url, {
      headers: { 'User-Agent': UA, Referer: REFERER, Range: 'bytes=0-0' },
      timeoutMs: 15_000,
    });
    const ranged = parseContentRangeTotal(res.headers.get('content-range'));
    const length = Number(res.headers.get('content-length') || 0);
    if (ranged > 0) return ranged;
    // 服务端忽略 Range 返回 200 时，Content-Length 就是完整大小
    return res.status === 200 && length > 0 ? length : 0;
  } catch {
    return 0;
  }
}

/* ───────────────────────────── 字幕 / 弹幕 ───────────────────────────── */

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 秒 → `HH:MM:SS,mmm`（SRT 用逗号，不是小数点）。 */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad2(Math.floor(ms / 3600000))}:${pad2(Math.floor((ms % 3600000) / 60000))}:`
    + `${pad2(Math.floor((ms % 60000) / 1000))},${String(ms % 1000).padStart(3, '0')}`;
}

/** B站字幕 JSON（`body[].from/to/content`）→ SRT。 */
export function toSrt(body: Array<{ from: number; to: number; content: string }>): string {
  return (body || []).map((line, i) =>
    `${i + 1}\n${srtTime(line.from)} --> ${srtTime(line.to)}\n`
    + `${String(line.content || '').replace(/\r/g, '')}\n`).join('\n');
}

/** 数 `<d ` 标签；弹幕 XML 的条目就是 `<d p="...">文本</d>`。 */
export function countDanmaku(xml: string): number {
  return (xml.match(/<d /g) || []).length;
}

type SubEntry = { lan: string; name: string; url: string };

export async function fetchSubtitleList(sub: SubtitleTarget): Promise<SubEntry[]> {
  const query = sub.bvid ? `bvid=${sub.bvid}&cid=${sub.cid}` : `ep_id=${sub.epId}`;
  // player/v2 偶发返回空（风控/抖动），空一次就重试一次，别把「暂时没拿到」当「没有字幕」
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await apiJson(`/x/player/v2?${query}`, REFERER);
      const list = (data?.subtitle?.subtitles || [])
        .map((s: any) => ({
          lan: String(s.lan || ''),
          name: String(s.lan_doc || s.lan || ''),
          url: String(s.subtitle_url || ''),
        }))
        .filter((s: SubEntry) => s.url);
      if (list.length) return list;
    } catch {
      // 重试一次再放弃
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return [];
}

async function saveSubtitle(stem: string, sub: SubtitleTarget): Promise<{ count: number; note?: string }> {
  const list = await fetchSubtitleList(sub);
  if (!list.length) return { count: 0, note: '没有可用字幕或字幕获取失败' };
  const pick = list.find((s) => /^(ai-)?zh/i.test(s.lan)) || list[0];
  const url = pick.url.startsWith('//') ? `https:${pick.url}` : pick.url;
  try {
    const res = await request(url, {
      headers: { 'User-Agent': UA, Referer: REFERER },
      timeoutMs: 20_000,
    });
    if (!res.ok) return { count: 0, note: `字幕下载失败 HTTP ${res.status}` };
    const json = await res.json() as { body?: Array<{ from: number; to: number; content: string }> };
    const text = toSrt(json?.body || []);
    if (!text.trim()) return { count: 0, note: '字幕内容为空' };
    await writeTextAndPublish(`${stem}.srt`, text);
    return { count: (json?.body || []).length };
  } catch (error) {
    return { count: 0, note: `字幕获取失败：${(error as Error).message}` };
  }
}

async function saveDanmaku(stem: string, sub: SubtitleTarget): Promise<{ count: number; note?: string }> {
  // 番剧的分段弹幕接口还没验，直接说「不支持」，不用空文件冒充
  if (!sub.bvid || !sub.cid) return { count: 0, note: '番剧弹幕暂不支持' };
  try {
    const res = await request(`https://api.bilibili.com/x/v1/dm/list.so?oid=${sub.cid}`, {
      headers: { 'User-Agent': UA, Referer: REFERER },
      timeoutMs: 20_000,
    });
    if (!res.ok) return { count: 0, note: `弹幕接口 HTTP ${res.status}` };
    const text = await res.text();
    const count = countDanmaku(text);
    if (!count) return { count: 0, note: '没有可用弹幕' };
    await writeTextAndPublish(`${stem}.danmaku.xml`, text);
    return { count };
  } catch (error) {
    return { count: 0, note: `弹幕获取失败：${(error as Error).message}` };
  }
}

/* ───────────────────────────── 下载 ───────────────────────────── */

export type BilibiliDownloadHooks = {
  onProgress?: (bytes: number, total: number) => void;
  onReady?: (jobId: string, resumeFrom: number) => void;
};

export type BilibiliDownloadOptions = {
  subs?: boolean;
  danmaku?: boolean;
  /** 超过这个字节数就拆轨（默认 150MB） */
  maxMuxBytes?: number;
};

export type BilibiliDownloadResult = {
  path: string;
  bytes: number;
  name: string;
  label: string;
  resumeFrom: number;
  ms: number;
  warnings: string[];
  srtCount: number;
  danmakuCount: number;
  /** 真的合并了没有：拆轨时为 false，界面/日志一眼能看出来 */
  muxed: boolean;
};

function codedError(code: string, message: string, next?: string): Error {
  const error = new Error(`${code}: ${message}${next ? `（${next}）` : ''}`) as Error & { code?: string };
  error.code = code;
  return error;
}

export function chooseFormat<T extends { id: string; recommended?: boolean }>(
  formats: T[], formatId: string | null,
): T {
  if (formatId) {
    const hit = formats.find((f) => f.id === formatId);
    if (hit) return hit;
    throw codedError('no_stream', `该视频没有 ${formatId} 档位`,
      `可用档位：${formats.map((f) => f.id).join(' / ') || '无'}`);
  }
  const best = formats.find((f) => f.recommended) || formats[0];
  if (!best) throw codedError('no_stream', '没有可用档位');
  return best;
}

type MuxResult = {
  name: string;
  bytes: number;
  tracks: number;
  durationUs: number;
  rotation: number;
  videoCodec: string;
  audioCodec: string;
};

/** 音视频合并（原生），失败抛出带 code 的错误由上层降级成拆轨。 */
async function muxStaged(video: string, audio: string, name: string): Promise<MuxResult> {
  return call<MuxResult>('media.mux', { video, audio, name }, {
    // 150MB 的两轨在手机上封装约 10~30 秒；给足时间，别用默认 15s 把人卡在边界
    timeoutMs: 10 * 60_000,
  });
}

async function renameStaged(from: string, to: string): Promise<number> {
  const res = await call<{ name: string; bytes: number }>('fs.rename', { from, to });
  return res.bytes;
}

async function publishStaged(
  name: string,
  warnings: string[],
): Promise<{ path: string; bytes: number }> {
  const res = await call<{ path: string; bytes: number; note?: string }>(
    'fs.publish', { name }, { timeoutMs: 10 * 60_000 },
  );
  // note：原生在「自选目录写失败、已回退到 Download/VDACC」时给的原因，必须透给用户
  if (res.note) warnings.push(res.note);
  return { path: res.path, bytes: res.bytes };
}

export async function downloadBilibili(
  input: string,
  formatId: string | null,
  hooks: BilibiliDownloadHooks = {},
  options: BilibiliDownloadOptions = {},
): Promise<BilibiliDownloadResult> {
  const started = Date.now();
  const { probe, urls, sub } = await probeImpl(input);
  const fmt = chooseFormat(probe.formats, formatId);
  const pick = urls.get(fmt.id);
  if (!pick?.video) throw codedError('no_stream', '该档位没有可用地址');

  const selected = probe.media!.parts.find((p) => p.selected);
  const suffix = probe.media!.parts.length > 1 && selected
    ? `_${probe.media!.id.startsWith('ep') ? 'EP' : 'P'}${selected.index}` : '';
  const stem = `${probe.media!.id}_${safeName(probe.media!.title)}${suffix}`
    + `_${safeName(fmt.label, 16, fmt.id)}`;
  const name = `${stem}.mp4`;
  const warnings: string[] = [];

  // 分母优先用 Range 探到的真实字节（playurl 的带宽估算在带宽缺失时会先到 100% 再回落）
  const [vPlanned, aPlanned] = await Promise.all([
    probeStreamSize(pick.video),
    pick.audio ? probeStreamSize(pick.audio) : Promise.resolve(0),
  ]);
  let planned = 0;
  if (vPlanned) planned = pick.audio ? (aPlanned ? vPlanned + aPlanned : 0) : vPlanned;
  if (!planned) planned = fmt.bytes || 0;

  let base = 0;
  const sink = (written: number, total: number) => {
    const [w, t] = aggregateProgress(base, written, planned, total);
    hooks.onProgress?.(w, t);
  };
  const transferOptions = (url: string, stagedName: string) => ({
    url,
    name: stagedName,
    referer: REFERER,
    userAgent: UA,
    publish: false,
    onProgress: sink,
  });

  const vName = `${name}.video`;
  const aName = `${name}.audio`;

  const vHandle = await startTransfer(transferOptions(pick.video, vName));
  hooks.onReady?.(vHandle.jobId, vHandle.resumeFrom);
  const vOut = await vHandle.done;
  // 校验必须在合并之前：合并成功只说明封装跑通了，不说明内容完整
  if (vPlanned > 0 && vOut.bytes < vPlanned * 0.95) {
    throw codedError('incomplete_media', `视频轨只拿到 ${vOut.bytes} 字节，探测到 ${vPlanned} 字节`,
      '重试可续传；若持续偏小，可能是该清晰度被降级，换档再试');
  }
  base = vOut.bytes;

  let aOut: { bytes: number } | null = null;
  if (pick.audio) {
    const aHandle = await startTransfer(transferOptions(pick.audio, aName));
    hooks.onReady?.(aHandle.jobId, aHandle.resumeFrom);
    aOut = await aHandle.done;
    if (aPlanned > 0 && aOut.bytes < aPlanned * 0.95) {
      throw codedError('incomplete_media', `音频轨只拿到 ${aOut.bytes} 字节，探测到 ${aPlanned} 字节`, '重试可续传');
    }
  }

  const totalBytes = vOut.bytes + (aOut?.bytes || 0);
  const maxMuxBytes = options.maxMuxBytes ?? DEFAULT_MAX_MUX_BYTES;
  let muxed = false;
  let published: { path: string; bytes: number };

  if (!aOut) {
    // 没有音轨：把视频轨改名成最终名再发布，产物名不能带 `.video`
    warnings.push('这个视频没有音频轨，产物是无声视频');
    await renameStaged(vName, name);
    published = await publishStaged(name, warnings);
  } else if (totalBytes > maxMuxBytes) {
    // 超阈值拆轨：手机上合并大文件要额外写一份，代价比「播放器可能不支持」更直观
    const at = (totalBytes / 1048576).toFixed(1);
    warnings.push(`两轨合计 ${at} MB，超过合并上限 ${(maxMuxBytes / 1048576).toFixed(0)} MB，`
      + '已拆成 .video.mp4 与 .audio.m4a 两个文件（没有合并）');
    const vBytes = await renameStaged(vName, `${stem}.video.mp4`);
    const vPub = await publishStaged(`${stem}.video.mp4`, warnings);
    await renameStaged(aName, `${stem}.audio.m4a`);
    const aPub = await publishStaged(`${stem}.audio.m4a`, warnings);
    published = { path: `${vPub.path} + ${aPub.path}`, bytes: vBytes + (aPub.bytes || 0) };
  } else {
    try {
      const merged = await muxStaged(vName, aName, name);
      muxed = true;
      if (merged.tracks < 2) warnings.push('合并产物只有 1 条轨（音频轨可能没写进去）');
      if (merged.rotation && ![0, 90, 180, 270].includes(merged.rotation)) {
        warnings.push(`视频旋转角 ${merged.rotation}° 未写入成片`);
      }
      published = await publishStaged(name, warnings);
    } catch (error) {
      // 合并失败不回滚已下好的流：拆轨后用户至少能拿到内容，且能看出「没合并」
      const code = (error as { code?: string }).code || 'media_mux_failed';
      const message = (error as Error).message || '未知原因';
      warnings.push(`合并失败（${code}）：${message}；已拆成 .video.mp4 与 .audio.m4a`);
      const vBytes = await renameStaged(vName, `${stem}.video.mp4`);
      const vPub = await publishStaged(`${stem}.video.mp4`, warnings);
      await renameStaged(aName, `${stem}.audio.m4a`);
      const aPub = await publishStaged(`${stem}.audio.m4a`, warnings);
      published = { path: `${vPub.path} + ${aPub.path}`, bytes: vBytes + (aPub.bytes || 0) };
    }
  }

  // 附属产物：失败只 warning，绝不把已下好的视频判成失败（与桌面端同一条规矩）
  let srtCount = 0;
  let danmakuCount = 0;
  if (options.subs) {
    const srt = await saveSubtitle(stem, sub);
    srtCount = srt.count;
    if (srt.note) warnings.push(`${srt.note}，主文件已保留`);
  }
  if (options.danmaku) {
    const dm = await saveDanmaku(stem, sub);
    danmakuCount = dm.count;
    if (dm.note) warnings.push(`${dm.note}，主文件已保留`);
  }

  return {
    path: published.path,
    bytes: published.bytes,
    name,
    label: fmt.label,
    resumeFrom: vHandle.resumeFrom,
    ms: Date.now() - started,
    warnings,
    srtCount,
    danmakuCount,
    muxed,
  };
}
