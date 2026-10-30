/**
 * 酷我音乐（端上，M3）。公开接口，无需登录。
 *
 * 与桌面端 `ts/src/engines/kuwo.ts` 同一套接口与判定，差异只有落盘：
 * 端上没有 ffmpeg，标签由 `music-common.tagStaged` 自己拼字节；下载走原生流式。
 *
 * 三条如实报告的规矩（与桌面端一致）：
 * 1. 只描述证据：可下载的比特率低到像片段就说「不像整首」，不断言是会员/地区/风控；
 * 2. 接口没给元数据时用 rid 兜底，并尝试用文件内嵌 ID3 补全标题（文件自己的声明更可靠）；
 * 3. 没有公开地址时报 `filtered` 并说明「本引擎不支持登录」，不把用户指去一个不存在的入口。
 */
import { request } from '../../../../ts/src/core/http';
import { VdlError } from '../../../../ts/src/core/errors';
import { safeName } from '../../../../ts/src/core/naming';
import { readId3v2 } from '../../../../ts/src/core/tags';
import { format, type Format, type ProbeResult } from '../../../../ts/src/core/types';
import { call } from '../shims/bridge';
import { readHead } from './staging';
import {
  assertNotTruncated, downloadToStaging, type MusicHooks, probeAudioUrl, publishStaged,
  stemOf, tagStaged, writeTextSidecar,
} from './music-common';

const SEARCH = 'http://search.kuwo.cn/r.s?ft=music&itemset=web_2013&client=kt&pn=0&rn=10&rformat=json&encoding=utf8&all=';
const SONG_INFO = 'https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=';
const MOBI = 'https://mobi.kuwo.cn/mobi.s?f=web&source=jiakong&type=convert_url_with_sign&rid=';
const ANTI = 'http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_';
const REFERER = 'https://m.kuwo.cn/';
const SONG_PAGE = 'https://www.kuwo.cn/play_detail/';

type Candidate = { id: string; url: string; format: string; bitrate: number; duration: number; source: string };
type Cached = { url: string; ext: string; expected: number };

/** `kuwo.cn/play_detail/<rid>`、`?musicId=` / `?rid=`、`MUSIC_<digits>`、裸 rid。 */
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

const pad2 = (n: number) => String(n).padStart(2, '0');

/** lrclist → LRC。time 是秒，统一成 `[mm:ss.cc]`（先归一到百分秒再拆，避免 12.999 写成 12.100）。 */
export function toLrc(list: Array<{ time?: string | number; lineLyric?: string }>): string {
  return (list || []).map((one) => {
    const sec = Number(one.time);
    const t = Number.isFinite(sec) ? Math.max(0, sec) : 0;
    const total = Math.round(t * 100);
    const mm = Math.floor(total / 6000);
    const ss = Math.floor((total % 6000) / 100);
    const cs = total % 100;
    return `[${pad2(mm)}:${pad2(ss)}.${pad2(cs)}]${String(one.lineLyric || '')}`;
  }).join('\n');
}

function headers(referer = REFERER): Record<string, string> {
  return { Referer: referer, Accept: 'application/json, text/plain, */*' };
}

async function json(url: string): Promise<any> {
  const res = await request(url, { headers: headers(), timeoutMs: 20_000 });
  if (!res.ok) throw new VdlError(`http_${res.status}`, `酷我接口 HTTP ${res.status}`);
  return res.json();
}

async function textOf(url: string, referer = REFERER): Promise<string> {
  const res = await request(url, { headers: headers(referer), timeoutMs: 20_000 });
  return res.text();
}

/** 酷我搜索返回单引号伪 JSON，只能按字段抠。 */
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

type SongInfo = {
  title: string; artist: string; album: string; pic: string;
  duration: number; lrc: string; warn?: string; degraded: boolean;
};

