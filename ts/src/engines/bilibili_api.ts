import { operationState, scopedOperation } from '../core/operation';
import { saveCover } from '../core/sidecar';
import type { DownloadOptions } from '../core/types';
import { runFfmpeg } from '../core/ffmpeg';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { throwIfCancelled } from '../core/cancel';
import { VdlError } from '../core/errors';
import { UA } from '../core/http';
import { safeName } from '../core/naming';
import { report } from '../core/progress';
import { throttle } from '../core/rate';
import { format, type Format, type Media, type Part, type ProbeResult } from '../core/types';

const API = 'https://api.bilibili.com';
const BUCKETS: Array<[number, string]> = [
  [3840, '4K'], [2560, '2K'], [1920, '1080P'], [1280, '720P'], [854, '480P'],
];

const urlCache = operationState(() => new Map<string, { video: string; audio: string }>());
/** 字幕接口要 bvid+cid（普通视频）或 ep_id（番剧）；探测时顺手记下，下载带 --subs 时才请求。 */
const subtitleState = operationState(() => ({ value: null as { bvid?: string; cid?: number; epId?: string } | null }));

/** 供下载前预览：只取视频轨（浏览器预览不需要音轨）。 */
export function previewBilibili(formatId: string): string {
  return urlCache().get(formatId)?.video || '';
}

/** 关键：不能把所有 cookie 拼进去（实测 64 条 / 8.9KB 会被 WAF 判 400），
 *  只带 bilibili 域名下、未过期的，约 27 条 / 1.7KB。 */
function cookieHeader(): string {
  const dir = join(process.env.LOCALAPPDATA || '', 'vdl', 'auth');
  const txt = join(dir, 'bilibili.cookies.txt');
  if (existsSync(txt)) {
    const now = Date.now() / 1000;
    const pairs = new Map<string, string>();
    for (const line of readFileSync(txt, 'utf8').split(/\r?\n/)) {
      const parts = line.split('\t');
      if (parts.length < 7 || !parts[0].includes('bilibili.com')) continue;
      const exp = Number(parts[4] || 0);
      if (exp && exp < now) continue;
      pairs.set(parts[5], parts[6]);
    }
    if (pairs.size) return [...pairs].map(([n, v]) => `${n}=${v}`).join('; ');
  }
  // 兜底：storage_state JSON，同样过滤域名/过期
  const js = join(dir, 'bilibili.json');
  if (!existsSync(js)) return '';
  try {
    const state = JSON.parse(readFileSync(js, 'utf8'));
    const now = Date.now() / 1000;
    const pairs = new Map<string, string>();
    for (const c of state.cookies || []) {
      if (!String(c.domain || '').includes('bilibili.com')) continue;
      if (Number(c.expires || -1) > 0 && Number(c.expires) < now) continue;
      pairs.set(c.name, c.value);
    }
    return [...pairs].map(([n, v]) => `${n}=${v}`).join('; ');
  } catch {
    return '';
  }
}

async function apiJson(path: string, referer: string): Promise<any> {
  const headers: Record<string, string> = {
    'User-Agent': UA, Referer: referer, Accept: 'application/json, text/plain, */*',
  };
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(API + path, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new VdlError('download_failed', `B站接口 ${path.split('?')[0]} HTTP ${res.status}`);
  }
  const data = JSON.parse(text);
  if (data?.code !== 0) {
    throw new VdlError('download_failed',
      `B站接口 ${path.split('?')[0]} code=${data?.code} ${data?.message || ''}`);
  }
  return data.result ?? data.data;
}

function bucketOf(width: number): [number, string] {
  for (const [limit, label] of BUCKETS) if (width >= limit) return [limit, label];
  return [0, '标清'];
}

function codecScore(codec: string): number {
  const low = (codec || '').toLowerCase();
  if (low.startsWith('avc')) return 2;
  if (low.startsWith('hev') || low.startsWith('hvc')) return 1;
  return 0;
}

