/**
 * QQ 音乐（端上，M3）。
 *
 * 与桌面端 `ts/src/engines/qq.ts` 同一套接口：详情 fcg_play_single_song → vkey.GetVkeyServer
 * 拿四个档位的 purl，档位与文件名的对应由实测确认（M500=128K mp3、C400=96K aac、
 * M800/F000 需账号权益）。
 *
 * 登录（B2 起支持）：cookie 由原生按 host 补，账号数字（uin）通过桥只读拿到；
 * 未登录时 vkey 请求 uin=0，四档仍全部列出、未放行的 `available:false` 带真实 `result` 代码。
 * 不把「接口没返回」说成「会员缺失」，也不把某个账号登录后的结论套到匿名请求上。
 *
 * 已知边界：`comm.authst`（桌面端塞的是 qm_keyst）这里**不发**——那等于把 cookie 值交给 JS。
 * 现在只靠原生补的 Cookie 头 + body 里的 uin 取地址；实测若仍 104003，说明这台账号
 * 确实没有该档权益，文案会如实说「已登录但未放行」，不谎称未登录。
 */
import { UA, request } from '../../../../ts/src/core/http';
import { VdlError } from '../../../../ts/src/core/errors';
import { safeName } from '../../../../ts/src/core/naming';
import { format, type Format, type ProbeResult } from '../../../../ts/src/core/types';
import type { AlbumInfo, AlbumTrack } from '../../../../ts/src/core/album';
import { accountUin, loggedIn } from './account';
import { randomBytes } from '../shims/crypto';
import {
  assertNotTruncated, downloadToStaging, type MusicHooks, publishStaged, stemOf, tagStaged,
  writeTextSidecar,
} from './music-common';

const DETAIL = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';
const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const LYRIC = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
const REFERER = 'https://y.qq.com/';
const SONG_PAGE = 'https://y.qq.com/n/ryqq/songDetail/';

/** 档位与 filename 前缀的对应关系由实测确认（M500 体积 == `size_128mp3`，C400 == `size_96aac`）。 */
const QUALITIES: Array<{ prefix: string; ext: string; label: string; bitrate: number | null }> = [
  { prefix: 'M800', ext: 'mp3', label: '320K MP3', bitrate: 320000 },
  { prefix: 'M500', ext: 'mp3', label: '128K MP3', bitrate: 128000 },
  { prefix: 'C400', ext: 'm4a', label: '96K AAC', bitrate: 96000 },
  { prefix: 'F000', ext: 'flac', label: '无损 FLAC', bitrate: null },
];

const BARE_MID = /^[0-9A-Za-z]{14}$/;
const MID_IN_PATH = /\/(?:songDetail|songdetail)\/([0-9A-Za-z]+)/;
const ALBUM_IN_PATH = /\/(?:albumDetail|albumdetail)\/([0-9A-Za-z]+)/;

/** 三种常见形态：`songDetail/<mid>`、`?songmid=<mid>`、裸 mid。 */
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
  // 只认 QQ 音乐域名：任意站点都可能有 `?songmid=`，跟着猜会误判平台
  const host = url.hostname.toLowerCase();
  if (host !== 'qq.com' && !host.endsWith('.qq.com')) return '';
  for (const key of ['songmid', 'songMid', 'mid']) {
    const value = url.searchParams.get(key) || '';
    if (BARE_MID.test(value)) return value;
  }
  const m = MID_IN_PATH.exec(url.pathname);
  return m ? m[1] : '';
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

/**
 * 专辑曲目（`fcg_v8_album_info_cp`，与桌面端同一接口）。
 *
 * cookie 由原生按 host 补，所以登录后专辑里的会员曲解析不会比桌面端少；
 * 但**能不能下**仍由每首歌的 vkey 决定，这里只负责列曲目。
 */
export async function albumTracks(input: string): Promise<AlbumInfo> {
  const mid = parseAlbumMid(input);
  if (!mid) throw new VdlError('bad_input', `识别不出 QQ 音乐专辑 mid: ${input}`);
  const res = await request(
    `https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=${mid}&format=json`,
    { headers: { Referer: REFERER }, timeoutMs: 20_000 });
  const text = await res.text();
  if (!res.ok) throw new VdlError(`http_${res.status}`, `QQ 音乐专辑接口 HTTP ${res.status}`);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VdlError('bad_json', `专辑接口不是 JSON（前 120 字节: ${JSON.stringify(text.slice(0, 120))}）`);
  }
  if (Number(json?.code) !== 0) {
    throw new VdlError('album_failed', `专辑接口 code=${json?.code}`, '确认专辑 mid 是否正确');
  }
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

type Cached = { url: string; ext: string; declared: number };
type SongDetail = {
  mid: string; name: string; singers: string[]; albumMid: string; albumName: string;
  durationMs: number; sizes: Record<string, number>;
};

