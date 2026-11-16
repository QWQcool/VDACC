/**
 * 测试环境能力报告：**永远通过，但把关键能力打在输出里**。
 *
 * 为什么需要它：`bun test` 的结尾只有 `N pass / M skip`。少了 ffmpeg 的机器会安静地
 * 跳过端到端用例，看起来一切正常；排查时又得回头猜「这台机器到底缺什么」。
 * 这条用例把「有没有 ffmpeg、什么版本、Bun 什么版本、平台」直接写进用例名，
 * 让 `bun test` 的输出自带体检结果。
 *
 * 注意：这里**不联网**。在线可用性是平台侧的事，不属于环境能力，也不该让离线测试变慢。
 */
import { describe, expect, test } from 'bun:test';

import { FFMPEG_MISSING, FFMPEG_PATH, HAS_FFMPEG, ffmpegVersion } from './env';

describe('测试环境能力', () => {
  test(`ffmpeg：${HAS_FFMPEG ? ffmpegVersion() || FFMPEG_PATH : FFMPEG_MISSING}`, () => {
    // 只报告，不按能力判定失败：缺 ffmpeg 的机器应该「跳过依赖它的用例」，而不是整体变红
    expect(typeof HAS_FFMPEG).toBe('boolean');
    if (HAS_FFMPEG) expect(FFMPEG_PATH).toBeTruthy();
  });

  test(`运行时：Bun ${Bun.version} · ${process.platform} ${process.arch}`, () => {
    expect(Bun.version.length).toBeGreaterThan(0);
  });
});