function foldDash(dash: any, durationMs: number): Format[] {
  const videos: any[] = dash?.video || [];
  const audios: any[] = dash?.audio || [];
  const bestAudio = audios.sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0];
  const seconds = durationMs / 1000;

  const groups = new Map<number, any[]>();
  for (const v of videos) {
    const [limit] = bucketOf(Number(v.width || 0));
    if (!groups.has(limit)) groups.set(limit, []);
    groups.get(limit)!.push(v);
  }

  const out: Format[] = [];
  for (const limit of [...groups.keys()].sort((a, b) => b - a)) {
    const best = groups.get(limit)!
      .sort((a, b) => codecScore(b.codecs) - codecScore(a.codecs) ||
        Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0];
    const id = `bili-${limit || 'sd'}`;
    const totalBw = Number(best.bandwidth || 0) + Number(bestAudio?.bandwidth || 0);
    out.push(format({
      id,
      // 不落在已知档位的（竖屏 720×1280、640×360 等）用「宽×高」，别只报高度——
      // 竖屏视频只报高度会显示成「1280P」，看着像 4K 档
      label: BUCKETS.find(([l]) => l === limit)?.[1] || `${best.width}×${best.height}`,
      width: Number(best.width || 0), height: Number(best.height || 0),
      ext: 'mp4', vcodec: String(best.codecs || '').split('.')[0],
      acodec: bestAudio ? String(bestAudio.codecs || '').split('.')[0] : '',
      fps: Number(best.frameRate || 0) || 0,
      bytes: Math.round((totalBw * seconds) / 8) || null,
      bitrate: Math.round(totalBw) || null,
    }));
    urlCache().set(id, {
      video: best.baseUrl || best.base_url,
      audio: bestAudio ? (bestAudio.baseUrl || bestAudio.base_url) : '',
    });
  }
  // 推荐 1080P：批量/分P 默认勾 4K 会变成 1.4GB/集，用户一次误点就是几十 GB
  const preferred = out.find((f) => f.width === 1920) ||
    out.find((f) => f.width <= 1920) || out[0];
  if (preferred) preferred.recommended = true;
  return out;
}

interface Target {
  kind: 'video' | 'ep' | 'ss';
  bvid?: string;
  page: number;
  epId?: string;
  seasonId?: string;
}

function parseTarget(input: string): Target {
  const raw = (input || '').trim();
  const url = /^BV[0-9A-Za-z]{10}$/.test(raw)
    ? `https://www.bilibili.com/video/${raw}` : raw;
  const ep = /\/bangumi\/play\/ep(\d+)/.exec(url);
  if (ep) return { kind: 'ep', page: 1, epId: ep[1] };
  const ss = /\/bangumi\/play\/ss(\d+)/.exec(url);
  if (ss) return { kind: 'ss', page: 1, seasonId: ss[1] };
  const bv = /(BV[0-9A-Za-z]{10})/.exec(url);
  if (!bv) throw new VdlError('bad_input', `识别不出 BV 号或番剧 ID: ${input}`);
  let page = 1;
  try { page = Number(new URL(url).searchParams.get('p') || 1) || 1; } catch { /* ignore */ }
  return { kind: 'video', bvid: bv![1], page };
}

async function probeBilibiliApiImpl(input: string): Promise<ProbeResult> {
  urlCache().clear();
  subtitleState().value = null;
  const target = parseTarget(input);
  return target.kind === 'video' ? probeVideo(target) : probeBangumi(target);
}

