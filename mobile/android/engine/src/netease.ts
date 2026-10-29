/**
 * 端上网易云引擎（M1 清单里的第二项）。
 *
 * 与桌面端 `ts/src/engines/netease.ts` 的关系：
 * - **probe 的判定规则逐条对齐**（四档全探、`available:false` + 真实 code、按字节判重、
 *   显式档位不静默降级、`need_login`/`filtered`/`no_stream`/`incomplete_media`）；
 * - **落盘不走同一段代码**：桌面用 `node:fs` + ffmpeg 打标签，端上只能走原生流式下载
 *   + `audiometa` 写标签。硬要共用就会出现「一端能用、另一端 import 到 node:fs 直接崩」。
 *
 * 端上没有登录能力（不移植 playwright）：所以永远按匿名档位取，
 * 会员专享曲会如实报 `need_login` —— 不假装能下，也不把「没权益」说成「文件坏了」。
 */
import { request } from '../../../../ts/src/core/http';
import { VdlError } from '../../../../ts/src/core/errors';
import { safeName } from '../../../../ts/src/core/naming';
import { format, type Format, type ProbeResult } from '../../../../ts/src/core/types';
import { buildAudioTag, imageSize, type Cover } from './audiometa';
import { readHead, rewriteStaged, writeTextAndPublish } from './staging';
import { call } from '../shims/bridge';
import { startTransfer } from '../shims/transfer';

const API = 'https://music.163.com';

/** 与桌面端同一张表：只探无损/320K 会让没权益的账号一首歌都下不了。 */
const LEVELS: Array<[number, string, string]> = [
  [999000, 'lossless', '无损 FLAC'],
  [320000, 'exhigh', '极高 320K'],
  [128000, 'standard', '标准 128K'],
  [96000, 'low', '较低 96K'],
];

type UrlEntry = { url: string; declared: number; ext: string; label: string };
/** `song` 只给下载侧取专辑名/发行时间用，不进对外契约。 */
type ProbeBundle = { probe: ProbeResult; urls: Map<string, UrlEntry>; song: any };

/** 桌面端同一套链接解析：裸数字 / `?id=` / `/song/<id>`。 */
export function extractSongId(input: string): string {
  const raw = (input || '').trim();
  if (/^\d+$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const id = url.searchParams.get('id');
    if (id && /^\d+$/.test(id)) return id;
    const m = /\/song\/(\d+)/.exec(url.pathname);
    if (m) return m[1];
  } catch {
    return '';
  }
  return '';
}

function headers(): Record<string, string> {
  // UA 由 core/http 统一加；这里只补网易云要求的 Referer（不带给 `-460` 风控）
  return { Referer: `${API}/` };
}

async function apiJson(path: string): Promise<any> {
  const res = await request(API + path, { headers: headers(), timeoutMs: 15000 });
  if (!res.ok) throw new VdlError('network', `网易云接口 HTTP ${res.status}`, '稍后重试');
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // 风控页是 HTML：解析失败要说「不是 JSON」，不能说成「下载失败」
    throw new VdlError('api_error', '网易云接口返回的不是 JSON（可能被风控）', '稍后重试');
  }
}