/** 真实客户端用设备 guid；这里每次随机一个 10 位十进制串（接口只当缓存键用）。 */
function guid(): string {
  const r = randomBytes(4);
  const n = (((r[0] << 24) | (r[1] << 16) | (r[2] << 8) | r[3]) >>> 0) % 1000000000;
  return String(1000000000 + n);
}

async function fetchDetail(mid: string): Promise<SongDetail> {
  const query = new URLSearchParams({ songmid: mid, platform: 'yqq', format: 'json' });
  const res = await request(`${DETAIL}?${query}`, { headers: { Referer: REFERER }, timeoutMs: 20_000 });
  const text = await res.text();
  if (!res.ok) throw new VdlError(`http_${res.status}`, `QQ 音乐详情接口 HTTP ${res.status}`);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new VdlError('bad_json', `详情不是 JSON（前 120 字节: ${JSON.stringify(text.slice(0, 120))}）`);
  }
  if (Number(data?.code) !== 0) {
    throw new VdlError(Number(data?.code) === -404 ? 'not_found' : 'api_error',
      `QQ 音乐详情接口 code=${data?.code}`, '确认歌曲 mid 是否正确');
  }
  const song = (data?.data || [])[0] || {};
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

type MidUrl = { filename: string; purl: string; result: number };

/**
 * 一个 mid 对应多个 filename 时接口按**下标**配对，所以 songmid/songtype 要重复。
 *
 * `uin` 为空串 = 未登录，按匿名请求发（桌面端同样在无凭据时发 0）。
 * 这里刻意**不发 authst**：它等于 qm_keyst 的值，发出去就是 cookie 出原生。
 */