async function probeVideo(target: Target): Promise<ProbeResult> {
  const bvid = target.bvid!;
  const view = await apiJson(`/x/web-interface/view?bvid=${bvid}`,
    `https://www.bilibili.com/video/${bvid}`);
  const pages: any[] = view.pages || [];
  const page = Math.min(Math.max(1, target.page), Math.max(1, pages.length));
  const current = pages[page - 1] || { cid: view.cid, part: '' };
  const referer = `https://www.bilibili.com/video/${bvid}?p=${page}`;

  const play = await apiJson(
    `/x/player/playurl?bvid=${bvid}&cid=${current.cid}&qn=120&fnval=4048&fourk=1`, referer);
  if (!play?.dash) throw new VdlError('no_stream', '没有 DASH 流（可能需要登录或该视频受限）');

  const durationMs = Number(play.timelength || 0) || Number(view.duration || 0) * 1000;
  const formats = foldDash(play.dash, durationMs);
  if (!formats.length) throw new VdlError('no_stream', '没有视频轨');
  subtitleState().value = { bvid, cid: Number(current.cid) };

  const parts: Part[] = pages.length > 1 ? pages.map((p) => ({
    index: Number(p.page || 0),
    title: p.part || `P${p.page}`,
    duration_ms: Number(p.duration || 0) * 1000,
    url: `https://www.bilibili.com/video/${bvid}?p=${p.page}`,
    selected: Number(p.page) === page,
  })) : [];

  return {
    schema: 2, ok: true, platform: 'bilibili', engine: 'bilibili-api',
    media: {
      id: bvid,
      title: view.title || 'B站视频',
      author: view.owner?.name || '',
      duration_ms: durationMs || null,
      thumbnail: view.pic || '',
      source_url: `https://www.bilibili.com/video/${bvid}${pages.length > 1 ? `?p=${page}` : ''}`,
      platform: 'bilibili', parts,
    },
    formats, warnings: [], error: null,
  };
}

async function probeBangumi(target: Target): Promise<ProbeResult> {
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
  if (!dash) throw new VdlError('no_stream', '没有 DASH 流（可能需要大会员或该集受限）');

  const durationMs = Number(ep.duration || 0) || Number(play.timelength || 0);
  const formats = foldDash(dash, durationMs);
  if (!formats.length) throw new VdlError('no_stream', '没有视频轨');
  subtitleState().value = { epId: String(ep.id) };

  const parts: Part[] = episodes.map((e, i) => ({
    index: i + 1,
    title: e.long_title || e.title || `EP${i + 1}`,
    duration_ms: Number(e.duration || 0),
    url: `https://www.bilibili.com/bangumi/play/ep${e.id}`,
    selected: i === index,
  }));

  const media: Media = {
    id: `ep${ep.id}`,
    title: season.season_title || 'B站番剧',
    author: '',
    duration_ms: durationMs || null,
    thumbnail: season.cover || ep.cover || '',
    source_url: epReferer,
    platform: 'bilibili',
    parts,
  };
  return { schema: 2, ok: true, platform: 'bilibili', engine: 'bilibili-pgc', media,
           formats, warnings: [], error: null };
}

async function streamTo(url: string, part: string,
                        onProgress: (w: number, t: number) => void = report): Promise<number> {
  let resume = existsSync(part) ? statSync(part).size : 0;
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
  if (resume) headers.Range = `bytes=${resume}-`;
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) throw new VdlError(`http_${res.status}`, `下载失败 ${res.status}`);
  if (resume && res.status !== 206) resume = 0;
  const total = Number(res.headers.get('content-length') || 0) + resume;
  const fh = await open(part, resume ? 'a' : 'w');
  let written = resume;
  // 限速按单条流算：音轨会重新起算一份预算，见 core/rate.ts 的已知边界说明
  let sinceStart = 0;
  const startedAt = Date.now();
  let last = 0;
  try {
    for await (const chunk of res.body as any) {
      throwIfCancelled();
      await fh.write(chunk);
      written += chunk.length;
      sinceStart += chunk.length;
      await throttle(sinceStart, startedAt);
      const now = Date.now();
      if (now - last > 200) { last = now; onProgress(written, total); }
    }
  } finally {
    await fh.close();
  }
  onProgress(written, total || written);
  return statSync(part).size;
}

