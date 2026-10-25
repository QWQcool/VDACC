/**
 * QQ 音乐引擎（3.1）。
 *
 * - 档位只认接口实际给的 purl：QQ 音乐现在连搜索都要登录，320K/FLAC 还取决于账号会员，
 *   所以不按歌曲元数据里的 `size_320mp3` / `size_flac` 猜档位。
 * - 登录可选：`auth qq` 扫码导出 cookie 后自动带 `comm.uin` + `comm.authst`(qm_keyst)。
 *   实测同一首歌登录前后可能完全一样——档位由**账号会员权限**决定。
 * - 下载：流式落盘 + 限速 + 续传，ffmpeg 写 title/artist/album 与封面，失败降级保留音频。
 *
 * 规格来源：docs/music-channels.md（只取域名/路径/参数/字段，独立实现）。
 * 未验证项见文件末尾「未做」。
 */
import { operationState, scopedOperation } from '../core/operation';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync,
  writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { AlbumInfo, AlbumTrack } from '../core/album';
import { throwIfCancelled } from '../core/cancel';
import { VdlError } from '../core/errors';
import { UA, request } from '../core/http';
import { safeName } from '../core/naming';
import { report } from '../core/progress';
import { throttle } from '../core/rate';
import { format, type Format, type ProbeResult } from '../core/types';

const DETAIL = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';
const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const SONG_PAGE = 'https://y.qq.com/n/ryqq/songDetail/';

/** 档位与文件名的对应关系由实测确认：M500 的大小等于 `file.size_128mp3`，
 *  C400 等于 `size_96aac`，M800/`size_320mp3`、F000/`size_flac` 需登录才放行。 */
const QUALITIES: Array<{ prefix: string; ext: string; label: string; bitrate: number | null }> = [
  { prefix: 'M800', ext: 'mp3', label: '320K MP3', bitrate: 320000 },
  { prefix: 'M500', ext: 'mp3', label: '128K MP3', bitrate: 128000 },
  { prefix: 'C400', ext: 'm4a', label: '96K AAC', bitrate: 96000 },
  { prefix: 'F000', ext: 'flac', label: '无损 FLAC', bitrate: null },
];

const BARE_MID = /^[0-9A-Za-z]{14}$/;
const MID_IN_PATH = /\/(?:songDetail|songdetail)\/([0-9A-Za-z]+)/;
const ALBUM_IN_PATH = /\/(?:albumDetail|albumdetail)\/([0-9A-Za-z]+)/;

/** probe 时按档位缓存播放地址（purl 带 vkey，会过期，所以每次下载都重新 probe）。 */
const urlCache = operationState(() => new Map<string, { url: string; ext: string }>());
/** 详情留给下载阶段打标签用（album 名不在 ProbeResult.media 里）。 */
const detailState = operationState(() => ({ lastDetail: null as SongDetail | null }));

/** 纯函数：从分享链接 / 裸 mid 里取 songmid，取不到返回空串。
 *  QQ 音乐有三种常见形态：`y.qq.com/n/ryqq/songDetail/<mid>`、
 *  `i.y.qq.com/v8/playsong.html?songmid=<mid>`、以及直接粘贴 mid。 */
export function parseSongmid(input: string): string {
  const raw = (input || '').trim();
  if (!raw) return '';
  if (BARE_MID.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  // 只认 QQ 音乐的域名：任意站点都可能有 `?songmid=`，跟着猜会误判平台
  const host = url.hostname.toLowerCase();
  if (host !== 'qq.com' && !host.endsWith('.qq.com')) return '';
  for (const key of ['songmid', 'songMid', 'mid']) {
    const value = url.searchParams.get(key) || '';
    if (BARE_MID.test(value)) return value;
  }
  const m = MID_IN_PATH.exec(url.pathname);
  return m ? m[1] : '';
}

export function canHandle(input: string): boolean {
  return parseSongmid(input) !== '';
}

interface Credential { uin: string; authst: string }

/**
 * 读 `auth qq` 写下的 storage_state，凑 vkey 需要的 uin + qm_keyst。
 * cookie 里 `uin` 常带前导 `o`（o1234567890），接口要纯数字；qm_keyst 可能要 decode。
 * 返回值只用于请求参数，不打印、不入日志。
 */
function loadCredential(): Credential | null {
  const file = join(process.env.LOCALAPPDATA || '', 'vdl', 'auth', 'qq.json');
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const now = Date.now() / 1000;
    const cookies = (state.cookies || []).filter((c: any) =>
      String(c.domain || '').includes('qq.com') &&
      (!c.expires || c.expires < 0 || c.expires > now));
    const get = (name: string) =>
      String(cookies.find((c: any) => c.name === name)?.value || '');
    const uin = (get('uin') || get('p_uin') || get('pt2gguin'))
      .replace(/^o/i, '').replace(/\D/g, '');
    let authst = get('qm_keyst') || get('qqmusic_key');
    try { authst = decodeURIComponent(authst); } catch { /* 保持原值 */ }
    return uin && authst ? { uin, authst } : null;
  } catch {
    return null;
  }
}

