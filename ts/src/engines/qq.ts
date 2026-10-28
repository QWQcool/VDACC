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

import type { AlbumInfo, AlbumTrack } from '../core/album';
import { throwIfCancelled } from '../core/cancel';
import { releaseDest, reserveDest } from '../core/dest';
import { runFfmpeg } from '../core/ffmpeg';
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

/** probe 时按档位缓存播放地址（purl 带 vkey，会过期，所以每次下载都重新 probe）。
 *  `declared` 是接口声明的**整曲**字节数：下载完拿实际字节跟它比，才能发现试听片段/截断。 */
const urlCache = operationState(() => new Map<string, { url: string; ext: string; declared: number }>());
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

/** `expired` 单独回报：cookie 文件在、但都过期了，跟「从没登录」是两回事，不能都显示成「未登录」。 */
interface CredentialState { cred: Credential | null; expired: boolean }

/**
 * 读 `auth qq` 写下的 storage_state，凑 vkey 需要的 uin + qm_keyst。
 * cookie 里 `uin` 常带前导 `o`（o1234567890），接口要纯数字；qm_keyst 可能要 decode。
 * 返回值只用于请求参数，不打印、不入日志。
 */
function loadCredential(): CredentialState {
  const file = join(process.env.LOCALAPPDATA || '', 'vdl', 'auth', 'qq.json');
  if (!existsSync(file)) return { cred: null, expired: false };
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const now = Date.now() / 1000;
    const scoped = (state.cookies || []).filter((c: any) => String(c.domain || '').includes('qq.com'));
    const live = scoped.filter((c: any) => !c.expires || c.expires < 0 || c.expires > now);
    const get = (name: string) =>
      String(live.find((c: any) => c.name === name)?.value || '');
    const uin = (get('uin') || get('p_uin') || get('pt2gguin'))
      .replace(/^o/i, '').replace(/\D/g, '');
    let authst = get('qm_keyst') || get('qqmusic_key');
    try { authst = decodeURIComponent(authst); } catch { /* 保持原值 */ }
    if (uin && authst) return { cred: { uin, authst }, expired: false };
    // 关键字段缺失时才可能是过期；文件损坏或从未登录都不算「过期」
    return { cred: null, expired: scoped.length > 0 && live.length < scoped.length };
  } catch {
    return { cred: null, expired: false };
  }
}

