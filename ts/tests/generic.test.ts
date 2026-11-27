/**
 * 通用兜底（yt-dlp 组件）：这是「六个平台都不认识」时最后一道防线。
 *
 * 2026-11-26 之前它行覆盖率是 **0%** —— 坏了没人知道。这里把两条链路都钉住：
 * - `parseGenericInfo`：纯函数，喂 yt-dlp 的真实 JSON 形状，验档位/去重/命名/媒体字段；
 * - `getGeneric`：用注入的 `run` 伪造落盘，验选择器、模板、输出解析与回扫兜底。
 *
 * 不联网、不需要 yt-dlp 可执行文件。
 */
import { describe, expect, test } from 'bun:test';

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  genericInstalled, getGeneric, parseGenericInfo, probeGeneric, ytdlpSelector,
} from '../src/engines/generic';

/** yt-dlp `-J` 的真实形状（截取必要字段）。 */
const info = {
  id: 'abc123',
  title: '示例 视频: 带冒号',
  uploader: '某UP',
  duration: 63.5,
  thumbnail: 'https://i.example/t.jpg',
  webpage_url: 'https://example.com/v/abc123',
  formats: [
    // 同是 1080P：hevc 码率更高，但要优先 h264（兼容性）
    { format_id: '248', vcodec: 'hev1.1.6', acodec: 'none', width: 1920, height: 1080, fps: 30, tbr: 4500, filesize: 900 },
    { format_id: '137', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 1080, fps: 30, tbr: 4000, filesize: 1000 },
    { format_id: '136', vcodec: 'avc1.4d401f', acodec: 'none', width: 1280, height: 720, tbr: 2000, filesize: 500 },
    // 音频轨：只有它带 acodec
    { format_id: '251', vcodec: 'none', acodec: 'opus', abr: 120, filesize: 200 },
    { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 220 },
  ],
};

const withTmp = async (fn: (dir: string) => void | Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'vdacc-generic-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('parseGenericInfo（纯函数）', () => {
  test('每个分辨率桶留一条，同桶优先 h264', () => {
    const res = parseGenericInfo(info, 'https://example.com/v/abc123');
    expect(res.formats.map((f) => f.id)).toEqual(['gen-137', 'gen-136']);
    expect(res.formats.map((f) => f.label)).toEqual(['1080P', '720P']);
    // hevc 的 248 被丢掉（同桶里 h264 优先，即使码率略低）
    expect(res.formats.some((f) => f.id === 'gen-248')).toBe(false);
    // 体积 = 视频 + 最佳音频（140 的 128k 比 251 的 120k 高）
    expect(res.formats[0].bytes).toBe(1000 + 220);
    expect(res.formats[0].vcodec).toBe('avc1');
    expect(res.formats[0].acodec).toBe('mp4a');
    expect(res.formats[0].recommended).toBe(true);
    expect(res.formats[1].recommended).toBe(false);
  });

  test('媒体信息原样带出，缺 webpage_url 时退回入参', () => {
    const res = parseGenericInfo(info, 'https://fallback.example/x');
    expect(res.media?.id).toBe('abc123');
    expect(res.media?.title).toBe('示例 视频: 带冒号');
    expect(res.media?.author).toBe('某UP');
    expect(res.media?.duration_ms).toBe(63_500);
    expect(res.media?.thumbnail).toBe('https://i.example/t.jpg');
    expect(res.media?.source_url).toBe('https://example.com/v/abc123');

    const noUrl = parseGenericInfo({ ...info, webpage_url: '' }, 'https://fallback.example/x');
    expect(noUrl.media?.source_url).toBe('https://fallback.example/x');
    expect(noUrl.engine).toBe('ytdlp-generic');
  });

  test('纯音频作品标「音频」，直链标「原文件」，都不会被当成 mp4 视频', () => {
    const audio = parseGenericInfo({
      id: 's1', title: '一首歌',
      formats: [{ format_id: 'a1', vcodec: 'none', acodec: 'mp4a.40.2', ext: 'm4a', abr: 128, filesize: 50 }],
    }, 'https://sound.example/s1');
    expect(audio.formats[0].label).toBe('音频');
    expect(audio.formats[0].ext).toBe('m4a');

    const file = parseGenericInfo({
      id: 'f1', title: '直链',
      formats: [{ format_id: 'hls-1', ext: 'mp4' }],
    }, 'https://cdn.example/a.mp4');
    expect(file.formats[0].label).toBe('原文件');
    expect(file.formats[0].ext).toBe('mp4');
  });

  test('播放列表取第一条 entry', () => {
    const res = parseGenericInfo({
      entries: [null, { id: 'e1', title: '第一条', formats: info.formats }],
    }, 'https://example.com/list');
    expect(res.media?.id).toBe('e1');
    expect(res.media?.title).toBe('第一条');
  });

  test('没有任何格式时报 no_stream，而不是装作成功', () => {
    expect(() => parseGenericInfo({ id: 'x', title: 'x', formats: [] }, 'https://e.com'))
      .toThrow(/没有解析到可下载格式/);
    expect(() => parseGenericInfo(null, 'https://e.com')).toThrow(/没有解析到可下载格式/);
  });
});

