import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { VdlError } from '../core/errors';
import { format, type Format, type ProbeResult } from '../core/types';

const BUCKETS: Array<[number, string]> = [
  [3840, '4K'], [2560, '2K'], [1920, '1080P'], [1280, '720P'], [854, '480P'],
];

function bucket(width: number): [number, string] {
  for (const [limit, label] of BUCKETS) if (width >= limit) return [limit, label];
  return [0, '标清'];
}

function ytdlpPath(): string {
  return process.env.VDL_YTDLP ||
    join(process.env.TEMP || '', 'vdacc-ts', 'yt-dlp.exe');
}

function score(f: any): number {
  const codec = String(f.vcodec || '').toLowerCase();
  const pref = codec.startsWith('avc') ? 2 : (codec.startsWith('hev') || codec.startsWith('hvc') ? 1 : 0);
  return pref * 1e9 + Number(f.tbr || 0);
}

export function probeBilibili(url: string): ProbeResult {
  if (/^BV[0-9A-Za-z]{10}$/.test((url || '').trim())) {
    url = `https://www.bilibili.com/video/${url.trim()}`;
  }
  const exe = ytdlpPath();
  if (!existsSync(exe)) throw new VdlError('engine_unavailable', `找不到 yt-dlp: ${exe}`);

  const cookie = join(process.env.LOCALAPPDATA || '', 'vdl', 'auth', 'bilibili.cookies.txt');
  const args = ['-J', '--no-warnings', '--no-playlist', '--socket-timeout', '20'];
  if (existsSync(cookie)) args.push('--cookies', cookie);
  args.push(url);

  const run = spawnSync(exe, args, {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true,
  });
  if (run.status !== 0) {
    const msg = String(run.stderr || '').replace(/^ERROR:\s*/m, '').slice(0, 500);
    throw new VdlError('download_failed', msg || `yt-dlp 退出码 ${run.status}`);
  }

  let info: any;
  try {
    info = JSON.parse(run.stdout);
  } catch {
    throw new VdlError('bad_json', 'yt-dlp 输出不是 JSON');
  }
  if (info.entries?.length) info = info.entries[0];

  const formats: any[] = info.formats || [];
  const videos = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.width);
  const audios = formats.filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  const bestAudio = audios.sort((a, b) =>
    Number(b.abr || b.tbr || 0) - Number(a.abr || a.tbr || 0))[0];

  const groups = new Map<number, any[]>();
  for (const f of videos) {
    const [limit] = bucket(Number(f.width || 0));
    if (!groups.has(limit)) groups.set(limit, []);
    groups.get(limit)!.push(f);
  }

  const out: Format[] = [];
  for (const limit of [...groups.keys()].sort((a, b) => b - a)) {
    const best = groups.get(limit)!.sort((a, b) => score(b) - score(a))[0];
    const total = Number(best.filesize || best.filesize_approx || 0) +
      (bestAudio ? Number(bestAudio.filesize || bestAudio.filesize_approx || 0) : 0);
    out.push(format({
      id: `bili-${limit || 'sd'}`,
      label: BUCKETS.find(([l]) => l === limit)?.[1] || `${best.height}P`,
      width: Number(best.width || 0), height: Number(best.height || 0),
      ext: 'mp4', vcodec: String(best.vcodec || '').split('.')[0],
      acodec: bestAudio ? String(bestAudio.acodec || '').split('.')[0] : '',
      fps: Number(best.fps || 0),
      bytes: total || null,
      // Python 版是「视频 tbr + 音频 abr」，这里必须一致
      bitrate: Math.round((Number(best.tbr || 0) +
        (bestAudio ? Number(bestAudio.abr || 0) : 0)) * 1000) || null,
    }));
  }
  if (!out.length) throw new VdlError('no_stream', '没有解析到视频轨');
  out[0].recommended = true;

  return {
    schema: 2, ok: true, platform: 'bilibili', engine: 'bilibili-ytdlp',
    media: {
      id: String(info.id || ''),
      title: info.title || 'B站视频',
      author: info.uploader || '',
      duration_ms: Number(info.duration || 0) * 1000 || null,
      thumbnail: info.thumbnail || '',
      source_url: info.webpage_url || url,
      platform: 'bilibili', parts: [],
    },
    formats: out,
    warnings: [],
    error: null,
  };
}
