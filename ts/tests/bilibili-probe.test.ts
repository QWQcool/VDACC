/**
 * B站 probe/get 的**离线**行为测试（ReversePlan 工作包 2，第四批）。
 *
 * B站与音乐引擎的差别：它是 DASH 双轨（视频+音频分开下再合并），所以「完整」这件事
 * 有第三种坏法——**只有视频轨、没有音频轨**，合并完是一段无声视频，但流程会报成功。
 * 另外接口错误码（-404 / 87007 …）原来一律记成 `download_failed`，那会让人以为下载坏了。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getBilibiliApi, probeBilibiliApi } from '../src/engines/bilibili_api';

const BVID = 'BV1xx411c7mD';
const CDN = 'https://cdn.example/';
const V_TOTAL = 21_154_992;
const A_TOTAL = 3_200_000;

type Route = {
  name: string;
  match: (url: string, init: RequestInit | undefined) => boolean;
  handle: (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
};

const realFetch = globalThis.fetch;
const realLocalAppData = process.env.LOCALAPPDATA;
const realFfmpeg = process.env.VDL_FFMPEG;

let routes: Route[] = [];
let tmpRoot = '';
let outDir = '';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'vdacc-bili-'));
  outDir = join(tmpRoot, 'out');
  process.env.LOCALAPPDATA = tmpRoot;
  process.env.VDL_FFMPEG = join(tmpRoot, 'no-such-ffmpeg');
  routes = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    for (const route of routes) {
      if (route.match(url, init)) return route.handle(url, init);
    }
    throw new TypeError(`fetch failed: 未打桩的请求 ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = realLocalAppData;
  if (realFfmpeg === undefined) delete process.env.VDL_FFMPEG;
  else process.env.VDL_FFMPEG = realFfmpeg;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const headerOf = (init: RequestInit | undefined, name: string): string => {
  const h: any = init?.headers || {};
  return String(h[name] ?? h[name.toLowerCase()] ?? '');
};

function stubView(patch: Record<string, unknown> = {}) {
  routes.push({
    name: 'view',
    match: (url) => url.includes('/x/web-interface/view'),
    handle: () => json({
      code: 0,
      data: {
        title: '测试视频',
        owner: { name: 'UP主' },
        pic: '',
        duration: 240,
        cid: 111,
        pages: [{ page: 1, part: '', duration: 240, cid: 111 }],
        ...patch,
      },
    }),
  });
}

function videoTrack(width: number, height: number, bandwidth: number, codecs = 'avc1.640028') {
  return { width, height, bandwidth, codecs, frameRate: '30', baseUrl: `${CDN}v${width}.m4s` };
}

function stubPlayurl(dash: { video: any[]; audio: any[] }, patch: Record<string, unknown> = {}) {
  routes.push({
    name: 'playurl',
    match: (url) => url.includes('/x/player/playurl'),
    handle: () => json({
      code: 0,
      data: { timelength: 240_000, dash, ...patch },
    }),
  });
}

/** Range 探测 → content-range 总字节；普通请求 → 真实 body（可指定只给一部分，模拟截断）。 */
function stubCdn(files: Record<string, { total: number; send?: number }>) {
  routes.push({
    name: 'cdn',
    match: (url) => url.startsWith(CDN),
    handle: (url, init) => {
      const key = Object.keys(files).find((k) => url.includes(k));
      const spec = key ? files[key] : null;
      const total = spec?.total ?? 0;
      if (headerOf(init, 'Range')) {
        return new Response(null, {
          status: 206,
          headers: { 'content-type': 'video/mp4', 'content-range': `bytes 0-0/${total}` },
        });
      }
      const send = spec?.send ?? total;
      return new Response(new Uint8Array(send), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(send) },
      });
    },
  });
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error: any) {
    return String(error?.code || error?.name || 'unknown');
  }
}