/** 只用于把字节数说清楚（警告文案里不要出现裸数字）。 */
function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)} MB`;
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
  const { cred, expired } = loadCredential();
  const { sip, items } = await fetchVkeys(mid, cred);

  // 四个档位**全部**进 formats：放行的 available=true，没放行的 available=false + reason。
  // 旧实现把未放行档直接丢掉，用户看不到「想要的档位为什么没有」；
  // 界面上的档位按钮本来就是按 available 置灰的（web/vue/index.html:225）。
  const formats: Format[] = [];
  const denied: string[] = [];
  const warnings: string[] = [];

  for (const quality of QUALITIES) {
    const id = quality.prefix.toLowerCase();
    const filename = `${quality.prefix}${mid}.${quality.ext}`;
    const item = items.find((x) => x.filename === filename);
    const purl = item?.purl || '';

    if (!item || item.result !== 0 || !purl) {
      // 只记录证据：接口没返回 ≠ 会员缺失；result≠0 也只报代码，不猜原因
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
    urlCache().set(id, { url, ext: quality.ext, declared });
    formats.push(format({
      id,
      label: quality.label,
      ext: quality.ext,
      acodec: quality.ext,
      bytes: real || declared || null,
      bitrate: quality.bitrate,
    }));

    // 可播放 ≠ 可取全曲：实际可下载字节明显小于接口声明时，先把怀疑讲出来；
    // 真正的判定放到 get（那里才有下载完成后的实际字节）。
    if (real > 0 && declared > 0 && real < declared * 0.6) {
      warnings.push(`${quality.label} 实际可下载 ${mb(real)}，明显小于接口声明 ${mb(declared)}（可能是试听片段）`);
    }
  }

  const available = formats.filter((f) => f.available);
  if (!available.length) {
    const codes = [...new Set(items.map((x) => Number(x.result || 0)).filter((x) => x !== 0))];
    const suffix = codes.length ? `（result=${codes.join('/')}）` : '';
    if (cred) {
      throw new VdlError('filtered', `所有档位都被接口拒绝${suffix}`,
        '确认账号是否具备该曲权益；若已开通仍失败，请把上面的代码记下来反馈');
    }
    throw new VdlError('need_login', `没有匿名可用的播放地址${suffix}`,
      '登录后重试：bun ts/src/cli.ts auth qq；若登录后仍失败，请记录上面的代码反馈');
  }
  available[0].recommended = true;

  // 有登录就说登录，没登录就说「仅匿名档」——实测同一首歌登录与否可能完全一样，
  // 差别在账号权益，不能因为 cookie 存在就暗示档位更高。
  // 凭据过期要单独说：否则用户以为自己还登着。
  if (cred) {
    warnings.unshift('已登录，档位以账号权限为准');
  } else if (expired) {
    warnings.unshift('本地登录凭据已过期（cookie 失效），本次按匿名档处理，需重新 `auth qq`');
  } else {
    warnings.unshift('未登录，仅匿名档（320K/FLAC 匿名未放行，本次不包含）');
  }
  if (denied.length) warnings.push(`本次未放行：${denied.join('、')}`);

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
  // 显式点名了档位就不能换：静默降级会让用户以为拿到的是 320K，实际是 128K。
  // 与 N02「缺档位改为显式 no_stream」保持一致。
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

  mkdirSync(outDir, { recursive: true });
  const dest = reserveDest(outDir,
    `${probe.media!.id}_${safeName(probe.media!.title)}_${safeName(fmt.label, 16, fmt.id)}.${cached.ext}`);
  try {
  if (existsSync(dest)) {
    return { path: dest, bytes: statSync(dest).size, skipped: true, warnings: [] };
  }

  const part = dest + '.part';
  const actual = await streamTo(cached.url, part);
  if (actual < 100 * 1024) {
    unlinkSync(part);
    throw new VdlError('bad_payload', '文件过小，多半是试听片段或错误页');
  }
  // 「能播放」不等于「拿到整曲」。30 秒试听片段通常 300–500KB，远大于上面的 100KB 门槛，
  // 所以必须跟接口声明的整曲字节数比一次；偏差过大就不报完成。
  // .part 保留：万一是网络截断，重试可以直接续传。
  if (cached.declared > 0 && actual < cached.declared * 0.6) {
    throw new VdlError('incomplete_media',
      `只拿到 ${actual} 字节，接口声明整曲约 ${cached.declared} 字节`,
      '可能是试听片段或下载被截断：确认账号权益后重试，或改用其它档位');
  }

  // 歌词是附属产物：失败了也照样出音频，不往上抛
  const lyric = await fetchLyric(probe.media!.id);
  if (lyric) writeFileSync(dest.replace(/\.\w+$/, '.lrc'), lyric + '\n', 'utf8');

  const warnings: string[] = [];
  // 临时封面跟着目标文件走，避免并发下载互相覆盖
  const rawCover = dest + '.cover.img';
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

  const run = await runFfmpeg(args);
  try { unlinkSync(rawCover); } catch { /* 没有封面 */ }

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
 * 状态口径（2026-10-27，见 docs/design/qq-capability-baseline.md）：
 * - 四个档位**全部**进 probe.formats；接口没放行的档位 `available:false` + `reason` 带真实
 *   `result` 代码或「接口没有返回」，**不推断**是会员、付费还是地区限制。
 * - 有凭据但全档被拒 → `filtered`；没有凭据 → `need_login`；两者文案不同。
 * - 显式指定档位不可用时直接 `no_stream`，不静默换档。
 * - 下载字节明显小于接口声明的整曲大小 → `incomplete_media`（试听片段/截断），不报完成。
 *
 * 未做（不假装支持）：
 * - 320K/FLAC：登录后仍实测 104003（《雨爱》《我怀念的》《告白气球》等），
 *   档位由账号会员权限决定；代码已带 uin+authst，换会员账号会自动生效，但没有验证过。
 *   这里只保证「如实报告受限」，不做任何绕过。
 * - 搜索：`DoSearchForQQMusicDesktop` 时好时坏——同一账号一次 code=0 返回 3 条，
 *   下一次 2001；不接关键词搜索，只吃 mid / 分享链接。
 * - 其它容器（APE / 192K AAC / DTS）：没验证，先不铺。
 */

export const probeQQ = scopedOperation(probeQQImpl);

export const getQQ = scopedOperation(getQQImpl);
