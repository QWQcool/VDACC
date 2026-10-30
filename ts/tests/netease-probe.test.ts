/**
 * 网易云 probe/get 的**离线**行为测试（ReversePlan 工作包 2，第二批）。
 *
 * 与 `qq-probe.test.ts` 同一套方法：替换 `globalThis.fetch` 喂合成响应、
 * 用临时 `%LOCALAPPDATA%` 控制登录态、`VDL_FFMPEG` 指向不存在的路径避免真跑进程。
 * 断言口径见 docs/design/netease-capability-baseline.md §4。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOperation } from '../src/core/operation';
import { getNetease, previewNetease, probeNetease } from '../src/engines/netease';

const SID = '1901371647';
const CDN = 'https://m701.music.126.net/';

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
  tmpRoot = mkdtempSync(join(tmpdir(), 'vdacc-ne-'));
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

/* ─────────────────────────── 合成响应 ─────────────────────────── */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function detailBody(patch: Record<string, unknown> = {}) {
  return {
    songs: [{
      id: Number(SID),
      name: '测试曲',
      duration: 240_000,
      // 封面留空：避免测试里启动封面下载 + ffmpeg 缩放
      album: { picUrl: '' },
      artists: [{ name: '歌手A' }, { name: '歌手B' }],
      ...patch,
    }],
  };
}

function urlBody(entries: Array<{ br: number; code?: number; url?: string | null; size?: number; type?: string }>) {
  return {
    data: entries.map((e) => ({
      id: Number(SID),
      br: e.br,
      code: e.code ?? 200,
      url: e.url === null ? null : (e.url ?? `${CDN}${e.br}.mp3`),
      size: e.size ?? 0,
      type: e.type ?? 'mp3',
    })),
  };
}

function stubDetail(body: unknown = detailBody()) {
  routes.push({
    name: 'detail',
    match: (url) => url.includes('/api/song/detail/'),
    handle: () => json(body),
  });
}

/** 两个档位各打一枪；没登记的 br 返回「没有这首歌的地址」。 */
function stubUrls(map: Record<number, unknown>) {
  routes.push({
    name: 'player-url',
    match: (url) => url.includes('/api/song/enhance/player/url'),
    handle: (url) => {
      const br = Number(/br=(\d+)/.exec(url)?.[1] || 0);
      const body = map[br];
      return body ? json(body) : json({ data: [{ id: Number(SID), code: 404, url: null, br, size: 0 }] });
    },
  });
}

function stubHead(sizes: Record<string, number> = {}) {
  routes.push({
    name: 'head',
    match: (url, init) => url.startsWith(CDN) && String(init?.method || 'GET').toUpperCase() === 'HEAD',
    handle: (url) => {
      const key = Object.keys(sizes).find((k) => url.includes(k));
      return new Response(null, { status: 200, headers: { 'content-length': String(key ? sizes[key] : 0) } });
    },
  });
}

function stubDownload(bytes: number) {
  routes.push({
    name: 'download',
    match: (url, init) => url.startsWith(CDN) && String(init?.method || 'GET').toUpperCase() === 'GET',
    handle: () => new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes) },
    }),
  });
}

function writeCookie() {
  const dir = join(tmpRoot, 'vdl', 'auth');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'netease.json'), JSON.stringify({
    cookies: [{ name: 'MUSIC_U', value: 'FAKE', domain: '.music.163.com' }],
  }), 'utf8');
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error: any) {
    return String(error?.code || error?.name || 'unknown');
  }
}

/* ─────────────────────────── 用例 ─────────────────────────── */

