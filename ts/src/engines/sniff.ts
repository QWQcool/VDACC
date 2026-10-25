/**
 * L2 通用嗅探：只做 **m3u8** 与 **直链媒体**（mp4/webm/mov/mkv/m4v/flv）。
 *
 * 边界（明确不做）：
 * - 不跑页面 JS、不抓 blob/MSE，也不去猜网页里的播放器地址——那类页面交给 yt-dlp 兜底；
 * - 只认「URL 本身就是媒体」或「返回体就是 m3u8」的情况，所以 `canHandle` 看扩展名，不会误判网页。
 */
import { operationState, scopedOperation } from '../core/operation';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { streamToFile } from '../core/audio';
import { DownloadCancelled, throwIfCancelled } from '../core/cancel';
import { VdlError } from '../core/errors';
import { UA, request } from '../core/http';
import { safeName } from '../core/naming';
import { report } from '../core/progress';
import { format, type Format, type ProbeResult } from '../core/types';

const DIRECT_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'flv', 'm3u8']);
const MEDIA_TYPE = /^(?:video\/|audio\/(?:mpeg|mp4|aac)|application\/vnd\.apple\.mpegurl|application\/octet-stream)/i;

const urlCache = operationState(() => new Map<string, { url: string; hls: boolean }>());

export function sniffExt(url: string): string {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 扩展名决定要不要接管；网页 URL（.html / 无扩展名）一律不接管。 */
export function canHandle(url: string): boolean {
  return DIRECT_EXT.has(sniffExt(url));
}

interface Variant { url: string; bandwidth: number; width: number; height: number; name: string }

/** 解析 `#EXT-X-STREAM-INF` 的属性；CODECS 里带逗号，不能直接按逗号切。 */
function attrsOf(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

/** master playlist → 变体列表（按高度/带宽从高到低）。 */
export function parseMasterPlaylist(text: string, baseUrl: string): Variant[] {
  const lines = text.split(/\r?\n/);
  const out: Variant[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = attrsOf(line);
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j += 1;
    const uri = (lines[j] || '').trim();
    if (!uri) continue;
    const res = /^(\d+)x(\d+)$/.exec(attrs.RESOLUTION || '');
    try {
      out.push({
        url: new URL(uri, baseUrl).toString(),
        bandwidth: Number(attrs.BANDWIDTH || 0),
        width: res ? Number(res[1]) : 0,
        height: res ? Number(res[2]) : 0,
        name: attrs.NAME || '',
      });
    } catch {
      // 相对地址解析失败就跳过这个变体
    }
    i = j;
  }
  return out.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
}

/** VOD 媒体列表的总时长（秒）。没有 `#EXTINF` 返回 0。 */
export function parseMediaDuration(text: string): number {
  let total = 0;
  const re = /#EXTINF:\s*(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) total += Number(m[1]);
  return Math.round(total * 1000) / 1000;
}

async function playlist(url: string): Promise<string> {
  const res = await request(url, { headers: { Referer: originOf(url) } });
  if (!res.ok) throw new VdlError(`http_${res.status}`, `播放列表 HTTP ${res.status}`);
  return res.text();
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return url;
  }
}

function titleOf(url: string): { id: string; title: string; author: string } {
  try {
    const u = new URL(url);
    const stem = decodeURIComponent((u.pathname.split('/').pop() || '').replace(/\.[a-z0-9]{2,5}$/i, ''));
    return {
      id: stem || u.hostname,
      title: stem ? stem.replace(/[_+]+/g, ' ').trim() : u.hostname,
      author: u.hostname,
    };
  } catch {
    return { id: 'media', title: 'media', author: '' };
  }
}

async function probeSniffImpl(input: string): Promise<ProbeResult> {
  const url = (input || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new VdlError('bad_input', 'L2 嗅探需要完整的 http(s) 媒体地址');
  }
  urlCache().clear();
  const ext = sniffExt(url);
  const info = titleOf(url);
  const formats: Format[] = [];
  let durationMs = 0;

  if (ext === 'm3u8') {
    const text = await playlist(url);
    if (!text.trimStart().startsWith('#EXTM3U')) {
      throw new VdlError('unsupported_url', '这个 .m3u8 返回的不是播放列表', '确认地址是否仍然有效');
    }
    const variants = parseMasterPlaylist(text, url);
    if (variants.length) {
      // 同一内容的各变体时长一致，取最高档的媒体列表算一次就够
      durationMs = await playlist(variants[0].url).then(parseMediaDuration).catch(() => 0) * 1000;
      for (const v of variants) {
        const id = v.height ? `hls-${v.height}` : `hls-${Math.round(v.bandwidth / 1000)}k`;
        urlCache().set(id, { url: v.url, hls: true });
        formats.push(format({
          id,
          label: v.height ? `${v.height}P` : v.name || `${Math.round(v.bandwidth / 1000)}kbps`,
          width: v.width, height: v.height, ext: 'mp4',
          acodec: 'aac',
          bytes: durationMs && v.bandwidth ? Math.round((v.bandwidth * (durationMs / 1000)) / 8) : null,
          bitrate: v.bandwidth || null,
        }));
      }
    } else {
      durationMs = parseMediaDuration(text) * 1000;
      urlCache().set('hls', { url, hls: true });
      formats.push(format({
        id: 'hls',
        label: durationMs ? `HLS ${Math.round(durationMs / 1000)}s` : 'HLS',
        ext: 'mp4', acodec: 'aac',
      }));
    }
  } else {
    // 直链：HEAD 拿类型/大小；HEAD 不给 content-length 就 Range 探一次
    let type = '';
    let bytes = 0;
    try {
      const head = await request(url, { method: 'HEAD', headers: { Referer: originOf(url) } });
      type = String(head.headers.get('content-type') || '');
      bytes = Number(head.headers.get('content-length') || 0);
      if (!bytes) {
        const ranged = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-0' } });
        const total = /[/](\d+)\s*$/.exec(String(ranged.headers.get('content-range') || ''))?.[1];
        await ranged.body?.cancel();
        bytes = Number(total || 0);
      }
    } catch {
      // 落到下面的判定：类型不明就拒绝
    }
    if (!MEDIA_TYPE.test(type) && !DIRECT_EXT.has(ext)) {
      throw new VdlError('unsupported_url',
        `这个地址不是可嗅探的媒体（content-type: ${type || '未知'}）`,
        'L2 只接管 m3u8 与直链 mp4/webm/mov/mkv/m4v/flv；网页里的播放器请用通用解析（yt-dlp）');
    }
    urlCache().set('file', { url, hls: false });
    formats.push(format({
      id: 'file',
      label: ext ? ext.toUpperCase() : '直链',
      ext: ext || 'mp4',
      bytes: bytes || null,
    }));
  }

  if (!formats.length) throw new VdlError('no_stream', '没有解析出可下载的档位');
  formats[0].recommended = true;

  return {
    schema: 2, ok: true, platform: 'sniff',
    engine: ext === 'm3u8' ? 'sniff-hls' : 'sniff-direct',
    media: {
      id: info.id,
      title: info.title,
      author: info.author,
      duration_ms: durationMs || null,
      thumbnail: '',
      source_url: url,
      platform: 'sniff',
      parts: [],
    },
    formats, warnings: [], error: null,
  };
}

/** ffmpeg 拉 HLS：解析 `-progress pipe:1` 的 out_time_us 报进度，取消时 kill。 */
async function hlsDownload(url: string, dest: string, durationMs: number): Promise<void> {
  const ff = process.env.VDL_FFMPEG || 'ffmpeg';
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-user_agent', UA, '-referer', originOf(url),
    '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'mp4', dest,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ff, args, { windowsHide: true });
    let cancelled = false;
    let buf = '';
    let lastErr = '';
    const timer = setInterval(() => {
      try { throwIfCancelled(); } catch { cancelled = true; child.kill('SIGKILL'); }
    }, 500);

    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const us = /^out_time_us=(\d+)/.exec(line.trim());
        if (us && durationMs > 0) {
          report(Math.min(Number(us[1]) / 1000, durationMs), durationMs);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { lastErr = chunk.toString('utf8').slice(-300); });
    child.on('error', (err) => { clearInterval(timer); reject(new VdlError('ffmpeg_missing', err.message)); });
    child.on('close', (code) => {
      clearInterval(timer);
      if (cancelled) { reject(new DownloadCancelled()); return; }
      if (code !== 0) {
        reject(new VdlError('ffmpeg_failed', `ffmpeg 退出码 ${code}: ${lastErr.trim() || '(无输出)'}`));
        return;
      }
      resolve();
    });
  });
}