async function songInfo(rid: string): Promise<SongInfo> {
  let data: any = null;
  // 这个接口会间歇性返回空 songinfo/lrclist，多试几次并保留信息更多的那次
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const body = await json(SONG_INFO + rid);
      const next = body?.data;
      const score = (d: any) => (d?.songinfo?.songName ? 2 : 0) + (d?.lrclist?.length ? 1 : 0);
      if (!data || score(next) > score(data)) data = next;
      if (score(data) >= 3) break;
    } catch {
      // 继续重试
    }
  }
  const info = data?.songinfo || data?.simpl?.musiclist?.[0] || {};
  const rawLrc: Array<{ time?: string; lineLyric?: string }> = data?.lrclist || [];
  let title = String(info.songName || info.name || '').trim();
  let artist = String(info.artist || '').trim();
  // 匿名请求常常只给歌词：首行通常是「标题 - 歌手」，拿它兜底
  if (!title) {
    const first = String(rawLrc[0]?.lineLyric || '').trim();
    const m = /^(.+?)\s+-\s+(.+)$/.exec(first);
    if (m) {
      title = m[1].trim();
      artist = artist || m[2].trim();
    } else if (first) {
      title = first;
    }
  }
  let album = String(info.album || '').trim();
  let pic = String(info.pic || '').trim();
  let warn = '';
  if (!title) {
    title = `kuwo-${rid}`;
    warn = '未能获取歌曲信息（接口返回空或 301 查询失败），标题先用 rid 代替；下载时会尝试读文件内嵌标签补全';
  }
  if (title && (!artist || !album || !pic)) {
    const extra = await searchMeta(title, rid);
    if (extra) {
      artist = artist || extra.artist;
      album = album || extra.album;
      pic = pic || extra.pic;
    }
  }
  const cover = pic && !/star\/starheads/i.test(pic)
    ? pic.replace(/^http:/i, 'https:').replace(/\/albumcover\/\d+\//i, '/albumcover/500/')
    : '';
  return {
    title, artist, album, pic: cover,
    duration: Number(info.duration || 0) || 0,
    lrc: rawLrc.length ? toLrc(rawLrc) : '',
    degraded: !!warn,
    ...(warn ? { warn } : {}),
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

function labelOf(cand: Candidate, size: number, duration: number): { label: string; clip: boolean } {
  const fmt = cand.format.toLowerCase();
  const kbps = cand.bitrate || (size && duration ? Math.round((size * 8) / duration / 1000) : 0);
  if (fmt === 'flac') return { label: 'FLAC 无损', clip: false };
  const clip = kbps > 0 && kbps < 48;
  if (clip) return { label: `试听片段（约 ${Math.round((size * 8) / 128000)}s）`, clip: true };
  if (kbps > 0) return { label: `${kbps}kbps`, clip: false };
  return { label: fmt ? fmt.toUpperCase() : '码率未标注', clip: false };
}

export type KuwoProbeInternal = { probe: ProbeResult; urls: Map<string, Cached>; info: SongInfo };

export async function probeImpl(input: string): Promise<KuwoProbeInternal> {
  const rid = parseRid(input);
  if (!rid) throw new VdlError('bad_input', `识别不出酷我音乐 id: ${input}`);
  const urls = new Map<string, Cached>();

  const info = await songInfo(rid);
  if (!info.title && !info.artist) {
    throw new VdlError('not_found', `查不到这首曲子（rid=${rid}）`, '确认是酷我音乐的单曲链接');
  }

  const warnings: string[] = [];
  if (info.warn) warnings.push(info.warn);
  const formats: Format[] = [];
  const candidates = [await mobi(rid), await anti(rid)].filter(Boolean) as Candidate[];

  for (const cand of candidates) {
    const audio = await probeAudioUrl(cand.url, REFERER);
    if (!audio.ok) {
      warnings.push(`候选地址（${cand.source}）不可用：${audio.reason}`);
      continue;
    }
    if (formats.some((f) => f.id === cand.id)) continue;
    const duration = cand.duration || info.duration;
    const { label, clip } = labelOf(cand, audio.size, duration);
    // mobi 与 antiserver 常指向同一个文件：字节与标签都一样就当一档
    if (formats.some((f) => f.bytes === audio.size && f.label === label)) continue;
    if (clip) warnings.push(`「${info.title}」可下载的只有 ${label}，不像整首——正片可能受限`);
    const ext = cand.format.toLowerCase() === 'flac' ? 'flac'
      : cand.format.toLowerCase() === 'aac' ? 'm4a' : 'mp3';
    urls.set(cand.id, { url: cand.url, ext, expected: audio.size });
    formats.push(format({
      id: cand.id,
      label,
      ext,
      acodec: ext,
      bytes: audio.size || null,
      bitrate: (cand.bitrate || 0) * 1000 || null,
    }));
  }

  if (!formats.length) {
    throw new VdlError('filtered', `「${info.title || rid}」没有公开可下载的音频地址`,
      '酷我公开通道只放行部分曲目；端上不支持登录，也不会逆向签名或伪造会员');
  }
  formats[0].recommended = true;

  const probe: ProbeResult = {
    schema: 2,
    ok: true,
    platform: 'kuwo',
    engine: 'kuwo-web-mobile',
    media: {
      id: rid,
      title: info.title || `kuwo_${rid}`,
      author: info.artist,
      duration_ms: info.duration ? info.duration * 1000 : null,
      thumbnail: info.pic,
      source_url: SONG_PAGE + rid,
      platform: 'kuwo',
      parts: [],
    },
    formats,
    warnings,
    error: null,
  };
  return { probe, urls, info };
}

export async function probeKuwo(input: string): Promise<ProbeResult> {
  return (await probeImpl(input)).probe;
}

export async function downloadKuwo(
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

  const warnings: string[] = [];
  let stem = stemOf(probe.media!.id, info.title, fmt.label, safeName);
  let name = `${stem}.${cached.ext}`;

  const { bytes, resumeFrom } = await downloadToStaging(cached.url, name, REFERER, {
    onProgress: (written, total) => {
      const planned = cached.expected || total;
      hooks.onProgress?.(written, planned || total);
    },
    onReady: hooks.onReady,
  });
  assertNotTruncated(bytes, cached.expected, '音频');

  // 元数据降级时，文件自带的 ID3 比 rid 命名可靠：读得出来就改名（不猜）
  if (info.degraded) {
    try {
      const head = await readHead(name, 256 * 1024);
      const tags = readId3v2(head.bytes);
      if (tags.title) {
        const better = `${stemOf(probe.media!.id, tags.title, fmt.label, safeName)}.${cached.ext}`;
        await call('fs.rename', { from: name, to: better });
        warnings.push(`接口没给元数据，标题/歌手取自文件内嵌标签：${tags.title}`);
        name = better;
        stem = better.replace(/\.[^.]+$/, '');
        info.artist = info.artist || tags.artist || '';
        info.album = info.album || tags.album || '';
        info.title = tags.title;
      }
    } catch {
      // 读不出来就保持 rid 命名
    }
  }

  warnings.push(...await tagStaged(name, {
    title: info.title, artist: info.artist, album: info.album,
  }, info.pic ? { url: info.pic, referer: REFERER } : null));

  const published = await publishStaged(name);
  if (published.note) warnings.push(published.note);

  // 歌词：失败不影响音频（与桌面端同一条规矩）
  if (info.lrc) {
    try {
      await writeTextSidecar(`${stem}.lrc`, info.lrc);
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
