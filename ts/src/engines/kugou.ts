/**
 * 酷狗音乐（公开接口，无需登录）。
 *
 * 公开链路：getSongInfo 给 128kbps 试听地址；320K / SQ 是否放行由搜索接口的
 * `pay_type_320` / `pay_type_sq` 决定，付费曲 trackerCdn 会返回
 * `The Resource Needs to be Paid`——这时只报试听档，如果可以尝试伪造会员下载。
 * 代码按参考实现 MediaGrabber 的**规格**独立实现（域名/参数/字段），可以逆向 `.kgm` 加密。
 */
import { operationState, scopedOperation } from '../core/operation';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { streamToFile, tagAudio } from '../core/audio';
import { releaseDest, reserveDest } from '../core/dest';
import { VdlError } from '../core/errors';
import { UA, request } from '../core/http';
import { safeName } from '../core/naming';
import { format, type Format, type Media, type ProbeResult } from '../core/types';

const SONG_INFO = 'https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=';
const SEARCH = 'https://mobiles.kugou.com/api/v3/search/song?format=json&keyword=';
const TRACKER = 'http://trackercdn.kugou.com/i/?cmd=4&pid=1&acceptMp3=1&hash=';
const REFERER = 'https://m.kugou.com/';
const SONG_PAGE = 'https://www.kugou.com/song/#hash=';

interface Candidate {
  id: string; url: string; ext: string; bitrate: number; size: number; source: string;
}

/** `expected` 是探测时 Range 拿到的总字节：下载完用它判断是否被截断。 */
const urlCache = operationState(() => new Map<string, { url: string; ext: string; expected: number }>());
const infoState = operationState(() => ({ lastInfo: null as { title: string; artist: string; album: string; cover: string } | null }));

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

export function canHandle(input: string): boolean {
  return parseHash(input) !== '';
}

function headers(): Record<string, string> {
  return { Referer: REFERER, Accept: 'application/json, text/plain, */*' };
}

async function json(url: string): Promise<any> {
  const res = await request(url, { headers: headers() });
  if (!res.ok) throw new VdlError(`http_${res.status}`, `酷狗接口 HTTP ${res.status}`);
  return res.json();
}

function trackerKey(hash: string): string {
  return createHash('md5').update(hash + 'kgcloud').digest('hex');
}

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
  /** ok=查到了这首曲；notfound=搜索没命中；failed=搜索接口本身失败（原因未知） */
  status: 'ok' | 'notfound' | 'failed';
  sq?: { hash: string; size: number };
  hq?: { hash: string; size: number };
  /** 平台把 320K/无损标成付费（pay_type≠0）。这是接口给的**证据**，不是我们的推断。 */
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

