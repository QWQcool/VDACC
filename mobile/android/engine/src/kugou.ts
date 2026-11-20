/**
 * 酷狗音乐（端上，M3）。公开接口，无需登录。
 *
 * 公开链路：`getSongInfo` 给 128kbps 地址；320K/SQ 是否放行由搜索接口的
 * `pay_type_320` / `pay_type_sq` 决定，付费曲 trackerCdn 会直接不给地址。
 * 与桌面端一致：**三种情况必须分开说**（档位信息取不到 / 搜不到这首 / 平台明确标付费），
 * 旧实现把它们混成「未放行」，既冤枉了正常可下的公开档，也把猜测当结论。
 *
 * 端上不做 `.kgm` 解密、不伪造会员、不支持登录。
 */
import { request } from '../../../../ts/src/core/http';
import { VdlError } from '../../../../ts/src/core/errors';
import { safeName } from '../../../../ts/src/core/naming';
import { format, type Format, type ProbeResult } from '../../../../ts/src/core/types';
import type { AlbumInfo, AlbumTrack } from '../../../../ts/src/core/album';
import { bareNumericId, emptyCollection } from '../../../../ts/src/core/collection';
import { collectPages } from '../../../../ts/src/core/paging';
import { md5Hex } from '../shims/md5';
import {
  assertNotTruncated, downloadToStaging, type MusicHooks, probeAudioUrl, publishStaged,
  stemOf, tagStaged,
} from './music-common';

const SONG_INFO = 'https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=';
const SEARCH = 'https://mobiles.kugou.com/api/v3/search/song?format=json&keyword=';
const TRACKER = 'http://trackercdn.kugou.com/i/?cmd=4&pid=1&acceptMp3=1&hash=';
const REFERER = 'https://m.kugou.com/';
const SONG_PAGE = 'https://www.kugou.com/song/#hash=';

type Candidate = { id: string; url: string; ext: string; bitrate: number; size: number; source: string };
type Cached = { url: string; ext: string; expected: number };