/** 从 `content-range: bytes 0-0/21154992` 里取总字节；`*` 或畸形值返回 0。 */
export function parseContentRangeTotal(header: string | null): number {
  const m = /\/(\d+)\s*$/.exec(header || '');
  return m ? Number(m[1]) : 0;
}

/**
 * 进度折算：两条流共用同一个分母。
 * planned 是「探测到的视频+音频真实总字节」（探不到时退回 bandwidth 估算），
 * 它非 0 就一直用它，否则退回「已完成 + 当前流总量」——后者在切到音轨时分会变，
 * 但至少不会卡在 100% 不动。
 */
export function aggregateProgress(
  base: number, written: number, planned: number, streamTotal: number,
): [number, number] {
  if (planned > 0) return [base + written, planned];
  return [base + written, streamTotal > 0 ? base + streamTotal : 0];
}

/**
 * 用 `Range: bytes=0-0` 探真实总字节。B站 CDN 支持 Range（续传就靠它），
 * 只读响应头、立刻取消 body，不会真下一个字节；失败返回 0 由调用方回退。
 */
async function probeStreamSize(url: string): Promise<number> {
  if (!url) return 0;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Range: 'bytes=0-0' },
    });
    const ranged = parseContentRangeTotal(res.headers.get('content-range'));
    const length = Number(res.headers.get('content-length') || 0);
    await res.body?.cancel();
    if (ranged > 0) return ranged;
    // 服务端忽略 Range 返回 200 时，Content-Length 就是完整大小
    return res.status === 200 && length > 0 ? length : 0;
  } catch {
    return 0;
  }
}

/** 数 `<d ` 标签；弹幕 XML 的条目就是 `<d p="...">文本</d>`。 */
export function countDanmaku(xml: string): number {
  return (xml.match(/<d /g) || []).length;
}

/**
 * 弹幕 XML 落盘。只有普通视频（有 cid）支持；番剧的分段弹幕接口还没验，直接说「不支持」，
 * 不要用空文件冒充。
 */
async function saveDanmaku(videoPath: string): Promise<{
  xml: string | null; count: number; supported: boolean;
}> {
  const subCtx = subtitleState().value;
  if (!subCtx?.bvid || !subCtx.cid) return { xml: null, count: 0, supported: false };
  try {
    const res = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${subCtx.cid}`,
      { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } });
    if (!res.ok) return { xml: null, count: 0, supported: true };
    const text = await res.text();
    const count = countDanmaku(text);
    if (!count) return { xml: null, count: 0, supported: true };
    const target = videoPath.replace(/\.mp4$/i, '.danmaku.xml');
    writeFileSync(target, text, 'utf8');
    return { xml: target, count, supported: true };
  } catch {
    return { xml: null, count: 0, supported: true };
  }
}

interface SubEntry { lan: string; name: string; url: string }

/**
 * 拉字幕列表（含 AI 字幕）。失败返回空数组——
 * 字幕是附属产物，不能因为它把已经下好的视频判成失败。
 */
async function fetchSubtitleList(): Promise<SubEntry[]> {
  const subCtx = subtitleState().value;
  if (!subCtx) return [];
  const query = subCtx.bvid ? `bvid=${subCtx.bvid}&cid=${subCtx.cid}` : `ep_id=${subCtx.epId}`;
  // player/v2 偶发返回空（风控/抖动），空一次就重试一次，别把「暂时没拿到」当成「没有字幕」
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await apiJson(`/x/player/v2?${query}`, 'https://www.bilibili.com/');
      const list = (data?.subtitle?.subtitles || [])
        .map((s: any) => ({
          lan: String(s.lan || ''),
          name: String(s.lan_doc || s.lan || ''),
          url: String(s.subtitle_url || ''),
        }))
        .filter((s: SubEntry) => s.url);
      if (list.length) return list;
    } catch {
      // 重试
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  return [];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 秒 → `HH:MM:SS,mmm`（SRT 用逗号，不是小数点）。 */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad2(Math.floor(ms / 3600000))}:${pad2(Math.floor((ms % 3600000) / 60000))}:` +
    `${pad2(Math.floor((ms % 60000) / 1000))},${String(ms % 1000).padStart(3, '0')}`;
}

/** B站字幕 JSON（`body[].from/to/content`）→ SRT。正文里的换行原样保留。 */
export function toSrt(body: Array<{ from: number; to: number; content: string }>): string {
  return (body || []).map((line, i) =>
    `${i + 1}\n${srtTime(line.from)} --> ${srtTime(line.to)}\n` +
    `${String(line.content || '').replace(/\r/g, '')}\n`).join('\n');
}

async function saveSubtitle(videoPath: string): Promise<{ srt: string | null; count: number }> {
  const list = await fetchSubtitleList();
  if (!list.length) return { srt: null, count: 0 };
  const pick = list.find((s) => /^(ai-)?zh/i.test(s.lan)) || list[0];
  const url = pick.url.startsWith('//') ? `https:${pick.url}` : pick.url;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } });
    if (!res.ok) return { srt: null, count: 0 };
    const json = await res.json() as any;
    const lines: Array<{ from: number; to: number; content: string }> = json?.body || [];
    const text = toSrt(lines);
    if (!text.trim()) return { srt: null, count: 0 };
    const target = videoPath.replace(/\.mp4$/i, '.srt');
    writeFileSync(target, text, 'utf8');
    // count 是字幕行数（跟弹幕条数同量纲），不是字幕轨数
    return { srt: target, count: lines.length };
  } catch {
    return { srt: null, count: 0 };
  }
}