describe('网易云 probe：档位呈现', () => {
  test('N0 两个档位都放行时都进 formats，推荐无损', async () => {
    stubDetail();
    stubUrls({
      999000: urlBody([{ br: 999000, size: 25_000_000, type: 'flac' }]),
      320000: urlBody([{ br: 320000, size: 9_600_000, type: 'mp3' }]),
    });
    stubHead({ '999000': 25_000_000, '320000': 9_600_000 });

    const probe = await probeNetease(SID);
    expect(probe.formats.filter((f) => f.available).map((f) => f.id)).toEqual(['lossless', 'exhigh']);
    expect(probe.formats.find((f) => f.recommended)?.id).toBe('lossless');
    expect(probe.media?.title).toBe('测试曲');
  });

  test('N0b 请求无损但接口只给 320K：按实际码率标注，不写成「无损」', async () => {
    stubDetail();
    stubUrls({
      // 实测形状（免费曲 2007983648，2026-10-29）：br 参数 999000，返回 br=320000 / type=mp3
      999000: urlBody([{ br: 320000, size: 10_298_558, type: 'mp3' }]),
    });
    stubHead({ '320000': 10_298_558 });

    const probe = await probeNetease(SID);
    const lossless = probe.formats.find((f) => f.id === 'lossless');
    // id 仍是 lossless（显式 --format lossless 还能命中），但 label 必须说实际码率
    expect(lossless?.label).toBe('320K');
    expect(lossless?.ext).toBe('mp3');
    expect(probe.warnings.some((w) => w.includes('实际返回 320K'))).toBe(true);
  });

  test('N0c 真无损的 br 是 FLAC 编码实际码率，不能判成降级', async () => {
    stubDetail();
    // 实测（黑胶会员账号，2026-10-30）：请求 999000 返回 type=flac、br=901303、36MB
    stubUrls({ 999000: urlBody([{ br: 901_303, size: 36_097_193, type: 'flac' }]) });
    stubHead({ '999000': 36_097_193 });

    const probe = await probeNetease(SID);
    const lossless = probe.formats.find((f) => f.id === 'lossless');
    expect(lossless?.label).toBe('无损 FLAC');
    expect(lossless?.ext).toBe('flac');
    expect(probe.warnings.some((w) => w.includes('实际返回'))).toBe(false);
  });

  test('N1 未放行档位也要出现：available=false 且 reason 带真实 code', async () => {
    stubDetail();
    stubUrls({
      999000: { data: [{ id: Number(SID), code: 404, url: null, br: 999000, size: 0 }] },
      320000: urlBody([{ br: 320000, size: 9_600_000 }]),
    });
    stubHead({ '320000': 9_600_000 });

    const probe = await probeNetease(SID);
    // 四档全部列出（无损/320K/128K/96K），接口没给的那两档也占位
    expect(probe.formats.map((f) => f.id)).toEqual(['lossless', 'exhigh', 'standard', 'low']);
    const denied = probe.formats.find((f) => f.id === 'lossless');
    expect(denied?.available).toBe(false);
    expect(denied?.reason || '').toContain('404');
    // 至少要让用户看到「为什么不给无损」，不能 warnings 恒空
    expect(probe.warnings.length).toBeGreaterThan(0);
  });

  test('N1b 有账号但没会员：128K 仍然能用，不能被无损/320K 的 404 拖死', async () => {
    writeCookie();
    stubDetail();
    stubUrls({
      999000: { data: [{ id: Number(SID), code: 404, url: null, br: 999000, size: 0 }] },
      320000: { data: [{ id: Number(SID), code: 404, url: null, br: 320000, size: 0 }] },
      128000: urlBody([{ br: 128000, size: 3_840_000 }]),
      96000: { data: [{ id: Number(SID), code: 404, url: null, br: 96000, size: 0 }] },
    });
    stubHead({ '128000': 3_840_000 });

    const probe = await probeNetease(SID);
    expect(probe.formats.filter((f) => f.available).map((f) => f.id)).toEqual(['standard']);
    expect(probe.formats.find((f) => f.recommended)?.id).toBe('standard');
  });

  test('N1c 不同 br 拿到同一个文件时不重复列档位（同字节只留一条）', async () => {
    stubDetail();
    stubUrls({
      128000: urlBody([{ br: 128000, size: 3_840_000, url: `${CDN}same.mp3` }]),
      96000: urlBody([{ br: 96000, size: 3_840_000, url: `${CDN}same.mp3` }]),
    });
    stubHead({ same: 3_840_000 });

    const probe = await probeNetease(SID);
    const available = probe.formats.filter((f) => f.available);
    expect(available.length).toBe(1);
    expect(available[0].id).toBe('standard');
  });

  test('N2 已登录且全档被拒：filtered，且消息里带 code', async () => {
    writeCookie();
    stubDetail();
    stubUrls({
      999000: { data: [{ id: Number(SID), code: 404, url: null, br: 999000, size: 0 }] },
      320000: { data: [{ id: Number(SID), code: 404, url: null, br: 320000, size: 0 }] },
    });

    let caught: any = null;
    try {
      await probeNetease(SID);
    } catch (error) {
      caught = error;
    }
    expect(caught?.code).toBe('filtered');
    expect(String(caught?.message || '')).toContain('404');
  });

  test('N3 未登录且全档被拒：need_login', async () => {
    stubDetail();
    stubUrls({});
    expect(await codeOf(() => probeNetease(SID))).toBe('need_login');
  });

  test('N4 详情里查不到这首歌：not_found，不是 filtered', async () => {
    stubDetail({ songs: [] });
    expect(await codeOf(() => probeNetease(SID))).toBe('not_found');
  });

  test('N7 接口 5xx：network（已有的正确行为，防回归）', async () => {
    routes.push({
      name: 'detail-500',
      match: (url) => url.includes('/api/song/detail/'),
      handle: () => new Response('boom', { status: 500 }),
    });
    expect(await codeOf(() => probeNetease(SID))).toBe('network');
  });
});