describe('probeGeneric 与组件缺失', () => {
  test('走注入的 run，参数是 -J --no-warnings --no-playlist', () => {
    let seen: string[] = [];
    const res = probeGeneric('https://example.com/v/abc123', {
      run: (args) => { seen = args; return JSON.stringify(info); },
    });
    expect(seen).toEqual(['-J', '--no-warnings', '--no-playlist', 'https://example.com/v/abc123']);
    expect(res.formats.length).toBe(2);
  });

  test('组件没装时明确报「未安装」，不抛 spawn 的原始错误', async () => {
    await withTmp((dir) => {
      const saved = process.env.LOCALAPPDATA;
      process.env.LOCALAPPDATA = dir;
      try {
        expect(genericInstalled()).toBe(false);
        expect(() => probeGeneric('https://example.com/x')).toThrow(/通用解析组件未安装/);
      } finally {
        if (saved === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = saved;
      }
    });
  });
});

describe('getGeneric（注入 run 伪造落盘）', () => {
  test('选择器带 +bestaudio，按模板落盘并回真实路径', async () => {
    await withTmp((dir) => {
      let seen: string[] = [];
      const out = getGeneric('https://example.com/v/abc123', null, dir, {
        run: (args) => {
          seen = args;
          if (args[0] === '-J') return JSON.stringify(info);
          const tpl = args[args.indexOf('-o') + 1];
          const file = tpl.replace('.%(ext)s', '.mp4');
          writeFileSync(file, 'x'.repeat(1234));
          return `${file}\n`;
        },
      });
      // 推荐档是 1080P 的 137；没有 acodec 的视频档必须带上 bestaudio
      expect(seen).toContain('137+bestaudio/137');
      expect(out.path.endsWith('.mp4')).toBe(true);
      expect(out.bytes).toBe(1234);
      expect(out.skipped).toBe(false);
      // 文件名里的非法字符被 safeName 清掉（冒号在 Windows 上不能做文件名；盘符不算）
      const base = out.path.split(/[\\/]/).pop() || '';
      expect(base).not.toContain(':');
    });
  });

  test('yt-dlp 不打印路径时，按 id 前缀回扫最新产物', async () => {
    await withTmp((dir) => {
      const out = getGeneric('https://example.com/v/abc123', null, dir, {
        run: (args) => {
          if (args[0] === '-J') return JSON.stringify(info);
          writeFileSync(join(dir, 'abc123_示例 视频_ 带冒号_1080P.mp4'), 'y'.repeat(99));
          return '';   // 老版本不输出 after_move:filepath
        },
      });
      expect(out.bytes).toBe(99);
      expect(readdirSync(dir).length).toBe(1);
    });
  });

  test('什么都没产出时明确失败，不返回一个不存在的路径', async () => {
    await withTmp((dir) => {
      expect(() => getGeneric('https://example.com/v/abc123', null, dir, {
        run: (args) => (args[0] === '-J' ? JSON.stringify(info) : ''),
      })).toThrow(/未报告落盘路径/);
    });
  });

  test('纯音频档的选择器不带 +bestaudio', () => {
    const fmt = parseGenericInfo({
      id: 'a', title: 't',
      formats: [{ format_id: 'a1', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }],
    }, 'https://e.com').formats[0];
    expect(ytdlpSelector(fmt)).toBe('a1');
  });
});