/** `?hash=` / `#hash=` / 裸 32 位 hex。 */
export function parseHash(input: string): string {
  const raw = (input || '').trim();
  if (/^[0-9a-f]{32}$/i.test(raw)) return raw.toLowerCase();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (!/(^|\.)kugou\.com$/i.test(url.hostname)) return '';
  const direct = (url.searchParams.get('hash') || url.searchParams.get('h') || '').trim();
  if (/^[0-9a-f]{32}$/i.test(direct)) return direct.toLowerCase();
  // 分享链接常把 hash 放在 fragment 里：`/song/#hash=xxx`
  const frag = url.hash.replace(/^#\/?/, '');
  const m = /(?:^|[?&])hash=([0-9a-f]{32})/i.exec(frag);
  return m ? m[1].toLowerCase() : '';
}

function headers(): Record<string, string> {
  return { Referer: REFERER, Accept: 'application/json, text/plain, */*' };
}

async function json(url: string): Promise<any> {
  const res = await request(url, { headers: headers(), timeoutMs: 20_000 });
  if (!res.ok) throw new VdlError(`http_${res.status}`, `酷狗接口 HTTP ${res.status}`);
  return res.json();
}

/** trackerCdn 的 key 是 `md5(hash + 'kgcloud')`（公开规则，与桌面端同一实现）。 */
function trackerKey(hash: string): string {
  return md5Hex(hash + 'kgcloud');
}

async function trackerCdn(hash: string): Promise<{ url: string; ext: string; bitrate: number; size: number } | null> {
  try {
    const data = await json(`${TRACKER}${hash}&key=${trackerKey(hash)}`);
    if (Number(data?.status) !== 1 || !data?.url) return null;
    const ext = String(data.extName || '').toLowerCase() === 'flac' ? 'flac' : 'mp3';
    return { url: String(data.url), ext, bitrate: Number(data.bitRate || 0), size: Number(data.fileSize || 0) };
  } catch {
    return null;
  }
}

type QualityResult = {
  status: 'ok' | 'notfound' | 'failed';
  sq?: { hash: string; size: number };
  hq?: { hash: string; size: number };
  /** 平台把 320K/无损标成付费（pay_type≠0）：这是接口给的证据，不是我们的推断 */
  paid: boolean;
};

async function searchQualities(title: string, artist: string, hash: string): Promise<QualityResult> {
  if (!title) return { status: 'notfound', paid: false };
  try {
    const data = await json(`${SEARCH}${encodeURIComponent(`${title} ${artist}`.trim())}&page=1&pagesize=20`);
    const list: any[] = data?.data?.info || [];
    const hit = list.find((one) => String(one?.hash || '').toLowerCase() === hash);
    if (!hit) return { status: 'notfound', paid: false };
    const out: QualityResult = { status: 'ok', paid: false };
    const paySq = Number(hit.pay_type_sq || 0);
    const pay320 = Number(hit.pay_type_320 || hit['pay_type320'] || 0);
    out.paid = paySq !== 0 || pay320 !== 0;
    const sq = String(hit.sqhash || '').toLowerCase();
    const hq = String(hit['320hash'] || '').toLowerCase();
    if (/^[0-9a-f]{32}$/.test(sq) && paySq === 0) {
      out.sq = { hash: sq, size: Number(hit.sqfilesize || 0) };
    }
    if (/^[0-9a-f]{32}$/.test(hq) && pay320 === 0) {
      out.hq = { hash: hq, size: Number(hit['320filesize'] || 0) };
    }
    return out;
  } catch {
    // 搜索只是补档位，失败不致命；但要如实说「取不到」而不是「没放行」
    return { status: 'failed', paid: false };
  }
}

export type KugouProbeInternal = {
  probe: ProbeResult;
  urls: Map<string, Cached>;
  info: { title: string; artist: string; album: string; cover: string };
};

export async function probeImpl(input: string): Promise<KugouProbeInternal> {
  const hash = parseHash(input);
  if (!hash) throw new VdlError('bad_input', `识别不出酷狗 hash: ${input}`);
  const urls = new Map<string, Cached>();

  let info: any = null;
  try {
    info = await json(SONG_INFO + hash);
  } catch (error) {
    throw new VdlError('network', `酷狗接口失败：${(error as Error).message}`);
  }
  if (!info || (info.errcode && Number(info.errcode) !== 0) || (!info.songName && !info.fileName)) {
    throw new VdlError('not_found', `查不到这首曲子（hash=${hash.slice(0, 8)}…）`);
  }

  const title = String(info.songName || info.fileName || '').trim();
  const artist = String(info.author_name || info.singerName || info.choricSinger || '').trim();
  const album = String(info.albumName || info.album_name || '').trim();
  const cover = String(info.album_img || '').replace('{size}', '500').replace(/^http:/i, 'https:');

  const warnings: string[] = [];
  const candidates: Candidate[] = [];

  const quality = await searchQualities(title, artist, hash);
  if (quality.sq) {
    const got = await trackerCdn(quality.sq.hash);
    if (got) candidates.push({ id: 'kg-flac', url: got.url, ext: 'flac', bitrate: got.bitrate, size: got.size || quality.sq.size, source: 'trackercdn SQ' });
    else warnings.push('SQ(FLAC) 取址失败，已跳过');
  }
  if (quality.hq) {
    const got = await trackerCdn(quality.hq.hash);
    if (got) candidates.push({ id: 'kg-320', url: got.url, ext: got.ext, bitrate: got.bitrate || 320000, size: got.size || quality.hq.size, source: 'trackercdn 320' });
  }
  if (!quality.sq && !quality.hq) {
    if (quality.status === 'failed') {
      warnings.push('档位信息获取失败（搜索接口异常），本次只尝试公开档——不代表没有 320K/无损');
    } else if (quality.status === 'notfound') {
      warnings.push('搜索结果里没有这首曲，本次只尝试公开档——不代表没有 320K/无损');
    } else if (quality.paid) {
      warnings.push('320K/无损 未放行（接口标记为付费：pay_type≠0），本次只尝试公开档');
    } else {
      warnings.push('320K/无损 本次没有拿到地址，只尝试公开档');
    }
  }

  const plain = String(info.url || '').trim();
  if (plain) {
    candidates.push({
      id: 'kg-128', url: plain, ext: String(info.extName || 'mp3').toLowerCase(),
      bitrate: Number(info.bitRate || 0) * 1000, size: Number(info.fileSize || 0), source: 'getSongInfo',
    });
  }

  const formats: Format[] = [];
  for (const cand of candidates) {
    const audio = await probeAudioUrl(cand.url, REFERER);
    if (!audio.ok) {
      warnings.push(`候选地址（${cand.source}）不可用：${audio.reason}`);
      continue;
    }
    urls.set(cand.id, { url: cand.url, ext: cand.ext, expected: audio.size });
    const kbps = Math.round(cand.bitrate / 1000);
    formats.push(format({
      id: cand.id,
      label: cand.ext === 'flac' ? 'FLAC 无损' : kbps > 0 ? `${kbps}kbps` : '码率未标注',
      ext: cand.ext,
      acodec: cand.ext,
      bytes: audio.size || cand.size || null,
      bitrate: cand.bitrate || null,
    }));
  }

  if (!formats.length) {
    throw new VdlError('filtered', `「${title || hash.slice(0, 8)}」没有可下载的音频地址`,
      '酷狗公开通道对受限曲目只给封面与信息；端上不做 .kgm 解密、不伪造会员，也不支持登录');
  }
  formats[0].recommended = true;

  const probe: ProbeResult = {
    schema: 2,
    ok: true,
    platform: 'kugou',
    engine: 'kugou-web-mobile',
    media: {
      id: hash,
      title: title || `kugou_${hash.slice(0, 8)}`,
      author: artist,
      duration_ms: Number(info.timeLength || 0) ? Number(info.timeLength) * 1000 : null,
      thumbnail: cover,
      source_url: SONG_PAGE + hash,
      platform: 'kugou',
      parts: [],
    },
    formats,
    warnings,
    error: null,
  };
  return { probe, urls, info: { title, artist, album, cover } };
}

export async function probeKugou(input: string): Promise<ProbeResult> {
  return (await probeImpl(input)).probe;
}

export async function downloadKugou(
  input: string,
  formatId: string | null,
  hooks: MusicHooks = {},
) {
  const started = Date.now();
  const { probe, urls, info } = await probeImpl(input);

  const wanted = (formatId || '').trim();
  let fmt: Format | undefined;
  if (wanted) {
    fmt = probe.formats.find((f) => f.id === wanted);
    if (!fmt) {
      const usable = probe.formats.map((f) => f.id).join('、') || '无';
      throw new VdlError('no_stream', `该曲没有 ${wanted} 档`, `可用档位：${usable}——不会自动换档`);
    }
  } else {
    fmt = probe.formats.find((f) => f.recommended) || probe.formats[0];
  }
  if (!fmt) throw new VdlError('no_stream', '没有可用档位');
  const cached = urls.get(fmt.id);
  if (!cached) throw new VdlError('no_stream', '该档位没有可用地址');

  // 文件名用 hash 前 8 位（酷狗 hash 是 32 位，全放进去会挤掉标题）
  const stem = stemOf(probe.media!.id.slice(0, 8), info.title || probe.media!.id, fmt.label, safeName);
  const name = `${stem}.${cached.ext}`;

  const { bytes, resumeFrom } = await downloadToStaging(cached.url, name, REFERER, {
    onProgress: (written, total) => {
      const planned = cached.expected || total;
      hooks.onProgress?.(written, planned || total);
    },
    onReady: hooks.onReady,
  });
  assertNotTruncated(bytes, cached.expected, '音频');

  const warnings = await tagStaged(name, {
    title: info.title, artist: info.artist, album: info.album,
  }, info.cover ? { url: info.cover, referer: REFERER } : null);
  const published = await publishStaged(name);
  if (published.note) warnings.push(published.note);

  return {
    path: published.path,
    bytes: published.bytes,
    name,
    label: fmt.label,
    resumeFrom,
    ms: Date.now() - started,
    warnings,
  };
}

// —— 列表入口（歌单 / 专辑）——
// 桌面端 2026-11-11 / 11-16 已实测；端上同一批公开接口，无需登录。
// 端上之前只接 网易云/QQ，酷狗会报 unsupported，这是补齐的那一块。

const PLAYLIST_PAGE = 100;
const SPECIAL_INFO = 'https://mobiles.kugou.com/api/v3/special/info';
const SPECIAL_SONG = 'https://mobiles.kugou.com/api/v3/special/song';
const ALBUM_INFO = 'https://mobiles.kugou.com/api/v3/album/info';
const ALBUM_SONG = 'https://mobiles.kugou.com/api/v3/album/song';

/** 酷狗把「歌手 - 歌名」塞在 `filename` 里（没有独立字段）。 */
function splitFilename(filename: string): { title: string; author: string } {
  const at = filename.lastIndexOf(' - ');
  if (at <= 0) return { title: filename.trim(), author: '' };
  return { title: filename.slice(at + 3).trim(), author: filename.slice(0, at).trim() };
}

function toTracks(raws: unknown[]): AlbumTrack[] {
  return (raws as any[]).map((song) => {
    const hash = String(song?.hash || '').toLowerCase();
    const { title, author } = splitFilename(String(song?.filename || ''));
    return {
      id: hash,
      title,
      author,
      url: SONG_PAGE + hash,
      duration_ms: Number(song?.duration || 0) ? Number(song.duration) * 1000 : null,
    };
  }).filter((t: AlbumTrack) => t.id);
}

function coverUrl(imgurl: string): string {
  return String(imgurl || '').replace('{size}', '240').replace(/^http:/i, 'https:');
}

/** 歌单：`/special/single/<id>.html`、`/plist/list/<id>`、`?specialid=`、裸数字。 */
export function parsePlaylistId(input: string): string {
  const bare = bareNumericId(input);
  if (bare) return bare;
  let u: URL;
  try {
    u = new URL((input || '').trim());
  } catch {
    return '';
  }
  if (!/(^|\.)kugou\.com$/i.test(u.hostname)) return '';
  if (/\/album\//i.test(u.pathname)) return '';
  const fromQuery = u.searchParams.get('specialid') || u.searchParams.get('plistid') || '';
  if (/^\d+$/.test(fromQuery)) return fromQuery;
  const m = /\/(?:special\/single|plist\/list)\/(\d+)/i.exec(u.pathname);
  return m ? m[1] : '';
}

export async function playlistTracks(input: string): Promise<AlbumInfo> {
  const id = parsePlaylistId(input);
  if (!id) throw new VdlError('bad_input', `识别不出酷狗歌单 ID: ${input}`);

  const meta = await json(`${SPECIAL_INFO}?specialid=${id}&format=json`);
  const info = meta?.data || {};
  const collected = await collectPages({
    pageSize: PLAYLIST_PAGE,
    keyOf: (song: any) => String(song?.hash || '').toLowerCase(),
    fetchPage: async (cursor, size) => {
      const page = await json(
        `${SPECIAL_SONG}?specialid=${id}&page=${Math.floor(cursor / size) + 1}&pagesize=${size}&format=json`,
      );
      return { raws: Array.isArray(page?.data?.info) ? page.data.info : [], total: page?.data?.total };
    },
  });

  const tracks = toTracks(collected.raws);
  if (!tracks.length) {
    const declared = Number(info.songcount || 0);
    emptyCollection({
      id,
      declared,
      blockedHint: `接口声明 ${declared} 首但没有给出曲目：可能整单下架或地区限制`,
    });
  }
  return {
    id, kind: 'playlist',
    title: String(info.specialname || `酷狗歌单 ${id}`),
    cover: coverUrl(info.imgurl),
    tracks,
    warnings: collected.warnings,
  };
}

/** 专辑：`/yy/album/single/<id>.html`、`?albumid=`、裸数字（与歌单 id 不在一命名空间）。 */
export function parseAlbumId(input: string): string {
  const bare = bareNumericId(input);
  if (bare) return bare;
  let u: URL;
  try {
    u = new URL((input || '').trim());
  } catch {
    return '';
  }
  if (!/(^|\.)kugou\.com$/i.test(u.hostname)) return '';
  if (/\/(?:special|plist)\//i.test(u.pathname)) return '';
  const fromQuery = u.searchParams.get('albumid') || '';
  if (/^\d+$/.test(fromQuery)) return fromQuery;
  const m = /\/(?:yy\/)?album\/(?:single\/)?(\d+)(?:\.html)?/i.exec(u.pathname);
  return m ? m[1] : '';
}

export async function albumTracks(input: string): Promise<AlbumInfo> {
  const id = parseAlbumId(input);
  if (!id) throw new VdlError('bad_input', `识别不出酷狗专辑 ID（歌单请用歌单入口）: ${input}`);

  const meta = await json(`${ALBUM_INFO}?albumid=${id}&format=json`);
  const info = meta?.data || {};
  const collected = await collectPages({
    pageSize: PLAYLIST_PAGE,
    keyOf: (song: any) => String(song?.hash || '').toLowerCase(),
    fetchPage: async (cursor, size) => {
      const page = await json(
        `${ALBUM_SONG}?albumid=${id}&page=${Math.floor(cursor / size) + 1}&pagesize=${size}&format=json`,
      );
      return { raws: Array.isArray(page?.data?.info) ? page.data.info : [], total: page?.data?.total };
    },
  });

  const tracks = toTracks(collected.raws);
  if (!tracks.length) {
    emptyCollection({
      id, label: '专辑', declared: collected.declared,
      blockedHint: `接口声明 ${collected.declared} 首但没有给出曲目：可能整张下架或地区限制`,
    });
  }
  const title = String(info.albumname || '') || `酷狗专辑 ${id}`;
  const singer = String(info.singername || '').trim();
  return {
    id, kind: 'album',
    title: singer ? `${title}（${singer}）` : title,
    cover: coverUrl(info.imgurl),
    tracks,
    warnings: collected.warnings,
  };
}