async function getSniffImpl(input: string, formatId: string | null, outDir: string) {
  const probe = await probeSniff(input);
  const fmt = probe.formats.find((f) => f.id === formatId) ||
    probe.formats.find((f) => f.recommended) || probe.formats[0];
  const cached = urlCache().get(fmt.id);
  if (!cached) throw new VdlError('no_stream', '该档位没有可用地址');

  mkdirSync(outDir, { recursive: true });
  const ext = cached.hls ? 'mp4' : (fmt.ext || 'mp4');
  const dest = join(outDir,
    `${safeName(probe.media!.id, 40)}_${safeName(fmt.label, 16, fmt.id)}.${ext}`);
  if (existsSync(dest)) {
    return { path: dest, bytes: statSync(dest).size, skipped: true, warnings: [] };
  }

  if (cached.hls) {
    const tmp = dest + '.part';
    try { unlinkSync(tmp); } catch { /* 不存在 */ }
    await hlsDownload(cached.url, tmp, probe.media!.duration_ms || 0);
    // 短视频/测试片段可能只有几十 KB，别用音频那套 100KB 门槛把正常产物判死
    if (!existsSync(tmp) || statSync(tmp).size < 10 * 1024) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw new VdlError('bad_payload', 'HLS 合成产物过小，可能没有真实分片');
    }
    renameSync(tmp, dest);
    return { path: dest, bytes: statSync(dest).size, skipped: false, warnings: [] };
  }

  const part = dest + '.part';
  await streamToFile(cached.url, part, originOf(cached.url));
  if (statSync(part).size < 10 * 1024) {
    unlinkSync(part);
    throw new VdlError('bad_payload', '文件过小，可能不是完整媒体');
  }
  renameSync(part, dest);
  return { path: dest, bytes: statSync(dest).size, skipped: false, warnings: [] };
}

export const probeSniff = scopedOperation(probeSniffImpl);

export const getSniff = scopedOperation(getSniffImpl);
