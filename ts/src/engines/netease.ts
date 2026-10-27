import { operationState, scopedOperation } from '../core/operation';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { AlbumInfo, AlbumTrack } from '../core/album';
import { throwIfCancelled } from '../core/cancel';
import { releaseDest, reserveDest } from '../core/dest';
import { VdlError } from '../core/errors';
import { runFfmpeg } from '../core/ffmpeg';
import { UA } from '../core/http';
import { safeName } from '../core/naming';
import { report } from '../core/progress';
import { throttle } from '../core/rate';
import { format, type Format, type ProbeResult } from '../core/types';

const API = 'https://music.163.com';
const LEVELS: Array<[number, string, string]> = [
  [999000, 'lossless', '无损 FLAC'],
  [320000, 'exhigh', '极高 320K'],
];

const formatUrls = operationState(() => new Map<string, string>());
const songState = operationState(() => ({ lastSong: null as any }));

function cookieHeader(): string {
  const path = join(process.env.LOCALAPPDATA || '', 'vdl', 'auth', 'netease.json');
  if (!existsSync(path)) return '';
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return (state.cookies || []).map((c: any) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

function headers(cookie: string): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': UA, Referer: API + '/' };
  if (cookie) h.Cookie = cookie;
  return h;
}

function extractId(url: string): string {
  const raw = (url || '').trim();
  if (/^\d+$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const id = u.searchParams.get('id');
    if (id && /^\d+$/.test(id)) return id;
    const m = /\/song\/(\d+)/.exec(u.pathname);
    if (m) return m[1];
  } catch {
    return '';
  }
  return '';
}

async function headSize(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: headers('') });
    const value = Number(res.headers.get('content-length') || 0);
    return value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function getJson(path: string, cookie: string): Promise<any> {
  const res = await fetch(API + path, { headers: headers(cookie) });
  if (!res.ok) throw new VdlError('network', `网易云接口 HTTP ${res.status}`);
  return res.json();
}

/** 专辑链接：`/album?id=123`、`/album/123`、`#/album?id=123`，或裸数字 ID。 */
export function parseAlbumId(input: string): string {
  const raw = (input || '').trim();
  if (/^\d+$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    // 分享链接常是 `/#/album?id=123`：id 在 hash 里，search 是空的
    if (/\/album\b/.test(u.hash)) {
      const q = new URLSearchParams(u.hash.split('?')[1] || '');
      const id = q.get('id') || '';
      if (/^\d+$/.test(id)) return id;
    }
    // 只认 album 路径：`/song?id=` 里的 id 是歌曲，拿来当专辑会下错东西
    if (/\/album\b/.test(u.pathname)) {
      const id = u.searchParams.get('id') || '';
      if (/^\d+$/.test(id)) return id;
      const m = /\/album\/(\d+)/.exec(u.pathname);
      if (m) return m[1];
    }
    return '';
  } catch {
    return '';
  }
}

/** 专辑曲目列表。返回空列表时抛错，不拿“空专辑”冒充成功。 */
export async function albumTracks(input: string): Promise<AlbumInfo> {
  const id = parseAlbumId(input);
  if (!id) throw new VdlError('bad_input', `识别不出网易云专辑 ID: ${input}`);
  const data = await getJson(`/api/album/${id}`, cookieHeader());
  const album = data?.album || {};
  const songs: any[] = album.songs || [];
  if (!songs.length) {
    throw new VdlError('not_found', `专辑里没有可下载的曲目（id=${id}）`,
      '可能是地区限制或接口限流，稍后重试');
  }
  return {
    id,
    title: String(album.name || `album_${id}`),
    cover: String(album.picUrl || ''),
    tracks: songs.map((s: any) => ({
      id: String(s.id || ''),
      title: String(s.name || ''),
      author: (s.artists || s.ar || []).map((a: any) => String(a.name || '')).filter(Boolean).join(' / '),
      url: `${API}/song?id=${s.id}`,
    })).filter((t: AlbumTrack) => t.id),
  };
}

async function probeNeteaseImpl(url: string): Promise<ProbeResult> {
  const sid = extractId(url);
  if (!sid) throw new VdlError('bad_input', `识别不出歌曲 ID: ${url}`);
  const cookie = cookieHeader();
  formatUrls().clear();
  songState().lastSong = null;

  const detail = await getJson(`/api/song/detail/?id=${sid}&ids=%5B${sid}%5D`, cookie);
  const song = (detail.songs || [])[0];
  if (!song) throw new VdlError('filtered', `查不到这首歌（id=${sid}）`);
  songState().lastSong = song;

  const formats: Format[] = [];
  for (const [br, level, label] of LEVELS) {
    const data = await getJson(
      `/api/song/enhance/player/url?ids=%5B${sid}%5D&br=${br}`, cookie);
    const item = (data.data || [])[0];
    if (!item || Number(item.code) !== 200 || !item.url) continue;
    const real = await headSize(item.url);
    if (real) item.size = real;
    const ext = String(item.type || 'mp3').toLowerCase();
    formats.push(format({
      id: level, label, ext, acodec: ext,
      bytes: Number(item.size || 0) || null,
      bitrate: Number(item.br || 0) || null,
    }));
    formatUrls().set(level, item.url);
  }
  if (!formats.length) {
    throw new VdlError(cookie ? 'filtered' : 'need_login', '这首歌没有可播放地址');
  }
  formats[0].recommended = true;

  const album = song.album || {};
  const artists = (song.artists || []).map((a: any) => a.name || '').filter(Boolean);
  return {
    schema: 2, ok: true, platform: 'netease', engine: 'netease-api',
    media: {
      id: String(sid),
      title: song.name || `netease_${sid}`,
      author: artists.join(' / '),
      duration_ms: Number(song.duration || 0) || null,
      thumbnail: album.picUrl || '',
      source_url: `${API}/song?id=${sid}`,
      platform: 'netease', parts: [],
    },
    formats, warnings: [], error: null,
  };
}

