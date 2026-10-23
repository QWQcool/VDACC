/**
 * 酷我音乐（公开接口，无需登录）。
 *
 * 接口来自 docs/music-channels.md 与参考实现 MediaGrabber 的**规格**（域名/参数/字段），
 * 代码独立实现：只走公开的 songinfoandlrc + mobi/antiserver 取址，不逆向签名、不伪造会员。
 * 实测（2026-10-23）：mobi 对公开曲目给 128kbps mp3，Range 可取真实总字节；
 * 无损（br=2000kflac）没有放行，档位以接口实际返回为准。
 */
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { streamToFile, tagAudio } from '../core/audio';
import { VdlError } from '../core/errors';
import { UA, request } from '../core/http';
import { safeName } from '../core/naming';
import { format, type Format, type Media, type ProbeResult } from '../core/types';

const SEARCH = 'http://search.kuwo.cn/r.s?ft=music&itemset=web_2013&client=kt&pn=0&rn=10&rformat=json&encoding=utf8&all=';
const SONG_INFO = 'https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=';
const MOBI = 'https://mobi.kuwo.cn/mobi.s?f=web&source=jiakong&type=convert_url_with_sign&rid=';
const ANTI = 'http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_';
const REFERER = 'https://m.kuwo.cn/';
const SONG_PAGE = 'https://www.kuwo.cn/play_detail/';

interface Candidate {
  id: string; url: string; format: string; bitrate: number; duration: number; source: string;
}

const urlCache = new Map<string, { url: string; ext: string }>();
let lastInfo: { title: string; artist: string; album: string; cover: string; lrc: string } | null = null;

/** `kuwo.cn/play_detail/<rid>`、`?musicId=` / `?rid=`、`MUSIC_<digits>`。 */
export function parseRid(input: string): string {
  const raw = (input || '').trim();
  const bare = /^(?:MUSIC_)?(\d{3,})$/.exec(raw);
  if (bare) return bare[1];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (!/(^|\.)kuwo\.cn$/i.test(url.hostname)) return '';
  for (const key of ['musicId', 'musicid', 'rid']) {
    const m = /^(?:MUSIC_)?(\d{3,})$/.exec((url.searchParams.get(key) || '').trim());
    if (m) return m[1];
  }
  const hit = /\/play_detail\/(\d{3,})/.exec(url.pathname + url.hash);
  return hit ? hit[1] : '';
}

export function canHandle(input: string): boolean {
  return parseRid(input) !== '';
}

function headers(referer = REFERER): Record<string, string> {
  return { Referer: referer, Accept: 'application/json, text/plain, */*' };
}

async function json(url: string): Promise<any> {
  const res = await request(url, { headers: headers() });
  if (!res.ok) throw new VdlError(`http_${res.status}`, `酷我接口 HTTP ${res.status}`);
  return res.json();
}

async function textOf(url: string, referer = REFERER): Promise<string> {
  const res = await request(url, { headers: headers(referer) });
  return res.text();
}

interface SongInfo {
  title: string; artist: string; album: string; pic: string;
  duration: number; lrc: string;
}

/** 酷我搜索返回的是单引号伪 JSON，只能按字段抠。 */
function field(chunk: string, key: string): string {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`['"]${esc}['"]\\s*:\\s*(?:'([^']*)'|"([^"]*)")`).exec(chunk);
  return m ? String(m[1] ?? m[2] ?? '').trim() : '';
}

