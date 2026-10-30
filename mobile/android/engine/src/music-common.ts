/**
 * 音乐引擎的端上公共层（酷我 / 酷狗 / QQ 共用）。
 *
 * 三家引擎的接口形状完全不同，但「探一下是不是真音频」「下到暂存区」「补标签/封面再落盘」
 * 这三件事一模一样。收在这里的好处是：桥协议只出现一遍，三个引擎里不会各写一套
 * base64 与偏移，改桥字段时只需要改一个地方。
 *
 * 与桌面端的差异：桌面用 ffmpeg 写标签；端上没有 ffmpeg，用 `audiometa` 自己拼字节。
 * 因此这里把「标签写失败」降级成 warning——音频已经下好了，不能因为标签丢文件。
 */
import { UA, request } from '../../../../ts/src/core/http';
import { VdlError } from '../../../../ts/src/core/errors';
import { call } from '../shims/bridge';
import { startTransfer } from '../shims/transfer';
import { buildAudioTag, imageSize, type AudioMeta } from './audiometa';
import { readHead, rewriteStaged, writeTextAndPublish } from './staging';

export type AudioProbeResult = { ok: boolean; size: number; reason: string };

/**
 * Range 探一小段：确认返回的是音频（不是 HTML/JSON 错误页），并拿真实总字节。
 * 总字节有两个用途：进度分母，以及下载完成后判「试听片段/截断」。
 */
export async function probeAudioUrl(url: string, referer: string): Promise<AudioProbeResult> {
  try {
    const res = await request(url, {
      headers: { 'User-Agent': UA, Referer: referer, Range: 'bytes=0-15' },
      timeoutMs: 20_000,
    });
    if (res.status !== 200 && res.status !== 206) {
      return { ok: false, size: 0, reason: `HTTP ${res.status}` };
    }
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    const total = Number(/[/](\d+)\s*$/.exec(String(res.headers.get('content-range') || ''))?.[1] || 0);
    const length = Number(res.headers.get('content-length') || 0);
    if (/text\/html|application\/json/.test(type)) {
      return { ok: false, size: 0, reason: `不是音频（${type}）` };
    }
    return { ok: true, size: total || length, reason: '' };
  } catch (error) {
    return { ok: false, size: 0, reason: (error as Error).message };
  }
}

export type MusicHooks = {
  onProgress?: (bytes: number, total: number) => void;
  onReady?: (jobId: string, resumeFrom: number) => void;
};

/** 下到暂存区（`publish:false`）：补完标签/歌词再落公共目录。 */
export async function downloadToStaging(
  url: string,
  name: string,
  referer: string,
  hooks: MusicHooks = {},
): Promise<{ bytes: number; resumeFrom: number }> {
  const handle = await startTransfer({
    url,
    name,
    referer,
    userAgent: UA,
    publish: false,
    onProgress: hooks.onProgress,
  });
  hooks.onReady?.(handle.jobId, handle.resumeFrom);
  const done = await handle.done;
  return { bytes: done.bytes, resumeFrom: handle.resumeFrom };
}

/** 截断判定：探测到整曲大小、实际却明显偏小时不报完成（试听片段往往只有几十 KB）。 */
export function assertNotTruncated(actual: number, expected: number, label: string): void {
  if (actual < 100 * 1024) {
    const error = new Error(`${label} 只有 ${actual} 字节，多半是试听片段或错误页`) as Error & { code?: string };
    error.code = 'bad_payload';
    throw error;
  }
  if (expected > 0 && actual < expected * 0.95) {
    const error = new Error(
      `${label} 只拿到 ${actual} 字节，探测到整曲约 ${expected} 字节（重试可续传）`,
    ) as Error & { code?: string };
    error.code = 'incomplete_media';
    throw error;
  }
}

/**
 * 给暂存文件补标签与封面。
 *
 * 为什么失败只 warning：音频已经下完了，标签是增强信息。桌面端 `tagAudio` 也是这个口径
 * （返回 warnings 而不是抛错）。
 */
export async function tagStaged(
  name: string,
  meta: AudioMeta,
  cover: { url: string; referer: string } | null,
): Promise<string[]> {
  const warnings: string[] = [];
  const full: AudioMeta = { ...meta };

  if (cover?.url) {
    try {
      const res = await request(cover.url, {
        headers: { 'User-Agent': UA, Referer: cover.referer },
        timeoutMs: 20_000,
      });
      if (!res.ok) {
        warnings.push(`封面下载失败 HTTP ${res.status}，已跳过内嵌`);
      } else {
        const data = new Uint8Array(await res.arrayBuffer());
        const size = imageSize(data);
        // 宽高读不出来说明不是 JPEG/PNG（有些接口给 webp）：宁可不嵌，也不写坏 PICTURE 块
        if (size.width > 0 && size.height > 0) {
          full.cover = {
            mime: size.mime, data, width: size.width, height: size.height, depth: 24,
          };
        } else {
          warnings.push('封面不是可识别的 JPEG/PNG，已跳过内嵌');
        }
      }
    } catch (error) {
      warnings.push(`封面下载失败：${(error as Error).message}`);
    }
  }

  try {
    const head = await readHead(name, 512 * 1024);
    const plan = buildAudioTag(head.bytes, full);
    if (plan.note) {
      warnings.push(plan.note);
    } else if (plan.prefix.length) {
      await rewriteStaged(name, plan.prefix, plan.skip);
    }
  } catch (error) {
    warnings.push(`写标签失败（音频已保留）：${(error as Error).message}`);
  }
  return warnings;
}

export async function publishStaged(name: string): Promise<{ path: string; bytes: number }> {
  const res = await call<{ path: string; bytes: number }>('fs.publish', { name }, { timeoutMs: 120_000 });
  return { path: res.path, bytes: res.bytes };
}

/** 歌词/字幕这类文本附属文件：与 M1-e 的 `.lrc` 走同一条写盘路径。 */
export async function writeTextSidecar(name: string, text: string): Promise<void> {
  await writeTextAndPublish(name, text.endsWith('\n') ? text : `${text}\n`);
}

/** 文件名主体：`<id>_<标题>_<档位>`，与桌面端同名规则。 */
export function stemOf(id: string, title: string, label: string, safeName: (s: string, n?: number, f?: string) => string): string {
  return `${id}_${safeName(title)}_${safeName(label, 16, id)}`;
}

/** `filtered` / `need_login` 等需要带「下一步」的错误，统一在这里造。 */
export function musicError(code: string, message: string, next?: string): VdlError {
  return new VdlError(code, message, next);
}
