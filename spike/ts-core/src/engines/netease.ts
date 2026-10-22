import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { VdlError } from '../core/errors';
import { UA } from '../core/http';
import { format, type Format, type ProbeResult } from '../core/types';

const API = 'https://music.163.com';
const LEVELS: Array<[number, string, string]> = [
  [999000, 'lossless', '无损 FLAC'],
  [320000, 'exhigh', '极高 320K'],
];

export const formatUrls = new Map<string, string>();

function cookieHeader(): string {
  const path = join(process.env.LOCALAPPDATA || '', 'vdl', 'auth', 'netease.json');
  if (!existsSync(path)) return '';
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return (state.cookies || [])
      .map((c: any) => `${c.name}=${c.value}`)
      .join('; ');
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

export async function probeNetease(url: string): Promise<ProbeResult> {
  const sid = extractId(url);
  if (!sid) throw new VdlError('bad_input', `识别不出歌曲 ID: ${url}`);
  const cookie = cookieHeader();

  const detailRes = await fetch(`${API}/api/song/detail/?id=${sid}&ids=%5B${sid}%5D`, {
    headers: headers(cookie),
  });
  const detail = await detailRes.json() as any;
  const song = (detail.songs || [])[0];
  if (!song) throw new VdlError('filtered', `查不到这首歌（id=${sid}）`);

  const formats: Format[] = [];
  for (const [br, level, label] of LEVELS) {
    const q = new URLSearchParams({ ids: `[${sid}]`, br: String(br) });
    const res = await fetch(`${API}/api/song/enhance/player/url?${q}`, { headers: headers(cookie) });
    const data = await res.json() as any;
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
    formatUrls.set(level, item.url);
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
