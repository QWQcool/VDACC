import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { VdlError } from '../core/errors';
import { safeName } from '../core/naming';
import { format, type ProbeResult } from '../core/types';

const BUCKETS: Array<[number, string]> = [
  [3840, '4K'], [2560, '2K'], [1920, '1080P'], [1280, '720P'], [854, '480P'],
];

export function componentPath(): string {
  return join(process.env.LOCALAPPDATA || '', 'vdl', 'components', 'yt-dlp.exe');
}

export function genericInstalled(): boolean {
  return existsSync(componentPath());
}

function clean(msg: string): string {
  return String(msg || '').replace(/^ERROR:\s*/gm, '').trim().slice(0, 400);
}

function runYtdlp(args: string[]): string {
  const exe = componentPath();
  if (!existsSync(exe)) {
    throw new VdlError('engine_unavailable', '通用解析组件未安装',
      '在设置里下载 yt-dlp 组件后重试');
  }
  const proc = spawnSync(exe, args, {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true,
  });
  if (proc.status !== 0) {
    throw new VdlError('download_failed', clean(proc.stderr) || `yt-dlp 退出码 ${proc.status}`);
  }
  return proc.stdout;
}

function codecScore(codec: string): number {
  const low = (codec || '').toLowerCase();
  if (low.startsWith('avc') || low.startsWith('h264')) return 2;
  if (low.startsWith('hev') || low.startsWith('hvc')) return 1;
  return 0;
}

export function probeGeneric(url: string): ProbeResult {
  const info = JSON.parse(runYtdlp(['-J', '--no-warnings', '--no-playlist', url]));
  const items = info.entries?.length ? info.entries.filter(Boolean) : [info];
  const first = items[0] || {};
  const formats: any[] = first.formats || [];
  const videos = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.width);
  const audios = formats.filter((f) => f.acodec && f.acodec !== 'none' &&
    (!f.vcodec || f.vcodec === 'none'));
  const bestAudio = audios.sort((a, b) =>
    Number(b.abr || b.tbr || 0) - Number(a.abr || a.tbr || 0))[0];

  const out = [];
  const groups = new Map<number, any[]>();
  for (const f of videos) {
    let limit = 0;
    for (const [l] of BUCKETS) if (Number(f.width) >= l) { limit = l; break; }
    if (!groups.has(limit)) groups.set(limit, []);
    groups.get(limit)!.push(f);
  }
  for (const limit of [...groups.keys()].sort((a, b) => b - a)) {
    const best = groups.get(limit)!.sort((a, b) =>
      codecScore(b.vcodec) - codecScore(a.vcodec) ||
      Number(b.tbr || 0) - Number(a.tbr || 0))[0];
    const bytes = Number(best.filesize || best.filesize_approx || 0) +
      Number(bestAudio?.filesize || bestAudio?.filesize_approx || 0);
    out.push(format({
      id: `gen-${best.format_id}`,
      label: (BUCKETS.find(([l]) => l === limit)?.[1]) || `${best.height}P`,
      width: Number(best.width || 0), height: Number(best.height || 0),
      ext: 'mp4', vcodec: String(best.vcodec || '').split('.')[0],
      acodec: bestAudio ? String(bestAudio.acodec || '').split('.')[0] : '',
      fps: Number(best.fps || 0), bytes: bytes || null,
      bitrate: Number(best.tbr || 0) * 1000 || null,
    }));
  }

  // 直链（如 .mp4）没有 vcodec/width 字段，按原文件处理
  if (!out.length && formats.length) {
    const f0 = formats[0];
    out.push(format({
      id: `gen-${f0.format_id || 'file'}`,
      label: '原文件', ext: String(f0.ext || 'mp4'),
      bytes: Number(f0.filesize || f0.filesize_approx || 0) || null,
    }));
  }

  if (!out.length && audios.length) {
    const a = audios[0];
    out.push(format({
      id: `gen-${a.format_id}`, label: '音频', ext: String(a.ext || 'm4a'),
      acodec: String(a.acodec || '').split('.')[0],
      bytes: Number(a.filesize || a.filesize_approx || 0) || null,
      bitrate: Number(a.abr || a.tbr || 0) * 1000 || null,
    }));
  }
  if (!out.length) throw new VdlError('no_stream', 'yt-dlp 没有解析到可下载格式');
  out[0].recommended = true;

  return {
    schema: 2, ok: true, platform: 'generic', engine: 'ytdlp-generic',
    media: {
      id: String(first.id || ''),
      title: first.title || '未知标题',
      author: first.uploader || '',
      duration_ms: Number(first.duration || 0) * 1000 || null,
      thumbnail: first.thumbnail || '',
      source_url: first.webpage_url || url,
      platform: 'generic', parts: [],
    },
    formats: out, warnings: [], error: null,
  };
}

export function getGeneric(url: string, formatId: string | null, outDir: string) {
  const probe = probeGeneric(url);
  const fmt = probe.formats.find((f) => f.id === formatId) ||
    probe.formats.find((f) => f.recommended) || probe.formats[0];
  const ytdlpId = fmt.id.replace(/^gen-/, '');
  const selector = fmt.vcodec ? `${ytdlpId}+bestaudio/${ytdlpId}` : ytdlpId;

  mkdirSync(outDir, { recursive: true });
  const template = join(outDir,
    `${probe.media!.id}_${safeName(probe.media!.title)}_${safeName(fmt.label, 14)}.%(ext)s`);

  const printed = runYtdlp([
    '-f', selector, '--merge-output-format', 'mp4', '--no-playlist',
    '--no-warnings', '-o', template, '--print', 'after_move:filepath', url,
  ]);
  let path = printed.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  if (!path || !existsSync(path)) {
    // 某些 yt-dlp 版本不输出 after_move:filepath，按前缀找最新产物
    const prefix = `${probe.media!.id}_`;
    const found = readdirSync(outDir)
      .filter((name) => name.startsWith(prefix) && !name.endsWith('.part'))
      .map((name) => ({ name, mtime: statSync(join(outDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!found) throw new VdlError('download_failed', 'yt-dlp 未报告落盘路径');
    path = join(outDir, found.name);
  }
  return { path, bytes: statSync(path).size, skipped: false, warnings: [] };
}
