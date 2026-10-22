import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { VdlError } from '../core/errors';
import { UA } from '../core/http';
import { safeName } from '../core/naming';
import { format, type Format, type ProbeResult } from '../core/types';

const API = 'https://api.bilibili.com';
const BUCKETS: Array<[number, string]> = [
  [3840, '4K'], [2560, '2K'], [1920, '1080P'], [1280, '720P'], [854, '480P'],
];
const QN_LABEL: Record<number, string> = {
  120: '4K', 116: '1080P60', 112: '1080P+', 80: '1080P',
  74: '720P60', 64: '720P', 32: '480P', 16: '360P',
};

const urlCache = new Map<string, { video: string; audio: string }>();

function cookieHeader(): string {
  const path = join(process.env.LOCALAPPDATA || '', 'vdl', 'auth', 'bilibili.json');
  if (!existsSync(path)) return '';
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return (state.cookies || []).map((c: any) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function apiJson(path: string): Promise<any> {
  const headers: Record<string, string> = {
    'User-Agent': UA, Referer: 'https://www.bilibili.com/',
  };
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(API + path, { headers });
  const data = await res.json() as any;
  if (data?.code !== 0) {
    throw new VdlError('download_failed', `B站接口 ${path.split('?')[0]} code=${data?.code} ${data?.message || ''}`);
  }
  return data.data;
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

function normalize(url: string): string {
  const raw = (url || '').trim();
  if (/^BV[0-9A-Za-z]{10}$/.test(raw)) return `https://www.bilibili.com/video/${raw}`;
  return raw;
}

export async function probeBilibiliApi(input: string): Promise<ProbeResult> {
  const url = normalize(input);
  const m = /(BV[0-9A-Za-z]{10})/.exec(url);
  if (!m) throw new VdlError('bad_input', `识别不出 BV 号: ${input}`);
  const bvid = m[1];

  const view = await apiJson(`/x/web-interface/view?bvid=${bvid}`);
  const play = await apiJson(
    `/x/player/playurl?bvid=${bvid}&cid=${view.cid}&qn=120&fnval=4048&fourk=1`);
  const dash = play?.dash;
  if (!dash) throw new VdlError('no_stream', '没有 DASH 流（可能需要登录或该视频受限）');

  const durationMs = Number(play.timelength || 0) || Number(view.duration || 0) * 1000;
  const seconds = durationMs / 1000;

  const videos: any[] = dash.video || [];
  const audios: any[] = dash.audio || [];
  const bestAudio = audios.sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0];
  if (!videos.length) throw new VdlError('no_stream', '没有视频轨');

  // 同一宽度桶可能有多个 qn/编码，按「兼容性优先，再比带宽」挑一个
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
      // 标清桶沿用「实际高度 P」，与 yt-dlp 的标签一致
      label: BUCKETS.find(([l]) => l === limit)?.[1] || `${best.height}P`,
      width: Number(best.width || 0), height: Number(best.height || 0),
      ext: 'mp4', vcodec: String(best.codecs || '').split('.')[0],
      acodec: bestAudio ? String(bestAudio.codecs || '').split('.')[0] : '',
      fps: Number(best.frameRate || 0) || 0,
      // 码率 × 时长估算，与 yt-dlp 的 filesize_approx 同源
      bytes: Math.round((totalBw * seconds) / 8) || null,
      bitrate: Math.round(totalBw) || null,
    }));
    urlCache.set(id, {
      video: best.baseUrl || best.base_url,
      audio: bestAudio ? (bestAudio.baseUrl || bestAudio.base_url) : '',
    });
  }
  out[0].recommended = true;

  return {
    schema: 2, ok: true, platform: 'bilibili', engine: 'bilibili-api',
    media: {
      id: bvid,
      title: view.title || 'B站视频',
      author: view.owner?.name || '',
      duration_ms: durationMs || null,
      thumbnail: view.pic || '',
      source_url: `https://www.bilibili.com/video/${bvid}`,
      platform: 'bilibili',
      parts: (view.pages || []).length > 1
        ? (view.pages as any[]).map((p) => ({
          index: Number(p.page || 0), title: p.part || '', duration_ms: Number(p.duration || 0) * 1000,
          url: `https://www.bilibili.com/video/${bvid}?p=${p.page}`, selected: Number(p.page) === 1,
        }))
        : [],
    },
    formats: out, warnings: [], error: null,
  };
}

async function streamTo(url: string, part: string): Promise<number> {
  let resume = existsSync(part) ? statSync(part).size : 0;
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
  if (resume) headers.Range = `bytes=${resume}-`;
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) throw new VdlError(`http_${res.status}`, `下载失败 ${res.status}`);
  if (resume && res.status !== 206) resume = 0;
  const fh = await open(part, resume ? 'a' : 'w');
  try {
    for await (const chunk of res.body as any) await fh.write(chunk);
  } finally {
    await fh.close();
  }
  return statSync(part).size;
}

export async function getBilibiliApi(input: string, formatId: string | null, outDir: string) {
  const probe = await probeBilibiliApi(input);
  const fmt = probe.formats.find((f) => f.id === formatId) ||
    probe.formats.find((f) => f.recommended) || probe.formats[0];
  const urls = urlCache.get(fmt.id);
  if (!urls) throw new VdlError('no_stream', '该档位没有可用地址');

  mkdirSync(outDir, { recursive: true });
  const stem = `${probe.media!.id}_${safeName(probe.media!.title)}_${safeName(fmt.label, 16, fmt.id)}`;
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