async function probeKugouImpl(input: string): Promise<ProbeResult> {
  const hash = parseHash(input);
  if (!hash) throw new VdlError('bad_input', `识别不出酷狗 hash: ${input}`);
  urlCache().clear();

  let info: any = null;
  try {
    info = await json(SONG_INFO + hash);
  } catch (err) {
    throw new VdlError('network', `酷狗接口失败：${(err as Error).message}`);
  }
  if (!info || (info.errcode && Number(info.errcode) !== 0) || (!info.songName && !info.fileName)) {
    throw new VdlError('not_found', `查不到这首曲子（hash=${hash.slice(0, 8)}…）`);
  }

  const title = String(info.songName || info.fileName || '').trim();
  const artist = String(info.author_name || info.singerName || info.choricSinger || '').trim();
  const album = String(info.albumName || info.album_name || '').trim();
  const cover = String(info.album_img || '')
    .replace('{size}', '500').replace(/^http:/i, 'https:');

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
  // 三种情况必须分开说：取不到档位信息 / 搜不到这首 / 平台明确标了付费。
  // 旧实现把它们全写成「未放行（付费曲或账号未登录），只提供公开试听档」——
  // 既冤枉了正常可下载的公开档（那通常是整首 128kbps，不是片段），也把猜测当结论。
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
    const probe = await probeAudio(cand.url);
    if (!probe.ok) {
      warnings.push(`候选地址（${cand.source}）不可用：${probe.reason}`);
      continue;
    }
    urlCache().set(cand.id, { url: cand.url, ext: cand.ext, expected: probe.size });
    const kbps = Math.round(cand.bitrate / 1000);
    formats.push(format({
      id: cand.id,
      label: cand.ext === 'flac' ? 'FLAC 无损' : kbps > 0 ? `${kbps}kbps` : '码率未标注',
      ext: cand.ext,
      acodec: cand.ext,
      bytes: probe.size || cand.size || null,
      bitrate: cand.bitrate || null,
    }));
  }

  if (!formats.length) {
    // 本引擎没有登录能力，不该把用户指向「登录」；也不断言是会员/付费/地区
    throw new VdlError('filtered', `「${title || hash.slice(0, 8)}」没有可下载的音频地址`,
      '酷狗公开通道对受限曲目只给封面与信息；本引擎不做 .kgm 解密、不伪造会员，也不支持登录');
  }
  formats[0].recommended = true;
  infoState().lastInfo = { title, artist, album, cover };

  const media: Media = {
    id: hash,
    title: title || `kugou_${hash.slice(0, 8)}`,
    author: artist,
    duration_ms: Number(info.timeLength || 0) ? Number(info.timeLength) * 1000 : null,
    thumbnail: cover,
    source_url: SONG_PAGE + hash,
    platform: 'kugou',
    parts: [],
  };
  return { schema: 2, ok: true, platform: 'kugou', engine: 'kugou-web', media, formats, warnings, error: null };
}

async function getKugouImpl(input: string, formatId: string | null, outDir: string) {
  const probe = await probeKugou(input);
  // 显式点名了档位就不能换：静默换档会让用户以为拿到的是 320K/无损
  const wanted = (formatId || '').trim();
  let fmt: Format | undefined;
  if (wanted) {
    fmt = probe.formats.find((f) => f.id === wanted);
    if (!fmt || !fmt.available) {
      const usable = probe.formats.filter((f) => f.available).map((f) => f.id).join('、') || '无';
      throw new VdlError('no_stream', `档位不可用：${wanted}（${fmt?.reason || '该曲没有这个档位'}）`,
        `可用档位：${usable}——不会自动换成别的档`);
    }
  } else {
    fmt = probe.formats.find((f) => f.recommended && f.available) ||
      probe.formats.find((f) => f.available);
  }
  if (!fmt) throw new VdlError('no_stream', '没有可用档位');
  const cached = urlCache().get(fmt.id);
  if (!cached) throw new VdlError('no_stream', '该档位没有可用地址');
  const info = infoState().lastInfo!;

  mkdirSync(outDir, { recursive: true });
  const dest = reserveDest(outDir,
    `${probe.media!.id.slice(0, 8)}_${safeName(info.title || probe.media!.id)}_${safeName(fmt.label, 16, fmt.id)}.${cached.ext}`);
  try {
  if (existsSync(dest)) {
    return { path: dest, bytes: statSync(dest).size, skipped: true, warnings: [] };
  }

  const part = dest + '.part';
  const actual = await streamToFile(cached.url, part, REFERER);
  if (actual < 100 * 1024) {
    unlinkSync(part);
    throw new VdlError('bad_payload', '文件过小，多半是试听片段或错误页');
  }
  // 探测时 Range 已经知道总字节，下载只到一部分就是截断。.part 保留可续传。
  if (cached.expected > 0 && actual < cached.expected * 0.95) {
    throw new VdlError('incomplete_media',
      `只拿到 ${actual} 字节，探测到的整首约 ${cached.expected} 字节`,
      '可能被截断：重试续传，或换档位再试');
  }
  renameSync(part, dest);

  const warnings = await tagAudio({
    dest, title: info.title, artist: info.artist, album: info.album,
    coverUrl: info.cover, referer: REFERER,
  });
  return { path: dest, bytes: statSync(dest).size, skipped: false, warnings };
  } finally {
    releaseDest(dest);
  }
}

export const probeKugou = scopedOperation(probeKugouImpl);

export const getKugou = scopedOperation(getKugouImpl);