async function streamTo(url: string, part: string): Promise<number> {
  let resume = existsSync(part) ? statSync(part).size : 0;
  const headersNext: Record<string, string> = { 'User-Agent': UA, Referer: API + '/' };
  if (resume) headersNext.Range = `bytes=${resume}-`;
  const res = await fetch(url, { headers: headersNext });
  if (!res.ok && res.status !== 206) throw new VdlError(`http_${res.status}`, `下载失败 ${res.status}`);
  if (resume && res.status !== 206) resume = 0;

  const total = Number(res.headers.get('content-length') || 0) + resume;
  const fh = await open(part, resume ? 'a' : 'w');
  let written = resume;
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
      if (now - last > 200) { last = now; report(written, total); }
    }
  } finally {
    await fh.close();
  }
  report(written, total || written);
  return statSync(part).size;
}



async function getNeteaseImpl(input: string, formatId: string | null, outDir: string) {
  const probe = await probeNetease(input);
  const fmt = probe.formats.find((f) => f.id === formatId) ||
    probe.formats.find((f) => f.recommended) || probe.formats[0];
  const url = formatUrls().get(fmt.id);
  if (!url) throw new VdlError('no_stream', '该档位没有可用地址');
  const song = songState().lastSong || {};

  mkdirSync(outDir, { recursive: true });
  const label = safeName(fmt.label, 14, fmt.id);
  const dest = reserveDest(outDir,
    `${probe.media!.id}_${safeName(probe.media!.title)}_${label}.${fmt.ext}`);
  try {
  if (existsSync(dest)) {
    return { path: dest, bytes: statSync(dest).size, skipped: true, warnings: [] };
  }

  const part = dest + '.part';
  await streamTo(url, part);
  if (statSync(part).size < 100 * 1024) {
    unlinkSync(part);
    throw new VdlError('bad_payload', '文件过小，多半是试听片段或错误页');
  }

  // 歌词单独落 .lrc（ID3 的 USLT 各播放器支持不一）
  try {
    const lyric = await getJson(
      `/api/song/lyric?id=${probe.media!.id}&lv=1&kv=1&tv=-1`, cookieHeader());
    const text = String((lyric.lrc || {}).lyric || '').trim();
    if (text) writeFileSync(dest.replace(/\.\w+$/, '.lrc'), text + '\n', 'utf8');
  } catch {
    // 歌词失败不影响音频
  }

  const warnings: string[] = [];
  // 临时封面必须跟着目标文件走：固定名在并发下载时会互相覆盖
  const rawCover = dest + '.cover.img';
  const smallCover = dest + '.cover.jpg';
  let coverPath = '';

  const pic = (song.album || {}).picUrl || '';
  if (pic) {
    try {
      const res = await fetch(pic, { headers: { 'User-Agent': UA } });
      writeFileSync(rawCover, Buffer.from(await res.arrayBuffer()));
      // 原图常是 1920×1920 PNG（5MB+），缩到 800px JPEG 再内嵌
      const scaled = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error',
        '-i', rawCover, '-vf', "scale='min(800,iw)':-2", '-q:v', '3', smallCover]);
      coverPath = scaled.code === 0 ? smallCover : rawCover;
    } catch {
      coverPath = existsSync(rawCover) ? rawCover : '';
    }
  }

  const out = dest.replace(/(\.\w+)$/, '.mux$1');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', part];
  if (coverPath) args.push('-i', coverPath);
  args.push('-map', '0:a');
  if (coverPath) args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  args.push('-c:a', 'copy');

  const published = Number(song.publishTime || 0);
  const year = published
    ? String(new Date(published > 1e11 ? published : published * 1000).getFullYear())
    : '';
  const tags: Record<string, string> = {
    title: song.name || '',
    artist: (song.artists || []).map((a: any) => a.name || '').join(' / '),
    album: (song.album || {}).name || '',
    date: year,
    comment: 'downloaded by vdl',
  };
  for (const [key, value] of Object.entries(tags)) {
    if (value) args.push('-metadata', `${key}=${value}`);
  }
  if (dest.toLowerCase().endsWith('.mp3')) args.push('-id3v2_version', '3');
  args.push(out);

  const run = await runFfmpeg(args);
  for (const temp of [rawCover, smallCover]) {
    try { unlinkSync(temp); } catch { /* ignore */ }
  }

  if (run.code === 0 && existsSync(out)) {
    renameSync(out, dest);
    try { unlinkSync(part); } catch { /* ignore */ }
  } else {
    if (existsSync(out)) { try { unlinkSync(out); } catch { /* ignore */ } }
    renameSync(part, dest);
    warnings.push('写入标签失败，已保留音频');
  }

  return { path: dest, bytes: statSync(dest).size, skipped: false, warnings };
  } finally {
    releaseDest(dest);
  }
}

export function previewNetease(formatId: string): string {
  return formatUrls().get(formatId) || "";
}

export const probeNetease = scopedOperation(probeNeteaseImpl);

export const getNetease = scopedOperation(getNeteaseImpl);