async function fetchVkeys(mid: string, uin = ''): Promise<{ sip: string; items: MidUrl[] }> {
  const filenames = QUALITIES.map((q) => `${q.prefix}${mid}.${q.ext}`);
  const numeric = Number(uin) || 0;
  const payload = {
    comm: { uin: numeric, format: 'json', ct: 24, cv: 0 },
    req_1: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: guid(),
        songmid: QUALITIES.map(() => mid),
        songtype: QUALITIES.map(() => 0),
        uin: numeric ? String(numeric) : '0',
        loginflag: 1,
        platform: '20',
        filename: filenames,
      },
    },
  };
  const res = await request(MUSICU, {
    method: 'POST',
    headers: { Referer: REFERER, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 20_000,
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
  return { sip: String((body.sip || [])[0] || ''), items: body.midurlinfo || [] };
}

/** HEAD 拿真实字节数；拿不到就退回元数据里的声明值，都没有就留 null。 */
async function headBytes(url: string): Promise<number> {
  try {
    const res = await request(url, { method: 'HEAD', headers: { Referer: REFERER }, timeoutMs: 20_000 });
    const size = Number(res.headers.get('content-length') || 0);
    return size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

/** 歌词是附属产物：拿不到就返回空串，不影响音频。 */
async function fetchLyric(mid: string): Promise<string> {
  try {
    const res = await request(`${LYRIC}?songmid=${mid}&format=json&nobase64=1&g_tk=5381`, {
      headers: { Referer: 'https://y.qq.com/portal/player.html' },
      timeoutMs: 20_000,
    });
    const body = await res.json() as any;
    return Number(body?.code) === 0 ? String(body?.lyric || '').trim() : '';
  } catch {
    return '';
  }
}

export type QQProbeInternal = {
  probe: ProbeResult;
  urls: Map<string, Cached>;
  detail: SongDetail;
};

export async function probeImpl(input: string): Promise<QQProbeInternal> {
  const mid = parseSongmid(input);
  if (!mid) throw new VdlError('bad_input', `识别不出 QQ 音乐 songmid: ${input}`);
  const urls = new Map<string, Cached>();

  const detail = await fetchDetail(mid);
  // uin 只用于拼 vkey 的 body；signedIn 决定文案说「去登录」还是「账号没有这个档」
  const [uin, signedIn] = await Promise.all([accountUin('qq'), loggedIn('qq')]);
  const { sip, items } = await fetchVkeys(mid, uin);

  const formats: Format[] = [];
  const denied: string[] = [];
  for (const quality of QUALITIES) {
    const id = quality.prefix.toLowerCase();
    const filename = `${quality.prefix}${mid}.${quality.ext}`;
    const item = items.find((x) => x.filename === filename);
    const purl = item?.purl || '';

    if (!item || item.result !== 0 || !purl) {
      // 只记录证据：接口没返回 ≠ 会员缺失；result≠0 只报代码
      const reason = !item
        ? '接口没有返回这个档位'
        : item.result !== 0
          ? `接口未放行（result=${item.result}）`
          : '接口没有给出播放地址（purl 为空）';
      formats.push(format({
        id, label: quality.label, ext: quality.ext, acodec: quality.ext,
        bitrate: quality.bitrate, available: false, reason,
      }));
      denied.push(`${quality.label}${item && item.result !== 0 ? `(result=${item.result})` : ''}`);
      continue;
    }

    const url = purl.startsWith('http') ? purl : sip + purl;
    const real = await headBytes(url);
    const declared = detail.sizes[quality.prefix] || 0;
    urls.set(id, { url, ext: quality.ext, declared });
    formats.push(format({
      id,
      label: quality.label,
      ext: quality.ext,
      acodec: quality.ext,
      bytes: real || declared || null,
      bitrate: quality.bitrate,
    }));
    if (real > 0 && declared > 0 && real < declared * 0.6) {
      formats[formats.length - 1].reason =
        `实际可下载 ${(real / 1048576).toFixed(2)} MB，小于接口声明 ${(declared / 1048576).toFixed(2)} MB（可能是试听片段）`;
    }
  }

  const available = formats.filter((f) => f.available);
  if (!available.length) {
    const codes = [...new Set(items.map((x) => Number(x.result || 0)).filter((x) => x !== 0))];
    const suffix = codes.length ? `（result=${codes.join('/')}）` : '';
    // 有凭据但全档被拒 ≠ 忘了登录：两者下一步完全不同，码也不能混用（对齐桌面端 filtered/need_login）
    if (signedIn) {
      throw new VdlError('filtered', `已登录但没有可用播放地址${suffix}`,
        '该曲可能需要会员权益，或接口只放行部分档位；这里只报真实 result，不猜测原因');
    }
    throw new VdlError('need_login', `没有可用的播放地址（未登录）${suffix}`,
      'QQ 音乐的高档位需要登录：在「设置 → 账号」里登录后重试');
  }
  available[0].recommended = true;

  const warnings: string[] = [signedIn
    ? '已登录，档位以账号实际权益为准'
    : '未登录，仅匿名档（320K/FLAC 匿名通常不放行；可在「设置 → 账号」登录）'];
  if (denied.length) warnings.push(`本次未放行：${denied.join('、')}`);
  const partial = formats.find((f) => f.available && f.reason);
  if (partial) warnings.push(`${partial.label}：${partial.reason}`);

  const probe: ProbeResult = {
    schema: 2,
    ok: true,
    platform: 'qq',
    engine: 'qq-api-mobile',
    media: {
      id: mid,
      title: detail.name || `qq_${mid}`,
      author: detail.singers.join(' / '),
      duration_ms: detail.durationMs || null,
      thumbnail: detail.albumMid
        ? `https://y.qq.com/music/photo_new/T002R300x300M000${detail.albumMid}.jpg`
        : '',
      source_url: SONG_PAGE + mid,
      platform: 'qq',
      parts: [],
    },
    formats,
    warnings,
    error: null,
  };
  return { probe, urls, detail };
}

export async function probeQQ(input: string): Promise<ProbeResult> {
  return (await probeImpl(input)).probe;
}

export async function downloadQQ(
  input: string,
  formatId: string | null,
  hooks: MusicHooks = {},
) {
  const started = Date.now();
  const { probe, urls, detail } = await probeImpl(input);

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
    fmt = probe.formats.find((f) => f.recommended && f.available)
      || probe.formats.find((f) => f.available);
  }
  if (!fmt) throw new VdlError('no_stream', '没有可用档位');
  const cached = urls.get(fmt.id);
  if (!cached) throw new VdlError('no_stream', '该档位没有可用地址');

  const stem = stemOf(probe.media!.id, probe.media!.title, fmt.label, safeName);
  const name = `${stem}.${cached.ext}`;

  const { bytes, resumeFrom } = await downloadToStaging(cached.url, name, REFERER, {
    onProgress: (written, total) => {
      const planned = cached.declared || total;
      hooks.onProgress?.(written, planned || total);
    },
    onReady: hooks.onReady,
  });
  // 「能播放」不等于「拿到整曲」：30 秒试听也有几百 KB，所以按接口声明的整曲字节比
  assertNotTruncated(bytes, cached.declared, '音频');

  const warnings = await tagStaged(name, {
    title: probe.media!.title,
    artist: probe.media!.author,
    album: detail.albumName,
    comment: 'downloaded by vdacc',
  }, probe.media!.thumbnail ? { url: probe.media!.thumbnail, referer: REFERER } : null);

  const published = await publishStaged(name);
  if (published.note) warnings.push(published.note);

  const lyric = await fetchLyric(probe.media!.id);
  if (lyric) {
    try {
      await writeTextSidecar(`${stem}.lrc`, lyric);
    } catch (error) {
      warnings.push(`歌词落盘失败：${(error as Error).message}`);
    }
  }

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
