import { operationState, scopedOperation } from '../core/operation';
import { saveCover } from '../core/sidecar';
import type { DownloadOptions } from '../core/types';
import { releaseDest, reserveDest } from '../core/dest';
import { runFfmpeg } from '../core/ffmpeg';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { throwIfCancelled } from '../core/cancel';
import { VdlError } from '../core/errors';
import { UA } from '../core/http';
import { safeName } from '../core/naming';
import { report } from '../core/progress';
import { currentLimitBytesPerSec, throttle } from '../core/rate';
import { format, type Format, type Media, type Part, type ProbeResult } from '../core/types';

const API = 'https://api.bilibili.com';
const BUCKETS: Array<[number, string]> = [
  [3840, '4K'], [2560, '2K'], [1920, '1080P'], [1280, '720P'], [854, '480P'],
];

const urlCache = operationState(() => new Map<string, { video: string; audio: string }>());

/** 仅音频档位的固定 id：CLI `--format audio`、界面「音频」chip 都认它。 */
export const AUDIO_FORMAT_ID = 'audio';

/**
 * 「重新解析播放地址」的闭包。
 * B站 的 m4s 地址带签名与时效，长视频下到一半会 403（唧唧Down 里那句「刷新播放地址重试次数已用尽」
 * 就是这件事）。探测时把「再取一遍 DASH 并重填 urlCache」记下来，下载遇 403 才能续传，
 * 而不是把已经下好的几百兆扔掉。
 */
const refresher = operationState(() => ({ value: null as null | (() => Promise<void>) }));
/**
 * 字幕接口要 aid+cid（普通视频）或 ep_id（番剧）；探测时顺手记下，下载带 --subs 时才请求。
 *
 * `durationMs` 是**校验用的**：B站 的 `/x/player/v2` 会概率性返回**别的稿件**的字幕
 * （2026-11-09 实测：207s 的 MV 连续三次拿到跨度 746s / 1606s / 1337s、内容完全不同且与 MV 无关的字幕），
 * 直接写进 `.srt` 就是用户看到的「字幕全是错的」。拿到正文后必须核对时间轴跨度。
 */
const subtitleState = operationState(() => ({
  value: null as { bvid?: string; cid?: number; aid?: number; epId?: string; durationMs?: number } | null,
}));

/** 供下载前预览：视频轨地址。 */
export function previewBilibili(formatId: string): string {
  return urlCache().get(formatId)?.video || '';
}

/**
 * 预览用的**音轨**地址。
 *
 * DASH 是双轨：`<video>` 只有画面没有声音，界面预览一直是哑片。前端再挂一个 `<audio>`
 * 跟着 `<video>` 播/停/跳，预览才有声音。`audio` 档本身没有视频轨，这里返回空。
 */
export function previewBilibiliAudio(formatId: string): string {
  return urlCache().get(formatId)?.audio || '';
}

/** 关键：不能把所有 cookie 拼进去（实测 64 条 / 8.9KB 会被 WAF 判 400），
 *  只带 bilibili 域名下、未过期的，约 27 条 / 1.7KB。
 *  收藏夹接口复用同一份（私密收藏夹必须带 cookie）。 */