function guid(): string {
  // 真实客户端用设备 guid；这里每次随机一个 10 位十进制串，接口只当缓存键用
  return String(1000000000 + (randomBytes(4).readUInt32BE(0) % 1000000000));
}

interface SongDetail {
  mid: string;
  name: string;
  singers: string[];
  albumMid: string;
  albumName: string;
  durationMs: number;
  sizes: Record<string, number>;
}

async function fetchDetail(mid: string): Promise<SongDetail> {
  const url = `${DETAIL}?${new URLSearchParams({ songmid: mid, platform: 'yqq', format: 'json' })}`;
  const res = await request(url, { headers: { Referer: 'https://y.qq.com/' } });
  const text = await res.text();
  if (!res.ok) throw new VdlError(`http_${res.status}`, `QQ 音乐详情接口 HTTP ${res.status}`);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new VdlError('bad_json', `详情不是 JSON（前 120 字节: ${JSON.stringify(text.slice(0, 120))}）`);
  }
  const song = (data?.data || [])[0];
  // 接口对不存在的 mid 也回 code=0，只能靠空的 data 判断
  if (!song || !song.mid) throw new VdlError('not_found', `查不到这首歌（songmid=${mid}）`);
  if (String(song.mid) !== mid) {
    throw new VdlError('wrong_song', `返回的歌曲不匹配（要 ${mid}，拿到 ${song.mid}）`);
  }
  return {
    mid,
    name: String(song.name || song.title || '').trim(),
    singers: (song.singer || []).map((s: any) => String(s.name || '')).filter(Boolean),
    albumMid: String(song.album?.mid || ''),
    albumName: String(song.album?.name || ''),
    durationMs: Number(song.interval || 0) * 1000,
    sizes: {
      M800: Number(song.file?.size_320mp3 || 0),
      M500: Number(song.file?.size_128mp3 || 0),
      C400: Number(song.file?.size_96aac || 0),
      F000: Number(song.file?.size_flac || 0),
    },
  };
}

interface MidUrl {
  filename: string;
  purl: string;
  result: number;
}