async function searchMeta(title: string, rid: string): Promise<{ artist: string; album: string; pic: string } | null> {
  try {
    const raw = await textOf(SEARCH + encodeURIComponent(title), 'http://www.kuwo.cn/');
    for (const chunk of raw.split('},{')) {
      const id = field(chunk, 'MUSICRID').replace(/^MUSIC_/, '');
      if (id !== rid) continue;
      const short = field(chunk, 'web_albumpic_short');
      return {
        artist: field(chunk, 'ARTIST'),
        album: field(chunk, 'ALBUM'),
        pic: short ? `https://img1.kuwo.cn/star/albumcover/500/${short.split('/').filter(Boolean).join('/')}` : '',
      };
    }
  } catch {
    // 搜索只是补字段，失败不致命
  }
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** lrclist → LRC。time 是秒（可能是 0），统一格式化成 `[mm:ss.cc]`。 */
export function toLrc(list: Array<{ time?: string | number; lineLyric?: string }>): string {
  return (list || []).map((one) => {
    const sec = Number(one.time);
    const t = Number.isFinite(sec) ? Math.max(0, sec) : 0;
    // 先归一到「百分秒」再拆，避免 12.999 被写成 `[00:12.100]`
    const total = Math.round(t * 100);
    const mm = Math.floor(total / 6000);
    const ss = Math.floor((total % 6000) / 100);
    const cs = total % 100;
    return `[${pad2(mm)}:${pad2(ss)}.${pad2(cs)}]${String(one.lineLyric || '')}`;
  }).join('\n');
}

async function songInfo(rid: string): Promise<SongInfo> {
  let data: any = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const json_ = await json(SONG_INFO + rid);
      data = json_?.data;
      if (data?.songinfo?.songName) break;
      if (data?.simpl?.musiclist?.[0]) break;
    } catch {
      // 重试一次
    }
  }
  const info = data?.songinfo || data?.simpl?.musiclist?.[0] || {};
  const rawLrc: Array<{ time?: string; lineLyric?: string }> = data?.lrclist || [];
  const title = String(info.songName || info.name || '').trim();
  let artist = String(info.artist || '').trim();
  let album = String(info.album || '').trim();
  let pic = String(info.pic || '').trim();
  if (title && (!artist || !album || !pic)) {
    const extra = await searchMeta(title, rid);
    if (extra) {
      artist = artist || extra.artist;
      album = album || extra.album;
      pic = pic || extra.pic;
    }
  }
  // 封面换 500px 档；头像（star/starheads）不当封面
  const cover = pic && !/star\/starheads/i.test(pic)
    ? pic.replace(/^http:/i, 'https:').replace(/\/albumcover\/\d+\//i, '/albumcover/500/')
    : '';
  return {
    title, artist, album, pic: cover,
    duration: Number(info.duration || 0) || 0,
    lrc: rawLrc.length ? toLrc(rawLrc) : '',
  };
}

async function mobi(rid: string): Promise<Candidate | null> {
  try {
    const data = (await json(`${MOBI}${rid}&br=2000kflac`))?.data;
    if (!data?.url) return null;
    return {
      id: 'kuwo-mobi', url: String(data.url), format: String(data.format || ''),
      bitrate: Number(data.bitrate || 0), duration: Number(data.duration || 0), source: 'mobi.s',
    };
  } catch {
    return null;
  }
}

async function anti(rid: string): Promise<Candidate | null> {
  try {
    const value = (await textOf(ANTI + rid)).trim();
    if (!/^https?:\/\//i.test(value)) return null;
    return { id: 'kuwo-anti', url: value, format: '', bitrate: 0, duration: 0, source: 'antiserver' };
  } catch {
    return null;
  }
}

/** Range 探一下：确认是音频，并拿真实总字节（content-range 的 total）。 */
async function probeAudio(url: string): Promise<{ ok: boolean; size: number; reason: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: REFERER, Range: 'bytes=0-15' },
    });
    if (res.status !== 200 && res.status !== 206) return { ok: false, size: 0, reason: `HTTP ${res.status}` };
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    const total = Number(/[/](\d+)\s*$/.exec(String(res.headers.get('content-range') || ''))?.[1] || 0);
    await res.body?.cancel();
    if (/text\/html|application\/json/.test(type)) return { ok: false, size: 0, reason: `不是音频（${type}）` };
    return { ok: true, size: total || Number(res.headers.get('content-length') || 0), reason: '' };
  } catch (err) {
    return { ok: false, size: 0, reason: (err as Error).message };
  }
}

function labelOf(cand: Candidate, size: number, duration: number): { label: string; clip: boolean } {
  const fmt = cand.format.toLowerCase();
  const kbps = cand.bitrate || (size && duration ? Math.round((size * 8) / duration / 1000) : 0);
  if (fmt === 'flac') return { label: 'FLAC 无损', clip: false };
  const clip = kbps > 0 && kbps < 48;
  if (clip) return { label: `试听片段（约 ${Math.round((size * 8) / 128000)}s）`, clip: true };
  if (kbps > 0) return { label: `${kbps}kbps`, clip: false };
  return { label: fmt ? fmt.toUpperCase() : '码率未标注', clip: false };
}