export function cookieHeader(): string {
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
  const name = path.split('?')[0];
  const res = await fetch(API + path, { headers });
  const text = await res.text();
  if (!res.ok) {
    // 接口层的 HTTP 错误不是「下载失败」——那时还没开始下载
    throw new VdlError(`http_${res.status}`, `B站接口 ${name} HTTP ${res.status}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    // 风控/WAF 会返回 HTML：如实说「不是 JSON」，不要伪装成业务错误
    throw new VdlError('api_error', `B站接口 ${name} 返回的不是 JSON（可能被风控）`);
  }
  if (data?.code !== 0) {
    const message = String(data?.message || '').trim();
    const label = `B站接口 ${name} 返回 code=${data?.code}${message ? ` ${message}` : ''}`;
    // 只有 -404 语义明确（稿件/剧集不存在）。其余码（大会员、地区、风控…）不翻译成结论，
    // 把平台自己的话交给用户判断；原来一律记成 download_failed 会让人以为下载坏了。
    if (Number(data?.code) === -404) throw new VdlError('not_found', label);
    throw new VdlError('api_error', label, '按平台提示确认稿件/账号/地区状态；这不是下载失败');
  }
  return data.result ?? data.data;
}

/**
 * DASH 流的完整性预检：两条轨缺一条，合并出来就是无声视频/无画面的音频。
 * 这里只**说明**，不阻断——确实存在无音轨的稿件（录屏、静音视频）。
 */
function dashWarnings(dash: any): string[] {
  const warnings: string[] = [];
  const audio = Array.isArray(dash?.audio) ? dash.audio : [];
  if (!audio.length) warnings.push('这个视频没有音频轨，下载结果会是无声视频');
  if (!cookieHeader()) warnings.push('未登录：清晰度以匿名放行为准（4K/1080P 通常需要登录）');
  return warnings;
}

/**
 * 网页 SSR 里的 DASH 流（只用来**补**API 缺的档位）。
 *
 * 实测（2026-11-06，ep397051，大会员）：`/pgc/player/web/v2/playurl` 最高只给 120（4K 5978k），
 * 而页面 SSR 的 `playurlSSRData` 里还有 **id=122「4K 高码率」**（avc1 8554k / hvc1 5968k）。
 * 参数矩阵 fnval ∈ {4048,12240,16336,20464} × qn ∈ {0,120,125,126,127} × v1/v2 全试过，
 * 122 一次都不出现；签过 wbi 的 `/x/player/wbi/playurl` 也没有。yt-dlp 同样是先读这份 SSR。
 *
 * 失败一律返回空数组、不抛：少了这档只是「差一个更高码率」，探测本身仍然有效。
 */
async function ssrDash(pageUrl: string): Promise<any[]> {
  try {
    const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(pageUrl, { headers });
    if (!res.ok) return [];
    const html = await res.text();
    const data = extractJsonAfter(html, 'playurlSSRData');
    const dash = data?.data?.result?.video_info?.dash
      || data?.data?.result?.dash
      || data?.result?.video_info?.dash
      || data?.result?.dash;
    return Array.isArray(dash?.video) ? dash.video : [];
  } catch {
    return [];
  }
}

/** 从 marker 后面第一个 `{` 起按括号配平取一个完整 JSON（字符串里的括号不算）。 */
function extractJsonAfter(html: string, marker: string): any | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 把 SSR 里 API 没有的流并进来（按 id+codecs+bandwidth 去重，不覆盖 API 的同一条）。 */
function mergeDash(primary: any, extra: any[]): any {
  const videos: any[] = Array.isArray(primary?.video) ? primary.video.slice() : [];
  const seen = new Set(videos.map((v) => `${v.id}|${v.codecs}|${v.bandwidth}`));
  for (const one of extra) {
    const key = `${one?.id}|${one?.codecs}|${one?.bandwidth}`;
    if (seen.has(key)) continue;
    seen.add(key);
    videos.push(one);
  }
  return { ...primary, video: videos };
}

/**
 * 档位按**长边**归档：横屏用宽，竖屏用高。
 *
 * 2026-11-10 实测（竖屏 BV1smWt6EE9L，1080×1920 / 60fps / 10.3Mbps）：
 * 只按宽看，1080 落在 854 与 1280 之间 → 被标成「480P」，界面上一个 1080P 级的流
 * 显示成 480P，用户会以为登录没生效。横屏不受影响（长边就是宽），
 * 4096×1740 这类宽银幕仍然按 4096 归档，跟 AGENTS 里「按宽度」的结论一致。
 */
function bucketOf(width: number, height = 0): [number, string] {
  const span = Math.max(Number(width || 0), Number(height || 0));
  for (const [limit, label] of BUCKETS) if (span >= limit) return [limit, label];
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
    const [limit] = bucketOf(Number(v.width || 0), Number(v.height || 0));
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
  // 单独一条「仅音频」：B站 的 DASH 音频轨本来就是独立文件（不下载视频轨就能拿），
  // 以前界面上是个禁用的 chip。它的 bytes 只按音频带宽算，不混进视频档位的体积。
  if (bestAudio) {
    const audioBw = Number(bestAudio.bandwidth || 0);
    out.push(format({
      id: AUDIO_FORMAT_ID,
      label: '仅音频 M4A',
      ext: 'm4a',
      acodec: String(bestAudio.codecs || '').split('.')[0],
      bitrate: audioBw || null,
      bytes: audioBw && seconds ? Math.round((audioBw * seconds) / 8) : null,
    }));
    urlCache().set(AUDIO_FORMAT_ID, {
      video: '',
      audio: bestAudio.baseUrl || bestAudio.base_url,
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
  const warnings = dashWarnings(play.dash);
  subtitleState().value = {
    bvid, cid: Number(current.cid), aid: Number(view.aid || 0), durationMs,
  };
  // 地址过期时用同一套参数再取一遍，foldDash 会把新地址写回 urlCache
  refresher().value = async () => {
    const again = await apiJson(
      `/x/player/playurl?bvid=${bvid}&cid=${current.cid}&qn=120&fnval=4048&fourk=1`, referer);
    if (!again?.dash) {
      throw new VdlError('url_expired', '播放地址已过期，重新获取失败',
        '稍后重试；持续失败请重新解析该视频');
    }
    foldDash(again.dash, durationMs);
  };

  // 单 P 也回 parts[1]：分析页要显示「第 1 P · CID · 时长」，空数组会让界面退化成
  // "没有分P"的另一种样子。cid 一并带上，界面才不用为它再打一次接口。
  // 只有真多 P 才拼 `?p=`：单 P 若写成 `?p=1`，它和 media.source_url 就成了两个不同字符串，
  // 后端的"同链接同档位去重"会认不出来（分析页与直接解析会各建一个任务）。
  const multi = pages.length > 1;
  const partRows = pages.length ? pages : [{ page: 1, part: '', cid: current.cid, duration: 0 }];
  const parts: Part[] = partRows.map((p) => ({
    index: Number(p.page || 1),
    title: p.part || (multi ? `P${p.page || 1}` : (view.title || '')),
    // 单 P 的 pages[0].duration 只有秒级；此时用播放接口算出的 durationMs 更准
    duration_ms: multi ? Number(p.duration || 0) * 1000 : durationMs,
    url: `https://www.bilibili.com/video/${bvid}${multi ? `?p=${p.page}` : ''}`,
    selected: Number(p.page || 1) === page,
    cid: Number(p.cid || 0) || undefined,
  }));

  return {
    schema: 2, ok: true, platform: 'bilibili', engine: 'bilibili-api',
    media: {
      id: bvid,
      title: view.title || 'B站视频',
      author: view.owner?.name || '',
      duration_ms: durationMs || null,
      thumbnail: view.pic || '',
      // 简介只给界面看；空串不写，避免所有平台都被塞一个无意义的 desc 键
      ...(String(view.desc || '').trim() ? { desc: String(view.desc).trim() } : {}),
      source_url: `https://www.bilibili.com/video/${bvid}${pages.length > 1 ? `?p=${page}` : ''}`,
      platform: 'bilibili', parts,
    },
    formats, warnings, error: null,
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
  // 先补 SSR 里那档「4K 高码率」再折叠：foldDash 会按码率取同档最优，
  // 少了这一步，用户勾「4K」拿到的是 5978k 而不是 8554k（与 yt-dlp 的差异就在这里）
  const ssr = await ssrDash(epReferer);
  const formats = foldDash(ssr.length ? mergeDash(dash, ssr) : dash, durationMs);
  if (!formats.length) throw new VdlError('no_stream', '没有视频轨');
  const warnings = dashWarnings(dash);
  subtitleState().value = { epId: String(ep.id), durationMs };
  // 番剧的地址同样会过期；重取时也要再补一次 SSR 那档 4K，否则刷新后会掉档
  refresher().value = async () => {
    const again = await apiJson(
      `/pgc/player/web/v2/playurl?ep_id=${ep.id}&fnval=12240&fourk=1`, epReferer);
    const againDash = again?.video_info?.dash || again?.dash;
    if (!againDash) {
      throw new VdlError('url_expired', '播放地址已过期，重新获取失败',
        '稍后重试；持续失败请重新解析该番剧');
    }
    const againSsr = await ssrDash(epReferer);
    foldDash(againSsr.length ? mergeDash(againDash, againSsr) : againDash, durationMs);
  };

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
           formats, warnings, error: null };
}