describe('B站 probe：档位、音轨与接口错误', () => {
  test('B1 按宽度归档，推荐 1080P', async () => {
    stubView();
    stubPlayurl({
      video: [
        videoTrack(3840, 2160, 5_000_000),
        videoTrack(1920, 1080, 2_000_000),
        videoTrack(854, 480, 800_000),
      ],
      audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
    });
    stubCdn({ 'v3840.m4s': { total: V_TOTAL }, 'v1920.m4s': { total: 8_000_000 }, 'v854.m4s': { total: 3_000_000 } });

    const probe = await probeBilibiliApi(BVID);
    expect(probe.formats.map((f) => f.id)).toEqual(['bili-3840', 'bili-1920', 'bili-854']);
    expect(probe.formats.find((f) => f.recommended)?.id).toBe('bili-1920');
    expect(probe.media?.title).toBe('测试视频');
  });

  test('B1b 单 P 也回 parts[1] 并带 cid，简介透传', async () => {
    stubView({ desc: '  简介正文  ' });
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
    });
    stubCdn({ 'v1920.m4s': { total: 8_000_000 } });

    const probe = await probeBilibiliApi(BVID);
    // 分析页要显示「第 1 P · CID · 时长」，空数组会让界面以为没有分P
    expect(probe.media?.parts.length).toBe(1);
    expect(probe.media?.parts[0].cid).toBe(111);
    expect(probe.media?.parts[0].index).toBe(1);
    expect(probe.media?.parts[0].selected).toBe(true);
    // 单 P 时长用播放接口的 timelength（240s），不是零
    expect(probe.media?.parts[0].duration_ms).toBe(240_000);
    expect(probe.media?.desc).toBe('简介正文');
    // 单 P 不能拼 ?p=1：否则它和 source_url 是两个字符串，后端去重会各建一个任务
    expect(probe.media?.parts[0].url).toBe(probe.media?.source_url);
  });

  test('B1c 竖屏 1080×1920 归到 1080P，不是 480P', async () => {
    stubView();
    stubPlayurl({
      // 竖屏：宽 1080 落在 854 与 1280 之间，只按宽看会被误标成 480P
      video: [videoTrack(1080, 1920, 10_000_000)],
      audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
    });
    stubCdn({ 'v1080.m4s': { total: 8_000_000 } });

    const probe = await probeBilibiliApi(BVID);
    expect(probe.formats.map((f) => f.id)).toEqual(['bili-1920']);
    expect(probe.formats[0].label).toBe('1080P');
    // 宽高仍如实透传，界面要显示「1080×1920」
    expect(probe.formats[0].width).toBe(1080);
    expect(probe.formats[0].height).toBe(1920);
  });

  test('B2 没有音频轨：必须提前说清楚会得到无声视频', async () => {
    stubView();
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [],
    });
    stubCdn({ 'v1920.m4s': { total: V_TOTAL } });

    const probe = await probeBilibiliApi(BVID);
    expect(probe.warnings.join(' ')).toContain('音频');
  });

  test('B3 稿件不存在（code=-404）：not_found，不是「下载失败」', async () => {
    routes.push({
      name: 'view-404',
      match: (url) => url.includes('/x/web-interface/view'),
      handle: () => json({ code: -404, message: '啥都木有' }),
    });
    expect(await codeOf(() => probeBilibiliApi(BVID))).toBe('not_found');
  });

  test('B4 会员专享（code=87007）：api_error，并把平台原话带出来', async () => {
    stubView();
    routes.push({
      name: 'playurl-vip',
      match: (url) => url.includes('/x/player/playurl'),
      handle: () => json({ code: 87007, message: '大会员专享限制' }),
    });

    let caught: any = null;
    try {
      await probeBilibiliApi(BVID);
    } catch (error) {
      caught = error;
    }
    expect(caught?.code).toBe('api_error');
    // 平台自己说「大会员专享」，我们照转，不自己翻译成结论
    expect(String(caught?.message || '')).toContain('87007');
    expect(String(caught?.message || '')).toContain('大会员');
  });
});

describe('B站 get：截断判定', () => {
  test('B5 视频轨只下到一部分：不报完成', async () => {
    stubView();
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
    });
    stubCdn({
      'v1920.m4s': { total: V_TOTAL, send: 5_000_000 },
      'a.m4s': { total: A_TOTAL },
    });

    expect(await codeOf(() => getBilibiliApi(BVID, 'bili-1920', outDir))).toBe('incomplete_media');
  });

  test('B6 两条轨字节相符：不误判成截断（此环境无 ffmpeg，应止步于合并）', async () => {
    stubView();
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
    });
    stubCdn({ 'v1920.m4s': { total: V_TOTAL }, 'a.m4s': { total: A_TOTAL } });

    expect(await codeOf(() => getBilibiliApi(BVID, 'bili-1920', outDir))).toBe('ffmpeg_missing');
  });
});