async function fetchVkeys(mid: string, cred: Credential | null): Promise<{ sip: string; items: MidUrl[] }> {
  // 一个 songmid 对应多个 filename 时，接口按**下标**配对，所以 songmid/songtype 要重复
  const filenames = QUALITIES.map((q) => `${q.prefix}${mid}.${q.ext}`);
  const comm: Record<string, unknown> = {
    uin: cred ? Number(cred.uin) : 0, format: 'json', ct: 24, cv: 0,
  };
  if (cred) comm.authst = cred.authst;
  const payload = {
    comm,
    req_1: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: guid(),
        songmid: QUALITIES.map(() => mid),
        songtype: QUALITIES.map(() => 0),
        uin: cred ? cred.uin : '0',
        loginflag: 1,
        platform: '20',
        filename: filenames,
      },
    },
  };
  const res = await request(MUSICU, {
    method: 'POST',
    headers: { Referer: 'https://y.qq.com/', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new VdlError(`http_${res.status}`, `QQ 音乐 vkey 接口 HTTP ${res.status}`);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new VdlError('bad_json', `vkey 不是 JSON（前 120 字节: ${JSON.stringify(text.slice(0, 120))}）`);
  }
  if (data?.req_1?.code !== 0) {
    throw new VdlError('vkey_failed', `vkey 接口 code=${data?.req_1?.code}（未登录或接口变更）`);
  }
  const body = data.req_1.data || {};
  const items: MidUrl[] = body.midurlinfo || [];
  return { sip: String((body.sip || [])[0] || ''), items };
}

/** HEAD 拿真实字节数；拿不到就退回歌曲元数据里的声明值，都没有就留 null。 */
async function headBytes(url: string): Promise<number> {
  try {
    const res = await request(url, { method: 'HEAD', headers: { Referer: 'https://y.qq.com/' } });
    const size = Number(res.headers.get('content-length') || 0);
    return size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

async function probeQQImpl(input: string): Promise<ProbeResult> {
  const mid = parseSongmid(input);
  if (!mid) throw new VdlError('bad_input', `识别不出 QQ 音乐 songmid: ${input}`);
  urlCache().clear();

  const detail = await fetchDetail(mid);
  detailState().lastDetail = detail;
  const cred = loadCredential();
  const { sip, items } = await fetchVkeys(mid, cred);

  const formats: Format[] = [];
  const denied: string[] = [];
  for (const quality of QUALITIES) {
    const item = items.find((x) => x.filename === `${quality.prefix}${mid}.${quality.ext}`);
    if (!item || item.result !== 0 || !item.purl) {
      denied.push(quality.label);
      continue;
    }
    const url = item.purl.startsWith('http') ? item.purl : sip + item.purl;
    const real = await headBytes(url);
    urlCache().set(quality.prefix.toLowerCase(), { url, ext: quality.ext });
    formats.push(format({
      id: quality.prefix.toLowerCase(),
      label: quality.label,
      ext: quality.ext,
      acodec: quality.ext,
      bytes: real || detail.sizes[quality.prefix] || null,
      bitrate: quality.bitrate,
    }));
  }

  if (!formats.length) {
    throw new VdlError('need_login', '这首曲子没有匿名可用的播放地址',
      'QQ 音乐现在匿名基本只放行部分免费曲；登录后再试（登录支持尚未接入）');
  }
  formats[0].recommended = true;

  // 有登录就说登录，没登录就说「仅匿名档」——实测同一首歌登录与否可能完全一样，
  // 差别在账号会员权限，不能因为 cookie 存在就暗示档位更高
  const warnings: string[] = [];
  if (cred) {
    warnings.push('已登录，档位以账号权限为准');
    if (denied.length) warnings.push(`本次未放行：${denied.join('、')}——歌曲付费或账号无对应会员`);
  } else {
    warnings.push('未登录，仅匿名档（320K/FLAC 需登录，本次不包含）');
    if (denied.length) warnings.push(`本次接口未放行：${denied.join('、')}`);
  }

  return {
    schema: 2, ok: true, platform: 'qq', engine: 'qq-api',
    media: {
      id: mid,
      title: detail.name || `qq_${mid}`,
      author: detail.singers.join(' / '),
      duration_ms: detail.durationMs || null,
      thumbnail: detail.albumMid
        ? `https://y.qq.com/music/photo_new/T002R300x300M000${detail.albumMid}.jpg`
        : '',
      source_url: SONG_PAGE + mid,
      platform: 'qq', parts: [],
    },
    formats, warnings, error: null,
  };
}

async function streamTo(url: string, part: string): Promise<number> {
  let resume = existsSync(part) ? statSync(part).size : 0;
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://y.qq.com/' };
  if (resume) headers.Range = `bytes=${resume}-`;
  const res = await fetch(url, { headers });
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

function ffmpeg(args: string[]) {
  const ff = process.env.VDL_FFMPEG || 'ffmpeg';
  return spawnSync(ff, args, { encoding: 'utf8', windowsHide: true });
}

/** 歌词单独落 .lrc（与网易云一致）；拿不到就返回空串，不影响音频。 */
async function fetchLyric(mid: string): Promise<string> {
  try {
    const res = await request(
      'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?' +
      `songmid=${mid}&format=json&nobase64=1&g_tk=5381`,
      { headers: { Referer: 'https://y.qq.com/portal/player.html' } });
    const json = await res.json() as any;
    return json?.code === 0 ? String(json?.lyric || '').trim() : '';
  } catch {
    return '';
  }
}

/**
 * 下载单曲。流程与网易云一致：流式落盘（.part）→ 封面/标签同一次 ffmpeg 写入 →
 * 失败就把原始音频改名留着，不因为“标签写不进去”丢掉已经下好的内容。
 */
async function getQQImpl(input: string, formatId: string | null, outDir: string) {
  const probe = await probeQQ(input);
  const fmt = probe.formats.find((f) => f.id === formatId) ||
    probe.formats.find((f) => f.recommended) || probe.formats[0];
  const cached = urlCache().get(fmt.id);
  if (!cached) throw new VdlError('no_stream', '该档位没有可用地址');

  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir,
    `${probe.media!.id}_${safeName(probe.media!.title)}_${safeName(fmt.label, 16, fmt.id)}.${cached.ext}`);
  if (existsSync(dest)) {
    return { path: dest, bytes: statSync(dest).size, skipped: true, warnings: [] };
  }

  const part = dest + '.part';
  await streamTo(cached.url, part);
  if (statSync(part).size < 100 * 1024) {
    unlinkSync(part);
    throw new VdlError('bad_payload', '文件过小，多半是试听片段或错误页');
  }

  // 歌词是附属产物：失败了也照样出音频，不往上抛
  const lyric = await fetchLyric(probe.media!.id);
  if (lyric) writeFileSync(dest.replace(/\.\w+$/, '.lrc'), lyric + '\n', 'utf8');

  const warnings: string[] = [];
  const rawCover = join(outDir, '__vdl_cover.img');
  const coverUrl = probe.media!.thumbnail || '';
  let coverPath = '';
  if (coverUrl) {
    try {
      const res = await fetch(coverUrl, { headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' } });
      if (res.ok) {
        writeFileSync(rawCover, Buffer.from(await res.arrayBuffer()));
        coverPath = rawCover;
      }
    } catch {
      coverPath = '';
    }
  }

  const out = dest.replace(/(\.\w+)$/, '.mux$1');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', part];
  if (coverPath) args.push('-i', coverPath);
  args.push('-map', '0:a');
  if (coverPath) {
    args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  }
  args.push('-c:a', 'copy');

  const tags: Record<string, string> = {
    title: probe.media!.title || '',
    artist: probe.media!.author || '',
    album: detailState().lastDetail?.albumName || '',
    comment: 'downloaded by vdl',
  };
  for (const [key, value] of Object.entries(tags)) {
    if (value) args.push('-metadata', `${key}=${value}`);
  }
  if (dest.toLowerCase().endsWith('.mp3')) args.push('-id3v2_version', '3');
  args.push(out);

  const run = ffmpeg(args);
  try { unlinkSync(rawCover); } catch { /* 没有封面 */ }

  if (run.status === 0 && existsSync(out)) {
    renameSync(out, dest);
    try { unlinkSync(part); } catch { /* ignore */ }
  } else {
    if (existsSync(out)) { try { unlinkSync(out); } catch { /* ignore */ } }
    renameSync(part, dest);
    warnings.push('写入标签失败，已保留音频');
  }

  return { path: dest, bytes: statSync(dest).size, skipped: false, warnings };
}

/** 供下载前预览：返回 probe 时缓存的 purl（qq 音乐 CDN 只给 http，服务端白名单已单独放行）。 */
export function previewQQ(formatId: string): string {
  return urlCache().get(formatId)?.url || '';
}

/** 专辑链接：`/n/ryqq/albumDetail/<mid>`、`?albummid=`，或裸 mid。 */
export function parseAlbumMid(input: string): string {
  const raw = (input || '').trim();
  if (BARE_MID.test(raw)) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'qq.com' && !host.endsWith('.qq.com')) return '';
  for (const key of ['albummid', 'albumMid', 'mid']) {
    const value = u.searchParams.get(key) || '';
    if (BARE_MID.test(value)) return value;
  }
  const m = ALBUM_IN_PATH.exec(u.pathname);
  return m ? m[1] : '';
}

/** 专辑曲目（`fcg_v8_album_info_cp`）。上限与截断在 core/album.ts。 */
export async function albumTracks(input: string): Promise<AlbumInfo> {
  const mid = parseAlbumMid(input);
  if (!mid) throw new VdlError('bad_input', `识别不出 QQ 音乐专辑 mid: ${input}`);
  const res = await request(
    `https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=${mid}&format=json`,
    { headers: { Referer: 'https://y.qq.com/' } });
  const json = await res.json() as any;
  if (json?.code !== 0) throw new VdlError('album_failed', `专辑接口 code=${json?.code}`);
  const data = json.data || {};
  const list: any[] = data.list || [];
  if (!list.length) throw new VdlError('not_found', `专辑里没有曲目（albummid=${mid}）`);
  return {
    id: mid,
    title: String(data.name || mid),
    cover: `https://y.qq.com/music/photo_new/T002R300x300M000${mid}.jpg`,
    tracks: list.map((s: any) => ({
      id: String(s.songmid || ''),
      title: String(s.songname || ''),
      author: (s.singer || []).map((x: any) => String(x.name || '')).filter(Boolean).join(' / '),
      url: SONG_PAGE + s.songmid,
    })).filter((t: AlbumTrack) => t.id),
  };
}

/**
 * 未做（不假装支持）：
 * - 320K/FLAC：登录后仍实测 104003（《雨爱》《我怀念的》《告白气球》等），
 *   档位由账号会员权限决定；代码已带 uin+authst，换会员账号会自动生效，但没有验证过。
 * - 搜索：`DoSearchForQQMusicDesktop` 时好时坏——同一账号一次 code=0 返回 3 条，
 *   下一次 2001；不接关键词搜索，只吃 mid / 分享链接。
 * - 歌词（.lrc）：QQ 的 lyric 接口没验，先不写。
 * - 其它容器（APE / 192K AAC / DTS）：没验证，先不铺。
 */

export const probeQQ = scopedOperation(probeQQImpl);

export const getQQ = scopedOperation(getQQImpl);
