import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { throwIfCancelled } from '../core/cancel';
import { VdlError } from '../core/errors';
import { UA } from '../core/http';
import { safeName } from '../core/naming';
import { report } from '../core/progress';
import { format, type Format, type Media, type Part, type ProbeResult } from '../core/types';

const API = 'https://api.bilibili.com';
const BUCKETS: Array<[number, string]> = [
  [3840, '4K'], [2560, '2K'], [1920, '1080P'], [1280, '720P'], [854, '480P'],
];

const urlCache = new Map<string, { video: string; audio: string }>();

/** 供下载前预览：只取视频轨（浏览器预览不需要音轨）。 */
export function previewBilibili(formatId: string): string {
  return urlCache.get(formatId)?.video || '';
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
      label: BUCKETS.find(([l]) => l === limit)?.[1] || `${best.height}P`,
      width: Number(best.width || 0), height: Number(best.height || 0),
      ext: 'mp4', vcodec: String(best.codecs || '').split('.')[0],
      acodec: bestAudio ? String(bestAudio.codecs || '').split('.')[0] : '',
      fps: Number(best.frameRate || 0) || 0,
      bytes: Math.round((totalBw * seconds) / 8) || null,
      bitrate: Math.round(totalBw) || null,
    }));
    urlCache.set(id, {
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

export async function probeBilibiliApi(input: string): Promise<ProbeResult> {
  urlCache.clear();
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

async function streamTo(url: string, part: string): Promise<number> {
  let resume = existsSync(part) ? statSync(part).size : 0;
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
  if (resume) headers.Range = `bytes=${resume}-`;
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) throw new VdlError(`http_${res.status}`, `下载失败 ${res.status}`);
  if (resume && res.status !== 206) resume = 0;
  const total = Number(res.headers.get('content-length') || 0) + resume;
  const fh = await open(part, resume ? 'a' : 'w');
  let written = resume;
  let last = 0;
  try {
    for await (const chunk of res.body as any) {
      throwIfCancelled();
      await fh.write(chunk);
      written += chunk.length;
      const now = Date.now();
      if (now - last > 200) { last = now; report(written, total); }
    }
  } finally {
    await fh.close();
  }
  report(written, total || written);
  return statSync(part).size;
}

export async function getBilibiliApi(input: string, formatId: string | null, outDir: string) {
  const probe = await probeBilibiliApi(input);
  const fmt = probe.formats.find((f) => f.id === formatId) ||
    probe.formats.find((f) => f.recommended) || probe.formats[0];
  const urls = urlCache.get(fmt.id);
  if (!urls) throw new VdlError('no_stream', '该档位没有可用地址');

  mkdirSync(outDir, { recursive: true });
  const selected = probe.media!.parts.find((p) => p.selected);
  const suffix = probe.media!.parts.length > 1 && selected
    ? `_${probe.media!.id.startsWith('ep') ? 'EP' : 'P'}${selected.index}` : '';
  const stem = `${probe.media!.id}_${safeName(probe.media!.title)}${suffix}_${safeName(fmt.label, 16, fmt.id)}`;
  const dest = join(outDir, `${stem}.mp4`);
  if (existsSync(dest)) return { path: dest, bytes: statSync(dest).size, skipped: true };

  const vPart = dest + '.video.m4s';
  const aPart = dest + '.audio.m4s';
  await streamTo(urls.video, vPart);
  if (urls.audio) await streamTo(urls.audio, aPart);

  const ff = process.env.VDL_FFMPEG || 'ffmpeg';
  const args = urls.audio
    ? ['-y', '-hide_banner', '-loglevel', 'error', '-i', vPart, '-i', aPart, '-c', 'copy', dest]
    : ['-y', '-hide_banner', '-loglevel', 'error', '-i', vPart, '-c', 'copy', dest];
  const run = spawnSync(ff, args, { encoding: 'utf8', windowsHide: true });
  for (const p of [vPart, aPart]) { try { unlinkSync(p); } catch { /* ignore */ } }
  if (run.status !== 0) throw new VdlError('ffmpeg_missing', String(run.stderr || '').slice(0, 300));

  return { path: dest, bytes: statSync(dest).size, skipped: false };
}