describe('网易云 get：不静默降级、不把片段当完整', () => {
  test('N5 显式指定不可用档位：报 no_stream，不换成 320K', async () => {
    stubDetail();
    stubUrls({ 320000: urlBody([{ br: 320000, size: 9_600_000 }]) });
    stubHead({ '320000': 9_600_000 });
    stubDownload(200_000);

    expect(await codeOf(() => getNetease(SID, 'lossless', outDir))).toBe('no_stream');
  });

  test('N6 实际字节远小于接口声明：不报「完成」', async () => {
    // 声明 9.6MB，只给 480KB —— 典型试听/降质
    stubDetail();
    stubUrls({ 320000: urlBody([{ br: 320000, size: 9_600_000 }]) });
    stubHead({ '320000': 480_000 });
    stubDownload(480_000);

    expect(await codeOf(() => getNetease(SID, 'exhigh', outDir))).toBe('incomplete_media');
  });

  test('N6b 字节数与声明相符时正常完成（防误杀）', async () => {
    stubDetail();
    stubUrls({ 320000: urlBody([{ br: 320000, size: 3_840_000 }]) });
    stubHead({ '320000': 3_840_000 });
    stubDownload(3_840_000);

    const out: any = await getNetease(SID, 'exhigh', outDir);
    expect(out.bytes).toBe(3_840_000);
    expect(out.warnings.join(' ')).toContain('标签');
  });
});

describe('预览地址：作用域机制（/api/preview 依赖它）', () => {
  /**
   * server.ts 把整个请求包在 runOperation 里，probe 与 preview 共用一个作用域，
   * 所以探测缓存的地址在预览时还活着。这条测试钉住这个前提——
   * 如果谁把 preview 挪到作用域外，用户点「预览」就会永远拿到空地址。
   */
  test('同一作用域内 probe 之后仍能取到预览地址', async () => {
    stubDetail();
    stubUrls({ 320000: urlBody([{ br: 320000, size: 9_600_000 }]) });
    stubHead({ '320000': 9_600_000 });

    const src = await runOperation(async () => {
      await probeNetease(SID);
      return previewNetease('exhigh');
    });
    expect(src).toContain(CDN);
  });

  test('作用域外取不到（说明必须共用同一个 runOperation）', () => {
    expect(() => previewNetease('exhigh')).toThrow(/作用域/);
  });
});
