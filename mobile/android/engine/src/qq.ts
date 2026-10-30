/**
 * QQ 音乐（端上，M3）。
 *
 * 与桌面端 `ts/src/engines/qq.ts` 同一套接口：详情 fcg_play_single_song → vkey.GetVkeyServer
 * 拿四个档位的 purl，档位与文件名的对应由实测确认（M500=128K mp3、C400=96K aac、
 * M800/F000 需账号权益）。
 *
 * 端上**没有登录**（也不打算有）：所以 vkey 请求固定 uin=0，四档全部列出、未放行的
 * `available:false` 带真实 `result` 代码，并明确说「未登录，仅匿名档」。
 * 不把「接口没返回」说成「会员缺失」，也不把别人登录后的结论套到匿名请求上。
 */
import { UA, request } from '../../../../ts/src/core/http';
import { VdlError } from '../../../../ts/src/core/errors';
import { safeName } from '../../../../ts/src/core/naming';
import { format, type Format, type ProbeResult } from '../../../../ts/src/core/types';
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

/** 一个 mid 对应多个 filename 时接口按**下标**配对，所以 songmid/songtype 要重复。 */
async function fetchVkeys(mid: string): Promise<{ sip: string; items: MidUrl[] }> {
  const filenames = QUALITIES.map((q) => `${q.prefix}${mid}.${q.ext}`);
  const payload = {
    comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
    req_1: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: guid(),
        songmid: QUALITIES.map(() => mid),
        songtype: QUALITIES.map(() => 0),
        uin: '0',
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
  const { sip, items } = await fetchVkeys(mid);

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
    throw new VdlError('need_login', `没有匿名可用的播放地址${suffix}`,
      'QQ 音乐的高档位需要登录；端上不支持登录，可改用桌面端下载后传回手机');
  }
  available[0].recommended = true;

  const warnings: string[] = ['端上未登录，仅匿名档（320K/FLAC 匿名未放行，本次不包含）'];
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
