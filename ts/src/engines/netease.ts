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
/**
 * 四档都探。只探无损/320K 的时候，**没有会员的账号一首歌都下不了**——
 * 免费曲本来允许 128K/96K，那是平台放行的范围，不是绕过会员。
 */
const LEVELS: Array<[number, string, string]> = [
  [999000, 'lossless', '无损 FLAC'],
  [320000, 'exhigh', '极高 320K'],
  [128000, 'standard', '标准 128K'],
  [96000, 'low', '较低 96K'],
];

/** `declared` 是接口声明的**整曲**字节数：下载完拿实际字节跟它比，才能发现试听/降质。 */
const formatUrls = operationState(
  () => new Map<string, { url: string; declared: number; ext: string; label: string }>(),
);
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

/**
 * 从各种网易云歌曲链接里取 id。
 *
 * 手机端「分享」出来的链接几乎都是 `https://music.163.com/#/song?id=123`：
 * id 在 **hash** 里，`u.searchParams` 是空的。以前只读 searchParams，
 * 这类链接一律报「识别不出歌曲 ID」——用户照抄分享链接就必然踩到。
 */
export function extractId(url: string): string {
  const raw = (url || '').trim();
  if (/^\d+$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    // 专辑/歌单链接不在这里处理：把专辑 id 当歌曲 id 会下错东西
    if (/\/(album|playlist)\b/.test(`${u.pathname}${u.hash}`)) return '';
    const pickId = (params: URLSearchParams): string => {
      const id = params.get('id');
      return id && /^\d+$/.test(id) ? id : '';
    };
    const fromSearch = pickId(u.searchParams);
    if (fromSearch) return fromSearch;
    const hash = u.hash.replace(/^#/, '');
    if (hash) {
      const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash;
      const fromHash = pickId(new URLSearchParams(query));
      if (fromHash) return fromHash;
    }
    const m = /\/song\/(\d+)/.exec(`${u.pathname}${u.hash}`);
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

async function getJson(path: string, cookie: string, doFetch: typeof fetch = fetch): Promise<any> {
  const res = await doFetch(API + path, { headers: headers(cookie) });
  if (!res.ok) throw new VdlError('network', `网易云接口 HTTP ${res.status}`);
  return res.json();
}

/**
 * 网易云 App 分享出来的短链（`https://163cn.tv/xxxx`）要跟一次跳转才知道指向
 * 歌曲 / 专辑 / 歌单。**只有它需要额外一次网络请求**，其它输入原样返回（零成本）。
 *
 * 2026-11-11 实测：`163cn.tv/` 根路径 301 到 `st.music.163.com/webpage-cntv`（活动页），
 * 无效码直接 403 无 Location。所以「跟随后落在 music.163.com」才算解析成功；
 * 落在活动页或 403 都要如实说，不能把它当成「识别不出歌曲 ID」。
 */
export async function expandShortLink(input: string, doFetch: typeof fetch = fetch): Promise<string> {
  const raw = (input || '').trim();
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return raw;
  }
  if (!/(^|\.)163cn\.tv$/.test(host)) return raw;

  let res: Response;
  try {
    res = await doFetch(raw, {
      method: 'GET', redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    throw new VdlError('network', `短链请求失败：${(err as Error).message}`,
      '检查网络后重试；也可以直接在 App 里复制「完整链接」');
  }
  if (res.status === 403 || res.status === 404) {
    throw new VdlError('bad_input', `短链已失效（HTTP ${res.status}）：${raw}`,
      '分享短链有有效期，回 App 重新复制一次；或改用浏览器地址栏里的完整链接');
  }
  // 跟随之后 res.url 是最终地址；只接受网易云内容站的三个域，别被短链带去任意站点。
  // 不能写成 `*.music.163.com`：活动页在 `st.music.163.com`（实测根路径就跳到那里），
  // 它同样是 music.163.com 的子域，放过去会把「指向活动页」当成「解析成功」。
  let final = '';
  try {
    final = new URL(res.url).href;
  } catch {
    return raw;
  }
  if (!/^(?:y\.|www\.)?music\.163\.com$/i.test(new URL(final).hostname)) {
    throw new VdlError('bad_input', `短链指向的不是歌曲/专辑/歌单：${final}`,
      '这条短链可能指向活动页；回 App 重新复制目标内容的链接');
  }
  return final;
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
  const resolved = await expandShortLink(input);
  const id = parseAlbumId(resolved);
  if (!id) throw new VdlError('bad_input', `识别不出网易云专辑 ID: ${resolved}`);
  const data = await getJson(`/api/album/${id}`, cookieHeader());
  const album = data?.album || {};
  const songs: any[] = album.songs || [];
  if (!songs.length) {
    throw new VdlError('not_found', `专辑里没有可下载的曲目（id=${id}）`,
      '可能是地区限制或接口限流，稍后重试');
  }
  return {
    id,
    kind: 'album',
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

/**
 * 歌单链接：`/playlist?id=123`、`#/playlist?id=123`、手机分享的 `/m/playlist?...`、
 * `/playlist/123`，或裸数字 ID。
 *
 * 与 `parseAlbumId` 一样只认自己的路径：把专辑或歌曲的 id 当歌单会列出完全不相干的东西。
 */
export function parsePlaylistId(input: string): string {
  const raw = (input || '').trim();
  if (/^\d+$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const hay = `${u.pathname}${u.hash}`;
    if (!/\/playlist\b/i.test(hay)) return '';
    const fromQuery = u.searchParams.get('id') || '';
    if (/^\d+$/.test(fromQuery)) return fromQuery;
    const hashQuery = u.hash.includes('?') ? u.hash.slice(u.hash.indexOf('?') + 1) : '';
    const fromHash = new URLSearchParams(hashQuery).get('id') || '';
    if (/^\d+$/.test(fromHash)) return fromHash;
    const m = /\/playlist\/(\d+)/i.exec(hay);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** 单次 `song/detail` 的批量上限：实测 100 个 id 正常返回，再往上没有证据。 */
export const PLAYLIST_SONG_BATCH = 100;

export interface PlaylistDeps {
  fetch?: typeof fetch;
  /** 传 `''` 表示显式不带 cookie（测试用）；不传则读本机凭据。 */
  cookie?: string;
  /** 仅供测试缩小批量，验证分批与顺序还原。 */
  batchSize?: number;
}

/**
 * 歌单曲目（2026-11-11 实测口径）：
 *
 * - `GET /api/v6/playlist/detail?id=X&n=N` 的 `n` 只控制**内联曲目数**（0 / 3 / 1000 / 5000
 *   实测都被截到 `trackCount`），`trackIds` 始终是**全量** id 列表；
 * - `GET /api/playlist/track/all` 已不可用（匿名请求回 `code=404`），不能拿它做分页；
 * - `GET /api/song/detail/?ids=[...]` 一次 100 条正常返回，用它把 trackIds 补成完整曲目。
 *
 * 所以路径是「detail 取 trackIds → 按 100 一批补详情 → 按 trackIds 顺序还原」。
 * 顺序必须按 trackIds 还原：song/detail 的返回顺序不受请求顺序保证。
 */
export async function playlistTracks(input: string, deps: PlaylistDeps = {}): Promise<AlbumInfo> {
  const doFetch = deps.fetch || fetch;
  const resolved = await expandShortLink(input, doFetch);
  const id = parsePlaylistId(resolved);
  if (!id) throw new VdlError('bad_input', `识别不出网易云歌单 ID: ${resolved}`);
  const cookie = deps.cookie === undefined ? cookieHeader() : deps.cookie;
  const warnings: string[] = [];

  // n=0：只要元信息与 trackIds，不把几百首曲目重复拉一遍（实测 472KB → 34KB）
  const detail = await getJson(`/api/v6/playlist/detail?id=${id}&n=0`, cookie, doFetch);
  const playlist = detail?.playlist;
  if (!playlist) {
    const code = Number(detail?.code ?? 0);
    throw new VdlError(code === 404 ? 'not_found' : 'api_shape',
      `没拿到歌单信息（id=${id}，code=${code || '无'}）`,
      '确认歌单是公开的；私密歌单需要先在电脑上登录，再重试');
  }

  const pickIds = (list: unknown): string[] => (Array.isArray(list) ? list : [])
    .map((x: any) => String(x?.id ?? x ?? ''))
    .filter((v: string) => /^\d+$/.test(v));

  let trackIds = pickIds(playlist.trackIds);
  const declared = Number(playlist.trackCount || 0);

  // trackIds 全量返回是实测结论、不是文档承诺：真遇到空的就退回「默认 n 的详情」再取一次，
  // 仍为空才用首屏 tracks 的 id，并如实说明这是不完整的一屏。
  if (!trackIds.length && declared > 0) {
    const fallback = await getJson(`/api/v6/playlist/detail?id=${id}`, cookie, doFetch);
    const fp = fallback?.playlist || {};
    trackIds = pickIds(fp.trackIds);
    if (!trackIds.length) trackIds = pickIds(fp.tracks);
    if (trackIds.length) {
      warnings.push('接口没有返回完整曲目 ID 列表，本次只列详情里的首屏曲目');
    }
  }

  if (!trackIds.length) {
    throw new VdlError('not_found', `歌单里没有可下载的曲目（id=${id}）`,
      declared > 0
        ? `接口声明 ${declared} 首但没有给出曲目 ID：可能是私密歌单或地区限制，登录后重试`
        : '确认这个歌单不是空的');
  }
  if (declared > trackIds.length) {
    warnings.push(`接口声明 ${declared} 首，只给了 ${trackIds.length} 条曲目 ID，本次按实际拿到的列出`);
  }

  const batchSize = Math.max(1, Math.min(500, deps.batchSize || PLAYLIST_SONG_BATCH));
  const songs: any[] = [];
  for (let i = 0; i < trackIds.length; i += batchSize) {
    const batch = trackIds.slice(i, i + batchSize);
    const data = await getJson(`/api/song/detail/?ids=%5B${batch.join(',')}%5D`, cookie, doFetch);
    const got: any[] = Array.isArray(data?.songs) ? data.songs : [];
    if (got.length < batch.length) {
      // 不在这里抛：下架曲目本来就查不到详情，但同批其它曲目是好的
      warnings.push(`第 ${i + 1}–${i + batch.length} 首里只拿到 ${got.length} 首详情`);
    }
    songs.push(...got);
  }

  const byId = new Map<string, any>();
  for (const song of songs) byId.set(String(song?.id ?? ''), song);
  const tracks: AlbumTrack[] = [];
  for (const tid of trackIds) {
    const song = byId.get(tid);
    if (!song) continue;
    tracks.push({
      id: tid,
      title: String(song.name || ''),
      author: (song.ar || song.artists || [])
        .map((a: any) => String(a.name || '')).filter(Boolean).join(' / '),
      url: `${API}/song?id=${tid}`,
    });
  }
  const missing = trackIds.length - tracks.length;
  if (missing > 0) {
    warnings.push(`${missing} 首拿不到详情（多为下架或无版权），本地列表里不会有它们`);
  }
  if (!tracks.length) {
    throw new VdlError('not_found', `歌单里的曲目都拿不到详情（id=${id}）`,
      '可能整单下架或地区限制；换一个歌单或登录后重试');
  }

  return {
    id,
    kind: 'playlist',
    title: String(playlist.name || `playlist_${id}`),
    cover: String(playlist.coverImgUrl || ''),
    tracks,
    warnings,
  };
}

async function probeNeteaseImpl(url: string): Promise<ProbeResult> {
  // App 分享的 163cn.tv 短链要先跟一次跳转（其它输入原样返回，不发请求）
  const resolved = await expandShortLink(url);
  const sid = extractId(resolved);
  if (!sid) {
    // 歌单/专辑不是"解析失败"：它们是另一条批量入口，错误里直接给出怎么走，
    // 否则用户会以为是链接坏了（界面上由 isAlbumUrl 提前分流，走不到这里）。
    const batch = parsePlaylistId(resolved) ? { kind: '歌单', flag: '--playlist' }
      : parseAlbumId(resolved) ? { kind: '专辑', flag: '--album' }
        : null;
    throw new VdlError(
      'bad_input',
      batch ? `这是${batch.kind}链接，不是单曲：${resolved}` : `识别不出歌曲 ID: ${resolved}`,
      batch ? `走批量入口：bun ts/src/cli.ts get "<链接>" ${batch.flag} --dry-run` : '',
    );
  }
  const cookie = cookieHeader();
  formatUrls().clear();
  songState().lastSong = null;

  const detail = await getJson(`/api/song/detail/?id=${sid}&ids=%5B${sid}%5D`, cookie);
  const song = (detail.songs || [])[0];
  // 详情里没有这首歌 = 查不到；跟「有歌但没权益」是两回事，码不能混用
  if (!song) throw new VdlError('not_found', `查不到这首歌（id=${sid}）`);
  songState().lastSong = song;

  // 两个档位**全部**进 formats：放行的 available=true，没放行的 available=false + reason。
  // 旧实现直接丢掉未放行档，界面看起来像「平台只有一档」。
  const formats: Format[] = [];
  const denied: string[] = [];
  const deniedCodes: number[] = [];
  const warnings: string[] = [];

  for (const [br, level, label] of LEVELS) {
    const data = await getJson(
      `/api/song/enhance/player/url?ids=%5B${sid}%5D&br=${br}`, cookie);
    const item = (data.data || [])[0];
    const code = Number(item?.code ?? 0);
    const url = String(item?.url || '');

    if (!item || code !== 200 || !url) {
      // 只报证据：平台的 code/空地址不能反推成「需要会员」
      const reason = !item
        ? '接口没有返回这个档位'
        : code !== 200
          ? `接口未放行（code=${item.code}）`
          : '接口没有给出地址（url 为空）';
      formats.push(format({
        id: level, label, ext: 'mp3', acodec: 'mp3',
        bitrate: br, available: false, reason,
      }));
      denied.push(`${label}${code && code !== 200 ? `(code=${code})` : ''}`);
      if (code && code !== 200) deniedCodes.push(code);
      continue;
    }

    const declared = Number(item.size || 0);
    const real = await headSize(url);
    const ext = String(item.type || 'mp3').toLowerCase();
    const size = real || declared || 0;
    // 接口会「请求无损给 320K」而不报错：实测免费曲 2007983648 的 999000 档返回
    // br=320000 / type=mp3 / 10.3MB。照抄请求档位当标签就是撒谎——文件名会写着
    // 「无损 FLAC」而文件是 320K mp3。
    //
    // 但**不能只比 br**：真无损时接口给的是 FLAC 编码后的实际码率（实测 477K / 901K / 1546K），
    // 拿它跟请求档位 999000 比会把真无损误判成降级（2026-10-30 用黑胶会员账号踩到）。
    // 判据改成「无损档要求 type=flac；其它档才比码率」。
    const actualBr = Number(item.br || 0) || 0;
    const expectFlac = br >= 999000;
    const downgraded = expectFlac
      ? ext !== 'flac'
      : actualBr > 0 && actualBr < br * 0.95;
    const shownLabel = downgraded ? `${Math.round(actualBr / 1000)}K` : label;
    if (downgraded) {
      warnings.push(`请求${label}档，接口实际返回 ${Math.round(actualBr / 1000)}K（br=${actualBr}、type=${ext}）`
        + '，可能没有该档权益');
    }
    // 地址与档位信息都登记：即使下面因为「同一个文件」不单列，--format 用这个 id 仍能命中
    formatUrls().set(level, { url, declared, ext, label: shownLabel });

    // 不同 br 常常指向同一个文件：实测 128K 与 96K 会返回**不同 URL 但字节完全相同**的文件。
    // 按「字节相同」判重而不是只比 URL，否则界面会出现「128K 3.93MB / 96K 3.93MB」这种自相矛盾的列表。
    const sameFile = size > 0 && formats.some((f) => f.available && f.bytes === size);
    if (sameFile) {
      warnings.push(`${shownLabel} 接口返回的文件与已有档位字节相同，已合并为一条`);
    } else {
      formats.push(format({
        id: level, label: shownLabel, ext, acodec: ext,
        // HEAD 拿到的是「实际能下多少」，但也可能是试听片段的大小；
        // 真正的完整性判定在 get（下载完成后的实际字节 vs declared）
        bytes: size || null,
        bitrate: Number(item.br || 0) || null,
      }));
      if (real > 0 && declared > 0 && real < declared * 0.6) {
        const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
        warnings.push(`${label} 实际可下载 ${mb(real)}，明显小于接口声明 ${mb(declared)}（可能是试听片段）`);
      }
    }
  }

  const available = formats.filter((f) => f.available);
  if (!available.length) {
    const suffix = deniedCodes.length
      ? `（code=${[...new Set(deniedCodes)].join('/')}）`
      : '';
    if (cookie) {
      throw new VdlError('filtered', `所有档位都没有拿到地址${suffix}`,
        '确认账号是否具备该曲权益；若已开通仍失败，请把上面的代码记下来反馈');
    }
    throw new VdlError('need_login', `没有匿名可用的地址${suffix}`,
      '登录后重试：bun ts/src/cli.ts auth netease');
  }
  available[0].recommended = true;

  warnings.unshift(cookie
    ? '已登录，档位以账号权益为准'
    : '未登录，仅匿名可取的档位（无损/320K 通常需要对应权益）');
  if (denied.length) warnings.push(`本次未放行：${denied.join('、')}`);

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
    formats, warnings, error: null,
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
  // 显式点名了档位就不能换：静默降级会让用户以为拿到的是无损，实际是 320K
  const wanted = (formatId || '').trim();
  let fmt: Format | undefined;
  if (wanted) {
    fmt = probe.formats.find((f) => f.id === wanted);
    if (!fmt) {
      // 与已列档位是同一个文件时不会单列，但地址仍登记着：按别名继续
      const alias = formatUrls().get(wanted);
      if (alias) {
        fmt = format({
          id: wanted, label: alias.label, ext: alias.ext,
          bytes: alias.declared || null,
        });
      }
    }
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
  const cached = formatUrls().get(fmt.id);
  if (!cached) throw new VdlError('no_stream', '该档位没有可用地址');
  const url = cached.url;
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
  const actual = await streamTo(url, part);
  if (actual < 100 * 1024) {
    unlinkSync(part);
    throw new VdlError('bad_payload', '文件过小，多半是试听片段或错误页');
  }
  // 「能播放」不等于「拿到整曲」：无损档的试听片段也可能上百 KB，
  // 所以拿实际字节跟接口声明的整曲大小比一次，偏差过大就不报完成。
  // .part 保留：万一是网络截断，重试可以续传。
  if (cached.declared > 0 && actual < cached.declared * 0.6) {
    throw new VdlError('incomplete_media',
      `只拿到 ${actual} 字节，接口声明整曲约 ${cached.declared} 字节`,
      '可能是试听片段或下载被截断：确认账号权益后重试，或改用其它档位');
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
  return formatUrls().get(formatId)?.url || "";
}

export const probeNetease = scopedOperation(probeNeteaseImpl);

export const getNetease = scopedOperation(getNeteaseImpl);
