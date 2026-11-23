/**
 * L2 嗅探（直链 / m3u8）：这是「未知站点」唯一的退路，之前只有 46% 行覆盖——
 * 也就是说它坏掉时，最先发现的是用户。这里把分派、解析、拒绝三件事钉住。
 *
 * 网络全部走 `globalThis.fetch` 打桩：`core/http.request` 就是包装它。
 */
import { describe, expect, test } from 'bun:test';

import {
  canHandle, parseMasterPlaylist, parseMediaDuration, probeSniff, sniffExt,
} from '../src/engines/sniff';

const withFetch = async (handler: (url: string, init: any) => Response, fn: () => Promise<void>) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => handler(String(input), init)) as unknown as typeof fetch;
  try { await fn(); } finally { globalThis.fetch = original; }
};

describe('接管范围', () => {
  test('按扩展名判断：媒体直链才接管', () => {
    expect(sniffExt('https://cdn.example.com/a/b/C.mp4')).toBe('mp4');
    expect(sniffExt('https://x/y.M3U8')).toBe('m3u8');
    // `sniffExt` 只看最后一段的扩展名；`canHandle` 才负责把 .php 挡掉
    expect(sniffExt('https://x/y.php?id=1')).toBe('php');
    expect(canHandle('https://x/y.php?id=1')).toBe(false);
    expect(sniffExt('not-a-url')).toBe('');

    for (const url of ['a.mp4', 'a.webm', 'a.mov', 'a.mkv', 'a.m4v', 'a.flv', 'a.m3u8']) {
      expect(canHandle(`https://cdn.example.com/${url}`)).toBe(true);
    }
    // 网页一律不接管：这类交给 yt-dlp 兜底
    for (const url of ['https://example.com/page.html', 'https://example.com/', 'https://e.com/x.php']) {
      expect(canHandle(url)).toBe(false);
    }
  });
});

describe('播放列表解析', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,NAME="1080p"',
    '',
    '# 注释行要跳过',
    'high/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720',
    'https://other.cdn/mid.m3u8',
  ].join('\n');

  test('CODECS 里的逗号不会把属性切坏，变体按高度降序', () => {
    const list = parseMasterPlaylist(master, 'https://cdn.example.com/hls/master.m3u8');
    expect(list.map((v) => v.height)).toEqual([1080, 720, 360]);
    expect(list[0].name).toBe('1080p');
    expect(list[0].bandwidth).toBe(3_000_000);
    // 相对地址按 base 解析，绝对地址原样
    expect(list[0].url).toBe('https://cdn.example.com/hls/high/index.m3u8');
    expect(list[1].url).toBe('https://other.cdn/mid.m3u8');
  });

  test('没有 URI 的变体、非 m3u8 文本都返回空，不瞎猜', () => {
    expect(parseMasterPlaylist('', 'https://x/')).toEqual([]);
    expect(parseMasterPlaylist('#EXTM3U\n#EXTINF:3,\nseg.ts', 'https://x/')).toEqual([]);
    expect(parseMasterPlaylist('#EXT-X-STREAM-INF:BANDWIDTH=1', 'https://x/')).toEqual([]);
  });

  test('总时长累加 EXTINF，小数保留到毫秒', () => {
    expect(parseMediaDuration('#EXTM3U\n#EXTINF:3.5,\na.ts\n#EXTINF:4,\nb.ts')).toBe(7.5);
    expect(parseMediaDuration('#EXTINF:0.001,\na.ts')).toBe(0.001);
    expect(parseMediaDuration('no extinf')).toBe(0);
  });
});

describe('probe：m3u8', () => {
  test('master → 每个变体一个档位，时长取最高档的媒体列表', async () => {
    await withFetch((url) => {
      if (url.endsWith('master.m3u8')) {
        return new Response([
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
          'low.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080',
          'high.m3u8',
        ].join('\n'), { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      return new Response('#EXTM3U\n#EXTINF:10,\na.ts\n#EXTINF:2.5,\nb.ts', { status: 200 });
    }, async () => {
      const res = await probeSniff('https://cdn.example.com/hls/master.m3u8');
      expect(res.ok).toBe(true);
      expect(res.engine).toBe('sniff-hls');
      expect(res.formats.map((f) => f.id)).toEqual(['hls-1080', 'hls-720']);
      expect(res.formats[0].recommended).toBe(true);
      expect(res.media?.duration_ms).toBe(12_500);
      // 声明了带宽与时长就给估算体积，否则留空而不是编一个
      expect(res.formats[0].bytes).toBe(Math.round((2_000_000 * 12.5) / 8));
    });
  });

  test('单层媒体列表 → 一个 hls 档位；返回体不是 #EXTM3U 就明确拒绝', async () => {
    await withFetch(() => new Response('#EXTM3U\n#EXTINF:3,\na.ts', { status: 200 }), async () => {
      const res = await probeSniff('https://cdn.example.com/media.m3u8');
      expect(res.formats.map((f) => f.id)).toEqual(['hls']);
      expect(res.formats[0].label).toContain('3s');
    });

    await withFetch(() => new Response('<html>404</html>', { status: 200 }), async () => {
      await expect(probeSniff('https://cdn.example.com/bad.m3u8')).rejects.toThrow(/不是播放列表/);
    });
  });
});

describe('probe：直链', () => {
  test('HEAD 给 content-type 与长度 → file 档位', async () => {
    await withFetch((url, init) => {
      expect(init.method).toBe('HEAD');
      return new Response(null, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '1048576' },
      });
    }, async () => {
      const res = await probeSniff('https://cdn.example.com/movie.mp4');
      expect(res.engine).toBe('sniff-direct');
      expect(res.formats[0].id).toBe('file');
      expect(res.formats[0].bytes).toBe(1_048_576);
      expect(res.formats[0].ext).toBe('mp4');
    });
  });

  test('HEAD 不给长度时用 Range 探总长', async () => {
    await withFetch((url, init) => {
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'video/mp4' } });
      return new Response(new Uint8Array([0]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-0/52428800' },
      });
    }, async () => {
      const res = await probeSniff('https://cdn.example.com/big.mp4');
      expect(res.formats[0].bytes).toBe(52_428_800);
    });
  });

  test('扩展名不在白名单且类型是网页 → 拒绝并给下一步', async () => {
    await withFetch(() => new Response(null, {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
    }), async () => {
      await expect(probeSniff('https://example.com/u.bin')).rejects.toThrow(/不是可嗅探的媒体/);
    });
  });

  test('扩展名在白名单时以扩展名为准（CDN 常给 octet-stream/网页类型）', async () => {
    await withFetch(() => new Response(null, {
      status: 200, headers: { 'content-type': 'text/html' },
    }), async () => {
      const res = await probeSniff('https://example.com/u.mp4');
      expect(res.formats[0].id).toBe('file');
    });
  });

  test('非 http(s) 直接 bad_input', async () => {
    await expect(probeSniff('ftp://x/a.mp4')).rejects.toThrow(/需要完整的 http/);
  });
});