/**
 * 只重取附属文件：复用 probe 拿到 bvid+cid（或 ep_id），不重新下载视频。
 * 字幕永远重取；弹幕只在任务当初开了 danmaku 时重取。
 */
export async function refetchSidecars(
  input: string, videoPath: string, opts: { subs?: boolean; danmaku?: boolean } = {},
) {
  await probeBilibiliApi(input);
  const sub = opts.subs === false ? { srt: null, count: 0 } : await saveSubtitle(videoPath);
  const dm = opts.danmaku ? await saveDanmaku(videoPath) : null;
  return {
    srt: sub.srt, srtCount: sub.count,
    danmaku: dm?.xml || null, danmakuCount: dm?.count || 0,
    danmakuSupported: dm ? dm.supported : null,
  };
}

/**
 * 选档：指定了 id 就必须命中，缺档位直接报错而不是悄悄换成别的清晰度。
 * 分P/番剧各集档位不一定一致，静默换档会让用户以为下到了 1080P。
 */
export function chooseFormat<T extends { id: string; recommended?: boolean }>(
  formats: T[], formatId: string | null,
): T {
  if (formatId) {
    const hit = formats.find((f) => f.id === formatId);
    if (hit) return hit;
    throw new VdlError('no_stream', `该视频没有 ${formatId} 档位`,
      `可用档位：${formats.map((f) => f.id).join(' / ') || '无'}`);
  }
  const best = formats.find((f) => f.recommended) || formats[0];
  if (!best) throw new VdlError('no_stream', '没有可用档位');
  return best;
}