async function headSize(url: string): Promise<number> {
  try {
    const res = await request(url, { method: 'HEAD', headers: headers(), timeoutMs: 10000 });
    const value = Number(res.headers.get('content-length') || 0);
    return value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function probeImpl(input: string): Promise<ProbeBundle> {
  const sid = extractSongId(input);
  if (!sid) throw new VdlError('bad_input', `识别不出歌曲 ID: ${input}`);
  const urls = new Map<string, UrlEntry>();

  const detail = await apiJson(`/api/song/detail/?id=${sid}&ids=%5B${sid}%5D`);
  const song = (detail.songs || [])[0];
  if (!song) throw new VdlError('not_found', `查不到这首歌（id=${sid}）`);

  const formats: Format[] = [];
  const denied: string[] = [];
  const deniedCodes: number[] = [];
  const warnings: string[] = [];

  for (const [br, level, label] of LEVELS) {
    const data = await apiJson(`/api/song/enhance/player/url?ids=%5B${sid}%5D&br=${br}`);
    const item = (data.data || [])[0];
    const code = Number(item?.code ?? 0);
    const url = String(item?.url || '');

    if (!item || code !== 200 || !url) {
      const reason = !item
        ? '接口没有返回这个档位'
        : code !== 200
          ? `接口未放行（code=${item.code}）`
          : '接口没有给出地址（url 为空）';
      formats.push(format({ id: level, label, ext: 'mp3', acodec: 'mp3', bitrate: br, available: false, reason }));
      denied.push(`${label}${code && code !== 200 ? `(code=${code})` : ''}`);
      if (code && code !== 200) deniedCodes.push(code);
      continue;
    }

    const declared = Number(item.size || 0);
    const real = await headSize(url);
    const ext = String(item.type || 'mp3').toLowerCase();
    const size = real || declared || 0;
    // 与桌面端同一条：接口「请求无损给 320K」不报错（实测 br=320000 / type=mp3），
    // 照抄请求档位会让文件名写着「无损 FLAC」而文件是 320K mp3
    const actualBr = Number(item.br || 0) || 0;
    const downgraded = actualBr > 0 && actualBr < br * 0.95;
    const shownLabel = downgraded ? `${Math.round(actualBr / 1000)}K` : label;
    if (downgraded) {
      warnings.push(`请求${label}档，接口实际返回 ${Math.round(actualBr / 1000)}K（br=${actualBr}、type=${ext}）`
        + '，可能没有该档权益');
    }
    // 地址登记在前：即使下面因为「同一个文件」不单列，显式点名这个 id 仍要能命中
    urls.set(level, { url, declared, ext, label: shownLabel });

    const sameFile = size > 0 && formats.some((f) => f.available && f.bytes === size);
    if (sameFile) {
      warnings.push(`${shownLabel} 接口返回的文件与已有档位字节相同，已合并为一条`);
    } else {
      formats.push(format({
        id: level, label: shownLabel, ext, acodec: ext,
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
    // 端上永远没有 cookie，所以这里只会是 need_login（除非接口全给了空地址之外的错）
    const suffix = deniedCodes.length ? `（code=${[...new Set(deniedCodes)].join('/')}）` : '';
    throw new VdlError('need_login', `没有匿名可用的地址${suffix}`,
      '该曲可能需要会员权益：请用电脑登录后再下（手机端暂不支持登录）');
  }
  available[0].recommended = true;
  warnings.unshift('手机端未登录，仅匿名可取的档位（无损/320K 通常需要对应权益）');
  if (denied.length) warnings.push(`本次未放行：${denied.join('、')}`);

  const album = song.album || {};
  const artists = (song.artists || []).map((a: any) => a.name || '').filter(Boolean);
  const probe: ProbeResult = {
    schema: 2, ok: true, platform: 'netease', engine: 'netease-api-mobile',
    media: {
      id: String(sid),
      title: song.name || `netease_${sid}`,
      author: artists.join(' / '),
      duration_ms: Number(song.duration || 0) || null,
      thumbnail: String(album.picUrl || ''),
      source_url: `${API}/song?id=${sid}`,
      platform: 'netease', parts: [],
    },
    formats, warnings, error: null,
  };
  return { probe, urls, song };
}

export type NeteaseProbeExtras = {
  /** 详情接口给的整曲声明字节（用于下载后的完整性核对）。 */
  declared: number;
  ext: string;
  label: string;
};

/** 端上 probe：只返回契约形状，附带的地址表不外泄（下载时内部重新 probe）。 */
export async function probeNetease(input: string): Promise<ProbeResult> {
  const { probe } = await probeImpl(input);
  return probe;
}

export type NeteaseDownloadHooks = {
  onProgress?: (bytes: number, total: number) => void;
  onReady?: (jobId: string, resumeFrom: number) => void;
};

export type NeteaseDownloadResult = {
  path: string;
  bytes: number;
  name: string;
  label: string;
  resumeFrom: number;
  ms: number;
  warnings: string[];
};

/** 封面走网易云的 `?param=600y600`：服务端缩放，省一次端上解码，也避免内嵌 5MB 原图。 */
function coverUrl(raw: string): string {
  if (!raw) return '';
  const sep = raw.includes('?') ? '&' : '?';
  return `${raw}${sep}param=600y600`;
}

async function fetchCover(raw: string, warnings: string[]): Promise<Cover | null> {
  if (!raw) return null;
  try {
    const res = await request(coverUrl(raw), { headers: { Referer: `${API}/` }, timeoutMs: 15000 });
    if (!res.ok) {
      warnings.push(`封面 HTTP ${res.status}，已跳过封面`);
      return null;
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (!data.length) return null;
    if (data.length > 1.5 * 1024 * 1024) {
      warnings.push(`封面 ${(data.length / 1048576).toFixed(1)} MB 过大，已跳过`);
      return null;
    }
    const size = imageSize(data);
    if (!size.width || !size.height) {
      warnings.push('封面尺寸解析失败，已跳过封面');
      return null;
    }
    return { mime: size.mime, data, width: size.width, height: size.height, depth: 24 };
  } catch (error) {
    warnings.push(`取封面失败：${(error as Error).message}`);
    return null;
  }
}

/**
 * 下载一首歌：原生流式下到 staging → 写标签（+封面）→ publish → 歌词 sidecar。
 *
 * 三个必须如实的地方（对齐桌面端）：
 * 1. 显式点名档位就必须命中且可用，不许静默换成别的档；
 * 2. 实际字节 < 接口声明 60% 时报 `incomplete_media`（试听片段），不报完成；
 * 3. 写标签失败**不回滚音频**——保留完整音频 + 一条明确 warning，比丢文件好。
 */
export async function downloadNetease(
  input: string,
  formatId: string | null,
  hooks: NeteaseDownloadHooks = {},
): Promise<NeteaseDownloadResult> {
  const started = Date.now();
  const { probe, urls, song } = await probeImpl(input);

  const wanted = (formatId || '').trim();
  let fmt: Format | undefined;
  if (wanted) {
    fmt = probe.formats.find((f) => f.id === wanted);
    if (!fmt) {
      // 未单列但地址登记过的档位（与已有档位同一个文件）仍按 id 命中
      const alias = urls.get(wanted);
      if (alias) fmt = format({ id: wanted, label: alias.label, ext: alias.ext, bytes: alias.declared || null });
    }
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

  const label = safeName(fmt.label, 14, fmt.id);
  const ext = (fmt.ext || cached.ext || 'mp3').toLowerCase();
  const name = `${probe.media!.id}_${safeName(probe.media!.title)}_${label}.${ext}`;

  const handle = await startTransfer({
    url: cached.url,
    name,
    referer: `${API}/`,
    // 关键：先停在 staging。标签要在文件落公共目录**之前**写进去，
    // 否则用户会看到「先出现无标签文件、再被替换」的一瞬，且 publish 会删掉 .part
    publish: false,
    onProgress: hooks.onProgress,
  });
  hooks.onReady?.(handle.jobId, handle.resumeFrom);

  const staged = await handle.done;
  const actual = staged.bytes;
  if (actual < 100 * 1024) {
    throw new VdlError('bad_payload', '文件过小，多半是试听片段或错误页');
  }
  if (cached.declared > 0 && actual < cached.declared * 0.6) {
    throw new VdlError('incomplete_media',
      `只拿到 ${actual} 字节，接口声明整曲约 ${cached.declared} 字节`,
      '可能是试听片段或下载被截断：确认账号权益后重试，或改用其它档位');
  }

  const warnings: string[] = [];

  // 标签与封面
  try {
    const cover = await fetchCover(String(probe.media!.thumbnail || ''), warnings);
    // 年份 / 专辑名取详情接口的原值（桌面端同一口径：时间戳可能是秒或毫秒）
    const publishedAt = Number(song?.publishTime || 0);
    const year = publishedAt
      ? String(new Date(publishedAt > 1e11 ? publishedAt : publishedAt * 1000).getFullYear())
      : '';
    const head = await readHead(name, 512 * 1024);
    if (head.truncated && ext === 'flac') {
      warnings.push('flac 元数据块超过 512KB，未写标签（音频完整）');
    } else {
      const plan = buildAudioTag(head.bytes, {
        title: probe.media!.title,
        artist: probe.media!.author,
        album: String(song?.album?.name || ''),
        year,
        cover,
      }, ext);
      if (plan.note) {
        warnings.push(plan.note);
      } else if (plan.prefix.length) {
        await rewriteStaged(name, plan.prefix, plan.skip);
      }
    }
  } catch (error) {
    warnings.push(`写入标签失败，已保留音频：${(error as Error).message}`);
  }

  const published = await publishStaged(name);

  // 歌词单独落 .lrc（与桌面端同名规则：把扩展名换掉）
  try {
    const lyric = await apiJson(`/api/song/lyric?id=${probe.media!.id}&lv=1&kv=1&tv=-1`);
    const text = String((lyric.lrc || {}).lyric || '').trim();
    if (text) await writeTextAndPublish(`${name.replace(/\.\w+$/, '')}.lrc`, `${text}\n`);
  } catch {
    // 歌词失败不影响音频（与桌面端同一条规矩）
  }

  return {
    path: published.path,
    bytes: published.bytes,
    name: published.name || name,
    label: fmt.label,
    resumeFrom: handle.resumeFrom,
    ms: Date.now() - started,
    warnings,
  };
}

/** publish 单独包一层：失败要让上层看到「文件还在 staging」，不能报成功。 */
async function publishStaged(name: string): Promise<{ path: string; name: string; bytes: number }> {
  return call<{ path: string; name: string; bytes: number }>('fs.publish', { name }, { timeoutMs: 120_000 });
}
