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
import { setLimitBytesPerSec } from '../src/core/rate';

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
  setLimitBytesPerSec(0); // 全局状态：上一个用例设过限速会漏到这里
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
function stubCdn(files: Record<string, { total: number; send?: number }>, seen?: string[]) {
  routes.push({
    name: 'cdn',
    match: (url) => url.startsWith(CDN),
    handle: (url, init) => {
      if (seen) seen.push(url);
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
    // 视频档位 + 单独一条「仅音频」（DASH 音频轨本来就是独立文件）
    expect(probe.formats.map((f) => f.id)).toEqual(['bili-3840', 'bili-1920', 'bili-854', 'audio']);
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
    expect(probe.formats.map((f) => f.id)).toEqual(['bili-1920', 'audio']);
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

  test('B2b 仅音频档位：体积只按音频带宽算，不抢推荐', async () => {
    stubView();
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
    });
    stubCdn({ 'v1920.m4s': { total: 8_000_000 } });

    const probe = await probeBilibiliApi(BVID);
    const audio = probe.formats.find((f) => f.id === 'audio');
    expect(audio?.ext).toBe('m4a');
    expect(audio?.acodec).toBe('mp4a');
    // 240s × 192kbps / 8 = 5,760,000（不含视频带宽）
    expect(audio?.bytes).toBe(5_760_000);
    expect(audio?.recommended).toBeFalsy();
  });

  test('B2c 只下音频：不请求视频轨，缺 ffmpeg 也保留文件并说明', async () => {
    stubView();
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
    });
    const seen: string[] = [];
    stubCdn({ 'a.m4s': { total: A_TOTAL } }, seen);

    const out = await getBilibiliApi(`https://www.bilibili.com/video/${BVID}`, 'audio', outDir);

    expect(out.path.endsWith('.m4a')).toBe(true);
    expect(out.bytes).toBe(A_TOTAL);
    // 关键：音频模式不能顺手把视频轨也下了
    expect(seen.some((u) => u.includes('v1920.m4s'))).toBe(false);
    // 这个环境把 VDL_FFMPEG 指到了不存在的路径：必须如实说明「没转封装」
    expect(out.warnings.join(' ')).toContain('ffmpeg');
  });

  test('B2d 没有音频轨时单独下音频：no_stream，不生成空文件', async () => {
    stubView();
    stubPlayurl({ video: [videoTrack(1920, 1080, 2_000_000)], audio: [] });
    stubCdn({ 'v1920.m4s': { total: V_TOTAL } });

    const code = await codeOf(() => getBilibiliApi(`https://www.bilibili.com/video/${BVID}`, 'audio', outDir));
    expect(code).toBe('no_stream');
  });

  test('B9 不限速时两条轨并行下载（下载请求真的重叠）', async () => {
    stubView();
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
    });
    // 只统计「下载请求」（无 Range）；Range 是探测，先于下载发生
    let inFlight = 0;
    let maxInFlight = 0;
    routes.push({
      name: 'cdn-slow',
      match: (url) => url.startsWith(CDN),
      handle: async (url, init) => {
        const total = url.includes('a.m4s') ? A_TOTAL : V_TOTAL;
        if (headerOf(init, 'Range')) {
          return new Response(null, { status: 206, headers: { 'content-range': `bytes 0-0/${total}` } });
        }
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight -= 1;
        return new Response(new Uint8Array(total), {
          status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(total) },
        });
      },
    });

    // 此环境没有 ffmpeg：下载阶段会成功，停在合并（code 不是 http_403/incomplete_media 即可）
    const code = await codeOf(() => getBilibiliApi(`https://www.bilibili.com/video/${BVID}`, null, outDir));
    expect(code).not.toBe('incomplete_media');
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  test('B10 设了限速就退回串行（否则总带宽会是限速的两倍）', async () => {
    stubView();
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
    });
    let inFlight = 0;
    let maxInFlight = 0;
    routes.push({
      name: 'cdn-slow',
      match: (url) => url.startsWith(CDN),
      handle: async (url, init) => {
        const total = url.includes('a.m4s') ? A_TOTAL : V_TOTAL;
        if (headerOf(init, 'Range')) {
          return new Response(null, { status: 206, headers: { 'content-range': `bytes 0-0/${total}` } });
        }
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return new Response(new Uint8Array(total), {
          status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(total) },
        });
      },
    });

    setLimitBytesPerSec(100 * 1024 * 1024); // 足够大，不会拖慢测试，但 > 0 就会走串行
    const code = await codeOf(() => getBilibiliApi(`https://www.bilibili.com/video/${BVID}`, null, outDir));
    expect(code).not.toBe('incomplete_media');
    expect(maxInFlight).toBe(1);
    setLimitBytesPerSec(0);
  });

  test('B11 有 Hi-Res FLAC：优先用它，容器转 mkv，体积把 1.4Mbps 音轨算进去', async () => {
    stubView();
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [{ bandwidth: 166_109, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
      // 实测形状：dash.flac.audio 是**对象**（不是数组）
      flac: { display: true, audio: { id: 30251, codecs: 'fLaC', bandwidth: 1_434_259, baseUrl: `${CDN}f.m4s` } },
      dolby: { type: 2, audio: [{ id: 30250, codecs: 'ec-3', bandwidth: 1_665_173, baseUrl: `${CDN}d.m4s` }] },
    } as any);
    stubCdn({ 'v1920.m4s': { total: 8_000_000 } });

    const probe = await probeBilibiliApi(BVID);
    const video = probe.formats.find((f) => f.id === 'bili-1920')!;
    expect(video.acodec).toBe('flac');
    // flac 装 mp4 播放器支持差，容器必须是 mkv
    expect(video.ext).toBe('mkv');
    // 240s × (2,000,000 + 1,434,259) / 8
    expect(video.bytes).toBe(Math.round((2_000_000 + 1_434_259) * 240 / 8));
    // 单列一条仅音频 FLAC，且不和 320K 那条混在一起
    const flacOnly = probe.formats.find((f) => f.id === 'audio-flac');
    expect(flacOnly?.ext).toBe('flac');
    expect(flacOnly?.label).toContain('FLAC');
    expect(flacOnly?.bytes).toBe(Math.round(1_434_259 * 240 / 8));
  });

  test('B12 只有杜比（flac 为空）：取 ec-3，容器仍是 mkv', async () => {
    stubView();
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [{ bandwidth: 166_109, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
      flac: { display: true, audio: null },
      dolby: { type: 2, audio: [{ id: 30250, codecs: 'ec-3', bandwidth: 448_000, baseUrl: `${CDN}d.m4s` }] },
    } as any);
    stubCdn({ 'v1920.m4s': { total: 8_000_000 } });

    const probe = await probeBilibiliApi(BVID);
    const video = probe.formats.find((f) => f.id === 'bili-1920')!;
    expect(video.acodec).toBe('eac3');
    expect(video.ext).toBe('mkv');
    expect(probe.formats.some((f) => f.id === 'audio-flac')).toBe(false);
  });

  test('B13 flac.display=true 但没有音轨（匿名态）：退回 AAC，不能当成有 FLAC', async () => {
    stubView();
    stubPlayurl({
      video: [videoTrack(1920, 1080, 2_000_000)],
      audio: [{ bandwidth: 166_109, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
      // 实测：未登录同一个稿件 `display` 仍是 true，但 audio 为 null
      flac: { display: true, audio: null },
      dolby: { type: 0 },
    } as any);
    stubCdn({ 'v1920.m4s': { total: 8_000_000 } });

    const probe = await probeBilibiliApi(BVID);
    const video = probe.formats.find((f) => f.id === 'bili-1920')!;
    expect(video.acodec).toBe('aac');
    expect(video.ext).toBe('mp4');
    expect(probe.formats.some((f) => f.id === 'audio-flac')).toBe(false);
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

describe('B站 get：播放地址过期（403）', () => {
  /** 每 P 只给一条视频轨；旧地址在真正下载时 403，新地址正常。 */
  function stubRotatingPlayurl(counter: { calls: number }) {
    routes.push({
      name: 'playurl-rotating',
      match: (url) => url.includes('/x/player/playurl'),
      handle: () => {
        const file = counter.calls === 0 ? 'v-old.m4s' : 'v-new.m4s';
        counter.calls += 1;
        return json({
          code: 0,
          data: {
            timelength: 240_000,
            dash: {
              video: [{
                width: 1920, height: 1080, bandwidth: 2_000_000,
                codecs: 'avc1.640028', frameRate: '30', baseUrl: `${CDN}${file}`,
              }],
              audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
            },
          },
        });
      },
    });
  }

  function stubCdnExpiring() {
    routes.push({
      name: 'cdn-expiring',
      match: (url) => url.startsWith(CDN),
      handle: (url, init) => {
        // 旧地址：探测（Range）时不拦，真正下载时 403——模拟签名中途过期
        if (url.includes('v-old.m4s')) {
          if (headerOf(init, 'Range')) {
            return new Response(null, { status: 206, headers: { 'content-range': `bytes 0-0/${V_TOTAL}` } });
          }
          return new Response('expired', { status: 403 });
        }
        const total = url.includes('a.m4s') ? A_TOTAL : V_TOTAL;
        if (headerOf(init, 'Range')) {
          return new Response(null, { status: 206, headers: { 'content-range': `bytes 0-0/${total}` } });
        }
        return new Response(new Uint8Array(total), {
          status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(total) },
        });
      },
    });
  }

  test('B7 403 后重新解析地址并继续下载，不是直接失败', async () => {
    stubView();
    const counter = { calls: 0 };
    stubRotatingPlayurl(counter);
    stubCdnExpiring();

    // ffmpeg 指向不存在的路径：合并会失败，但**下载阶段**必须已经过了 403
    const code = await codeOf(() => getBilibiliApi(`https://www.bilibili.com/video/${BVID}`, null, outDir));
    expect(code).not.toBe('http_403');
    expect(code).not.toBe('url_expired');
    // 初次 1 次 + 刷新 1 次
    expect(counter.calls).toBe(2);
  });

  test('B8 刷新两次仍 403：报 url_expired，而不是含糊的 http_403', async () => {
    stubView();
    const counter = { calls: 0 };
    // 始终给旧地址（刷不到新地址）
    routes.push({
      name: 'playurl-always-old',
      match: (url) => url.includes('/x/player/playurl'),
      handle: () => {
        counter.calls += 1;
        return json({
          code: 0,
          data: {
            timelength: 240_000,
            dash: {
              video: [{
                width: 1920, height: 1080, bandwidth: 2_000_000,
                codecs: 'avc1.640028', frameRate: '30', baseUrl: `${CDN}v-old.m4s`,
              }],
              audio: [{ bandwidth: 192_000, codecs: 'mp4a.40.2', baseUrl: `${CDN}a.m4s` }],
            },
          },
        });
      },
    });
    stubCdnExpiring();

    const code = await codeOf(() => getBilibiliApi(`https://www.bilibili.com/video/${BVID}`, null, outDir));
    expect(code).toBe('url_expired');
    // 初次 + 2 次刷新
    expect(counter.calls).toBe(3);
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
