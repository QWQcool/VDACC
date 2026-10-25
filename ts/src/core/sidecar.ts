import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UA } from './http';
import type { CoverResult } from './types';

/** 封面单独保存；失败只返回警告，不能把已经成功的视频判为失败。 */
export async function saveCover(videoPath: string, thumbnail: string, referer: string): Promise<CoverResult> {
  if (!thumbnail) return { cover: null, warnings: ['没有可用封面，主文件已保留'] };
  let temporary = '';
  try {
    const source = new URL(thumbnail);
    if (!['https:', 'http:'].includes(source.protocol)) throw new Error('invalid image protocol');
    const response = await fetch(source, { headers: { 'User-Agent': UA, Referer: referer }, signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.body) throw new Error('image unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as any) {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) throw new Error('image too large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    // 依据真实文件签名选择后缀，避免把 200 状态的 HTML 错误页保存为图片。
    const extension = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? '.jpg'
      : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? '.png'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? '.webp'
      : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString()) ? '.gif' : '';
    if (!extension) throw new Error('not an image');
    const destination = videoPath.slice(0, -extname(videoPath).length) + extension;
    temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, destination);
    return { cover: destination, warnings: [] };
  } catch {
    return { cover: null, warnings: ['封面保存失败，主文件已保留；可重试补取'] };
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* 不清理用户已有封面。 */ } }
  }
}