async function streamOnce(url: string, part: string,
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

/** 重试上限。地址过期不是「网络抖动」，2 次足够；再多说明是账号/权限问题，重试没用。 */
const URL_EXPIRED_RETRIES = 2;

/**
 * 下载一条流，遇到 **403 / 410**（B站 签名地址过期）时先刷新地址再续传。
 *
 * 为什么不重试其它错误：404 通常是被删/被限权，刷新地址也拿不到；5xx 会由外层任务的
 * 重试机制处理，在这里重试只会把一次失败拖成三次。
 * 续传本身由 `streamOnce` 里的 `.part` + `Range` 完成，所以重试不会重下已完成的字节。
 */
async function streamTo(
  url: string, part: string,
  onProgress: (w: number, t: number) => void = report,
  refetch?: () => Promise<string>,
): Promise<number> {
  let current = url;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await streamOnce(current, part, onProgress);
    } catch (err) {
      const code = err instanceof VdlError ? err.code : '';
      const expired = code === 'http_403' || code === 'http_410';
      if (!expired || !refetch || attempt >= URL_EXPIRED_RETRIES) {
        // 已经到了上限还失败：把「地址过期」说明白，别让用户以为是网络问题
        if (expired && refetch && attempt >= URL_EXPIRED_RETRIES) {
          throw new VdlError('url_expired',
            `播放地址已过期，刷新 ${URL_EXPIRED_RETRIES} 次后仍然失败`,
            '该视频可能刚被限权/删除；重试可续传，或换档位再试');
        }
        throw err;
      }
      current = await refetch();
      if (!current) throw err;
    }
  }
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
 * wbi 签名（B站 web 播放器同款）：把 nav 里两张图的名字拼起来，按固定表打散取前 32 位当密钥，
 * 再对「排序后的 query + 密钥」取 md5 作为 `w_rid`。
 *
 * 为什么必须签：`/x/player/v2`（未签名）对同一稿件会**概率性返回别的稿件的字幕**——
 * 2026-11-09 实测 207s 的 MV 连续三次拿到跨度 746s/1606s/1337s 的无关字幕；
 * 而签名的 `/x/player/wbi/v2` 与页面播放器一致，同一稿件重复请求结果稳定。
 */