async function getBilibiliApiImpl(
  input: string, formatId: string | null, outDir: string,
  opts: DownloadOptions = {},
) {
  const probe = await probeBilibiliApi(input);
  const fmt = chooseFormat(probe.formats, formatId);
  const urls = urlCache().get(fmt.id);
  if (!urls) throw new VdlError('no_stream', '该档位没有可用地址');

  mkdirSync(outDir, { recursive: true });
  const selected = probe.media!.parts.find((p) => p.selected);
  const suffix = probe.media!.parts.length > 1 && selected
    ? `_${probe.media!.id.startsWith('ep') ? 'EP' : 'P'}${selected.index}` : '';
  const stem = `${probe.media!.id}_${safeName(probe.media!.title)}${suffix}_${safeName(fmt.label, 16, fmt.id)}`;
  const dest = join(outDir, `${stem}.mp4`);
  const completed = async (skipped: boolean) => {
    // 视频已存在也要让 --subs / --danmaku 生效：附属产物不能因为跳过视频就一起跳过
    const sub = opts.subs ? await saveSubtitle(dest) : { srt: null, count: 0 };
    const dm = opts.danmaku ? await saveDanmaku(dest) : null;
    const cover = opts.cover ? await saveCover(dest, probe.media!.thumbnail, probe.media!.source_url)
      : { cover: null, warnings: [] };
    const warnings = [...cover.warnings];
    if (opts.subs && !sub.srt) warnings.push('没有可用字幕或字幕获取失败，主文件已保留');
    if (opts.danmaku && !dm?.xml) warnings.push(dm?.supported
      ? '没有可用弹幕或弹幕获取失败，主文件已保留' : '番剧弹幕暂不支持，主文件已保留');
    return {
      path: dest, bytes: statSync(dest).size, skipped, cover: cover.cover, warnings,
      srt: sub.srt, srtCount: sub.count,
      danmaku: dm?.xml || null, danmakuCount: dm?.count || 0,
      danmakuSupported: dm ? dm.supported : null,
    };
  };
  if (existsSync(dest)) return completed(true);

  const vPart = dest + '.video.m4s';
  const aPart = dest + '.audio.m4s';

  // 视频+音频两条流共用一个分母：优先用 Range 探到的真实总字节（精确），
  // 探不到才退回 playurl 的带宽估算（实测差 0.3%，且带宽缺失时会先到 100% 再回落）
  const expected = fmt.bytes || 0;
  const [vPlanned, aPlanned] = await Promise.all([
    probeStreamSize(urls.video),
    urls.audio ? probeStreamSize(urls.audio) : Promise.resolve(0),
  ]);
  let planned = 0;
  if (vPlanned) planned = urls.audio ? (aPlanned ? vPlanned + aPlanned : 0) : vPlanned;
  if (!planned) planned = expected;

  let base = 0;
  const sink = (written: number, total: number) => {
    const [w, t] = aggregateProgress(base, written, planned, total);
    report(w, t);
  };
  await streamTo(urls.video, vPart, sink);
  base = statSync(vPart).size;
  if (urls.audio) await streamTo(urls.audio, aPart, sink);
  if (process.env.VDL_DEBUG_SIZE) {
    console.log('[size] vPlanned', vPlanned, 'aPlanned', aPlanned, 'planned', planned,
      'expected', expected, 'vPart', statSync(vPart).size, 'aPart', statSync(aPart).size);
  }

  const merged = dest.replace(/\.mp4$/i, '.mux.mp4');
  const args = urls.audio
    ? ['-y', '-hide_banner', '-loglevel', 'error', '-i', vPart, '-i', aPart, '-c', 'copy', merged]
    : ['-y', '-hide_banner', '-loglevel', 'error', '-i', vPart, '-c', 'copy', merged];
  const run = await runFfmpeg(args);
  if (run.code !== 0) {
    try { unlinkSync(merged); } catch { /* 只移除本次未完成的合并产物。 */ }
    throw new VdlError(run.code === -2 ? 'ffmpeg_missing' : 'ffmpeg_failed',
      '音视频合并失败，已保留分离流供重试', '检查 ffmpeg 是否可用和磁盘空间后重试');
  }
  renameSync(merged, dest);
  for (const p of [vPart, aPart]) { try { unlinkSync(p); } catch { /* ignore */ } }
  return completed(false);
}

export const probeBilibiliApi = scopedOperation(probeBilibiliApiImpl);

export const getBilibiliApi = scopedOperation(getBilibiliApiImpl);