export async function probeKuwo(input: string): Promise<ProbeResult> {
  const rid = parseRid(input);
  if (!rid) throw new VdlError('bad_input', `识别不出酷我音乐 id: ${input}`);
  urlCache.clear();

  const info = await songInfo(rid);
  if (!info.title && !info.artist) {
    throw new VdlError('not_found', `查不到这首曲子（rid=${rid}）`, '确认是酷我音乐的单曲链接');
  }

  const warnings: string[] = [];
  const formats: Format[] = [];
  const candidates = [await mobi(rid), await anti(rid)].filter(Boolean) as Candidate[];
  for (const cand of candidates) {
    const probe = await probeAudio(cand.url);
    if (!probe.ok) {
      warnings.push(`候选地址（${cand.source}）不可用：${probe.reason}`);
      continue;
    }
    if (formats.some((f) => f.id === cand.id)) continue;
    const duration = cand.duration || info.duration;
    const { label, clip } = labelOf(cand, probe.size, duration);
    // mobi 与 antiserver 常指向同一个文件：码率和总字节都一样就当一档，别在界面里列两遍
    if (formats.some((f) => f.bytes === probe.size && f.label === label)) continue;
    if (clip) warnings.push(`「${info.title}」拿到的是试听片段而不是整首，正片可能需要会员`);
    const ext = cand.format.toLowerCase() === 'flac' ? 'flac'
      : cand.format.toLowerCase() === 'aac' ? 'm4a' : 'mp3';
    urlCache.set(cand.id, { url: cand.url, ext });
    formats.push(format({
      id: cand.id,
      label,
      ext,
      acodec: ext,
      bytes: probe.size || null,
      bitrate: (cand.bitrate || 0) * 1000 || null,
    }));
  }

  if (!formats.length) {
    throw new VdlError('need_login', `「${info.title || rid}」没有公开可下载的音频地址`,
      '酷我公开通道只给部分曲目 128kbps；无损/会员曲需要登录，本引擎不逆向签名');
  }
  formats[0].recommended = true;
  lastInfo = { title: info.title, artist: info.artist, album: info.album, cover: info.pic, lrc: info.lrc };

  const media: Media = {
    id: rid,
    title: info.title || `kuwo_${rid}`,
    author: info.artist,
    duration_ms: info.duration ? info.duration * 1000 : null,
    thumbnail: info.pic,
    source_url: SONG_PAGE + rid,
    platform: 'kuwo',
    parts: [],
  };
  return { schema: 2, ok: true, platform: 'kuwo', engine: 'kuwo-web', media, formats, warnings, error: null };
}

export async function getKuwo(input: string, formatId: string | null, outDir: string) {
  const probe = await probeKuwo(input);
  const fmt = probe.formats.find((f) => f.id === formatId) ||
    probe.formats.find((f) => f.recommended) || probe.formats[0];
  const cached = urlCache.get(fmt.id);
  if (!cached) throw new VdlError('no_stream', '该档位没有可用地址');
  const info = lastInfo!;

  mkdirSync(outDir, { recursive: true });
  const stem = `${probe.media!.id}_${safeName(info.title || probe.media!.id)}_${safeName(fmt.label, 16, fmt.id)}`;
  const dest = join(outDir, `${stem}.${cached.ext}`);
  if (existsSync(dest)) {
    return { path: dest, bytes: statSync(dest).size, skipped: true, warnings: [] };
  }

  const part = dest + '.part';
  await streamToFile(cached.url, part, REFERER);
  if (statSync(part).size < 100 * 1024) {
    unlinkSync(part);
    throw new VdlError('bad_payload', '文件过小，多半是试听片段或错误页');
  }
  renameSync(part, dest);

  const warnings: string[] = [];
  if (info.lrc) {
    try { writeFileSync(join(outDir, `${stem}.lrc`), info.lrc + '\n', 'utf8'); } catch { /* 歌词失败不影响音频 */ }
  }
  warnings.push(...await tagAudio({
    dest, title: info.title, artist: info.artist, album: info.album,
    coverUrl: info.cover, referer: REFERER,
  }));
  return { path: dest, bytes: statSync(dest).size, skipped: false, warnings };
}