const MIXIN_KEY_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
let wbiCache: { key: string; at: number } | null = null;

async function wbiMixinKey(): Promise<string> {
  if (wbiCache && Date.now() - wbiCache.at < 30 * 60_000) return wbiCache.key;
  try {
    const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${API}/x/web-interface/nav`, { headers });
    const nav = await res.json() as any;
    const base = (u: string) => String(u).slice(String(u).lastIndexOf('/') + 1).split('.')[0];
    const raw = base(nav?.data?.wbi_img?.img_url || '') + base(nav?.data?.wbi_img?.sub_url || '');
    if (raw.length < 64) return '';
    const key = MIXIN_KEY_TAB.map((i) => raw[i]).join('').slice(0, 32);
    wbiCache = { key, at: Date.now() };
    return key;
  } catch {
    // 拿不到密钥就退回未签名请求（配合下面的时长校验，宁可没有字幕也不写错的）
    return '';
  }
}

async function signedQuery(params: Record<string, string | number>): Promise<string> {
  const all: Record<string, string> = {
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    wts: String(Math.floor(Date.now() / 1000)),
  };
  const query = Object.keys(all).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k].replace(/[!'()*]/g, ''))}`)
    .join('&');
  const key = await wbiMixinKey();
  if (!key) return query;
  const wRid = createHash('md5').update(query + key).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/**
 * 拉字幕列表（含 AI 字幕）。失败返回空数组——
 * 字幕是附属产物，不能因为它把已经下好的视频判成失败。
 */
async function fetchSubtitleList(): Promise<SubEntry[]> {
  const subCtx = subtitleState().value;
  if (!subCtx) return [];
  const params: Record<string, string | number> = subCtx.aid
    ? { aid: subCtx.aid, cid: subCtx.cid || 0 }
    : { ep_id: subCtx.epId || '' };
  // 空列表有两种可能：真的没有字幕，或风控抖动。抖一次就重试一次，别把「暂时没拿到」当成「没有字幕」
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const query = await signedQuery(params);
      const data = await apiJson(`/x/player/wbi/v2?${query}`, 'https://www.bilibili.com/');
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

/**
 * 选轨：**人工优先**，AI 只兜底。
 *
 * 以前是 `list.find(/^(ai-)?zh/)`，列表顺序里 ai-zh 常常排在前面，于是有人工中文字幕的稿件
 * 也会被换成 AI 版（质量差一截）。顺序：人工中文 → 任意人工 → ai-zh → 第一条。
 */
export function pickSubtitle<T extends { lan: string }>(list: T[]): T | undefined {
  const manual = list.filter((s) => !/^ai-/i.test(s.lan));
  return manual.find((s) => /^zh/i.test(s.lan)) || manual[0]
    || list.find((s) => /^ai-zh/i.test(s.lan)) || list[0];
}

/**
 * 字幕正文与该视频是否对得上——这是「字幕全是错的」的兜底闸门。
 *
 * 判据只用时间轴：最后一行必须落在片长附近（容许 max(8s, 2%)），
 * 且不能只覆盖前一半（>=60s 的片子，最后一行至少要到片长一半）。
 * 对不上就丢弃并说清数字，绝不写一个看起来正常的错文件。
 */
export function subtitleFits(
  body: Array<{ from: number; to: number; content?: string }>, durationMs: number,
): { ok: boolean; reason?: string } {
  if (!body.length) return { ok: false, reason: '字幕正文是空的' };
  if (!durationMs || durationMs < 5000) return { ok: true };
  const duration = durationMs / 1000;
  const last = Math.max(...body.map((l) => Number(l.to) || 0));
  const tolerance = Math.max(8, duration * 0.02);
  if (last > duration + tolerance) {
    return { ok: false, reason: `字幕时间轴到 ${last.toFixed(0)}s，而视频只有 ${duration.toFixed(0)}s` };
  }
  if (duration >= 60 && last < duration / 2) {
    return { ok: false, reason: `字幕只覆盖到 ${last.toFixed(0)}s / ${duration.toFixed(0)}s，明显不完整` };
  }
  return { ok: true };
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

async function saveSubtitle(videoPath: string): Promise<{
  srt: string | null; count: number; lang?: string; reason?: string;
}> {
  const list = await fetchSubtitleList();
  if (!list.length) return { srt: null, count: 0, reason: '平台没有给出任何字幕轨' };
  const pick = pickSubtitle(list);
  if (!pick) return { srt: null, count: 0 };
  const url = pick.url.startsWith('//') ? `https:${pick.url}` : pick.url;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } });
    if (!res.ok) return { srt: null, count: 0, lang: pick.lan, reason: `字幕正文 HTTP ${res.status}` };
    const json = await res.json() as any;
    const lines: Array<{ from: number; to: number; content: string }> = (json?.body || [])
      .filter((l: any) => l && Number.isFinite(Number(l.from)) && Number.isFinite(Number(l.to)))
      .map((l: any) => ({ from: Number(l.from), to: Number(l.to), content: String(l.content ?? '') }))
      .sort((a, b) => a.from - b.from);
    // 闸门：内容再像也不能替代时间轴证据，对不上就丢弃（B站 会返回别的稿件的字幕）
    const fits = subtitleFits(lines, Number(subtitleState().value?.durationMs || 0));
    if (!fits.ok) {
      return { srt: null, count: 0, lang: pick.lan, reason: `平台返回的字幕与本视频对不上：${fits.reason}` };
    }
    const text = toSrt(lines);
    if (!text.trim()) return { srt: null, count: 0, lang: pick.lan, reason: '字幕正文是空的' };
    const target = videoPath.replace(/\.(mp4|mkv|flv|webm|mov|m4v|ts)$/i, '.srt');
    writeFileSync(target, text, 'utf8');
    // count 是字幕行数（跟弹幕条数同量纲），不是字幕轨数
    return { srt: target, count: lines.length, lang: pick.lan };
  } catch (err) {
    return { srt: null, count: 0, lang: pick.lan, reason: (err as Error).message };
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
    srt: sub.srt, srtCount: sub.count, srtLang: sub.lang || null, srtReason: sub.reason || null,
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
  const isAudio = fmt.id === AUDIO_FORMAT_ID;
  const dest = reserveDest(outDir, isAudio ? `${stem}.m4a` : `${stem}.mp4`);
  try {
  // 仅音频：只下 DASH 的 audio 轨，不碰视频轨。字幕/弹幕对音频没有意义，这里也不取。
  if (isAudio) {
    const audioUrl = urlCache().get(AUDIO_FORMAT_ID)?.audio || '';
    if (!audioUrl) throw new VdlError('no_stream', '这个视频没有音频轨，不能单独下载音频');
    if (existsSync(dest)) return { path: dest, bytes: statSync(dest).size, skipped: true, warnings: [] };

    const aPart = dest + '.audio.m4s';
    const planned = await probeStreamSize(audioUrl);
    await streamTo(audioUrl, aPart, (written, total) => report(written, total), async () => {
      await refresher().value?.();
      return urlCache().get(AUDIO_FORMAT_ID)?.audio || '';
    });
    const got = statSync(aPart).size;
    if (planned > 0 && got < planned * 0.95) {
      throw new VdlError('incomplete_media',
        `音频轨只拿到 ${got} 字节，探测到 ${planned} 字节`, '重试可续传');
    }

    // DASH 音频是 fMP4：`-c copy` 只转封装、不重编码。没有 ffmpeg 时保留原始字节
    // （多数播放器能直接放），但**要说明没转封装**，不能假装已经变成标准 m4a。
    const warnings: string[] = [];
    const tmp = dest.replace(/\.m4a$/i, '.mux.m4a');
    const run = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', aPart, '-vn', '-c', 'copy', tmp]);
    if (run.code === 0 && existsSync(tmp)) {
      renameSync(tmp, dest);
      try { unlinkSync(aPart); } catch { /* ignore */ }
    } else {
      if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* ignore */ } }
      renameSync(aPart, dest);
      warnings.push(run.code === -2
        ? '没有找到 ffmpeg：已保留 DASH 原始音频（多数播放器可播放，但未转封装）'
        : `转封装为 m4a 失败（ffmpeg 退出码 ${run.code}）：已保留 DASH 原始音频`);
    }
    return { path: dest, bytes: statSync(dest).size, skipped: false, warnings };
  }
  const completed = async (skipped: boolean) => {
    // 视频已存在也要让 --subs / --danmaku 生效：附属产物不能因为跳过视频就一起跳过
    const sub = opts.subs ? await saveSubtitle(dest) : { srt: null, count: 0 };
    const dm = opts.danmaku ? await saveDanmaku(dest) : null;
    const cover = opts.cover ? await saveCover(dest, probe.media!.thumbnail, probe.media!.source_url)
      : { cover: null, warnings: [] };
    const warnings = [...cover.warnings];
    // 字幕失败要说清原因：是「平台没有」还是「平台给的是别人的字幕，已丢弃」
    if (opts.subs && !sub.srt) warnings.push(`没有可用字幕：${sub.reason || '未知原因'}（主文件已保留）`);
    if (sub.srt && /^ai-/i.test(sub.lang || '')) {
      warnings.push(`字幕来自平台 AI 自动生成（${sub.lang}），可能与音频不完全一致`);
    }
    if (opts.danmaku && !dm?.xml) warnings.push(dm?.supported
      ? '没有可用弹幕或弹幕获取失败，主文件已保留' : '番剧弹幕暂不支持，主文件已保留');
    return {
      path: dest, bytes: statSync(dest).size, skipped, cover: cover.cover, warnings,
      srt: sub.srt, srtCount: sub.count, srtLang: sub.lang || null, srtReason: sub.reason || null,
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

  // 两条流各记各的字节，进度取「两条之和 / 探测到的总和」。
  // 并行时不能再用「已完成流的 base + 当前流 written」那种算法（两流会同时增长）。
  let vWritten = 0;
  let aWritten = 0;
  const progress = () => report(vWritten + aWritten, planned || vWritten + aWritten);
  // 地址过期时重取一次再续传（同一档位的新地址，不是换档）
  const refetchVideo = async () => {
    await refresher().value?.();
    return urlCache().get(fmt.id)?.video || '';
  };
  const refetchAudio = async () => {
    await refresher().value?.();
    return urlCache().get(fmt.id)?.audio || '';
  };
  const runVideo = () => streamTo(urls.video, vPart, (w) => { vWritten = w; progress(); }, refetchVideo);
  const runAudio = () => streamTo(urls.audio, aPart, (w) => { aWritten = w; progress(); }, refetchAudio);

  // 双轨并行：视频轨通常是大头，音轨几十 MB，并行能把音轨那段时间省掉。
  // **限速时退回串行**——限速按「每条流」算（AGENTS 里写明的边界），
  // 并行会让总带宽翻倍，那等于用户设的限速被悄悄打破。
  if (urls.audio && currentLimitBytesPerSec() <= 0) {
    // allSettled 而不是 all：一条失败时要等另一条收尾，否则函数返回后它还在写 .part，
    // 下次同目标重试会与这个后台写入撞车。
    const [vRes, aRes] = await Promise.allSettled([runVideo(), runAudio()]);
    if (vRes.status === 'rejected') throw vRes.reason;
    if (aRes.status === 'rejected') throw aRes.reason;
  } else {
    await runVideo();
    if (urls.audio) await runAudio();
  }

  const vGot = statSync(vPart).size;
  // 探测到的总字节是同一个 CDN 给的真值：短了就是截断（或被中途降档）。
  // 校验必须放在合并之前——合并成功只说明 ffmpeg 跑通了，不说明内容完整。
  if (vPlanned > 0 && vGot < vPlanned * 0.95) {
    throw new VdlError('incomplete_media',
      `视频轨只拿到 ${vGot} 字节，探测到 ${vPlanned} 字节`,
      '重试可续传；若持续偏小，可能是该清晰度被降级，换档再试');
  }
  if (urls.audio) {
    const aGot = statSync(aPart).size;
    if (aPlanned > 0 && aGot < aPlanned * 0.95) {
      throw new VdlError('incomplete_media',
        `音频轨只拿到 ${aGot} 字节，探测到 ${aPlanned} 字节`,
        '重试可续传');
    }
  }
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
  } finally {
    releaseDest(dest);
  }
}

export const probeBilibiliApi = scopedOperation(probeBilibiliApiImpl);

export const getBilibiliApi = scopedOperation(getBilibiliApiImpl);
