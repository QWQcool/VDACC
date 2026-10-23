/**
 * 音频下载的公共部分（酷我 / 酷狗共用）。
 * 为什么单独抽出来：`.part` + Range 续传 + 限速 + ffmpeg 写标签这套逻辑
 * 在酷我/酷狗里一模一样，抄两遍以后改一处漏一处。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';

import { throwIfCancelled } from './cancel';
import { VdlError } from './errors';
import { UA } from './http';
import { report } from './progress';
import { throttle } from './rate';

export async function streamToFile(url: string, part: string, referer: string): Promise<number> {
  let resume = existsSync(part) ? statSync(part).size : 0;
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: referer };
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

function ffmpeg(args: string[]) {
  const ff = process.env.VDL_FFMPEG || 'ffmpeg';
  return spawnSync(ff, args, { encoding: 'utf8', windowsHide: true });
}

export interface TagOptions {
  dest: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  referer: string;
}

/**
 * 写标签/封面：成功则用带标签的产物替换原文件；
 * 失败就把原始音频改名留下（不因为标签写不进去丢掉已经下好的内容）。
 */
export async function tagAudio(opts: TagOptions): Promise<string[]> {
  const warnings: string[] = [];
  const coverPath = opts.dest + '.cover.img';
  let hasCover = false;
  if (opts.coverUrl) {
    try {
      const res = await fetch(opts.coverUrl, { headers: { 'User-Agent': UA, Referer: opts.referer } });
      if (res.ok) {
        writeFileSync(coverPath, Buffer.from(await res.arrayBuffer()));
        hasCover = true;
      }
    } catch {
      hasCover = false;
    }
  }

  const out = opts.dest.replace(/(\.\w+)$/, '.mux$1');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', opts.dest];
  if (hasCover) args.push('-i', coverPath);
  args.push('-map', '0:a');
  if (hasCover) args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  args.push('-c:a', 'copy');
  for (const [key, value] of Object.entries({
    title: opts.title, artist: opts.artist, album: opts.album, comment: 'downloaded by vdl',
  })) {
    if (value) args.push('-metadata', `${key}=${value}`);
  }
  if (opts.dest.toLowerCase().endsWith('.mp3')) args.push('-id3v2_version', '3');
  args.push(out);

  const run = ffmpeg(args);
  try { unlinkSync(coverPath); } catch { /* 没下到封面 */ }

  if (run.status === 0 && existsSync(out)) {
    try {
      unlinkSync(opts.dest);
      renameSync(out, opts.dest);
    } catch {
      // 替换失败也别把原文件弄丢
      warnings.push('写入标签后替换原文件失败，已保留原始音频');
      try { unlinkSync(out); } catch { /* ignore */ }
    }
  } else {
    if (existsSync(out)) { try { unlinkSync(out); } catch { /* ignore */ } }
    warnings.push('写入标签失败，已保留音频');
  }
  return warnings;
}
