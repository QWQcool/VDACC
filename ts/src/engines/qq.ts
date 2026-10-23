/**
 * QQ 音乐引擎骨架（3.1）。
 *
 * 范围（刻意很小）：
 * - 只做 `canHandle` / `probe`，**不实现下载**，**不注册到 platformOf / server / cli**。
 *   没有账号时下载链路验证不了，接上去就等于假装支持。
 * - 只按匿名档位探测：QQ 音乐现在连搜索都要登录（`musicu.fcg` 搜索返回 code 2001 +
 *   feedbackURL），但**单曲详情 + 取 vkey** 匿名还能用，实测 320K/FLAC 被拒（result 104003），
 *   128K MP3 / 96K AAC 对部分免费曲放行（result 0 + purl）。
 * - 因此“返回哪些档位”完全由接口实际给的 purl 决定，不按歌曲元数据里的
 *   `size_320mp3` / `size_flac` 猜——那两个字段就算有值，匿名也拿不到地址。
 *
 * 规格来源：docs/music-channels.md（只取域名/路径/参数/字段，独立实现）。
 * 未验证项见文件末尾「未做」。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { VdlError } from '../core/errors';
import { request } from '../core/http';
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

export async function probeQQ(input: string): Promise<ProbeResult> {
  const mid = parseSongmid(input);
  if (!mid) throw new VdlError('bad_input', `识别不出 QQ 音乐 songmid: ${input}`);

  const detail = await fetchDetail(mid);
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

/**
 * 未做（不假装支持）：
 * - `download()`：还没写，所以**没有注册到 platformOf / server / cli**。
 * - 320K/FLAC：登录后仍实测 104003（《雨爱》《我怀念的》《告白气球》等），
 *   档位由账号会员权限决定；代码已带 uin+authst，换会员账号会自动生效，但没有验证过。
 * - 搜索：`DoSearchForQQMusicDesktop` 时好时坏——同一账号一次 code=0 返回 3 条，
 *   下一次 2001；不接关键词搜索，只吃 mid / 分享链接。
 * - 其它容器（APE / 192K AAC / DTS）：没验证，先不铺。
 */
