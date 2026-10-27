/**
 * QQ 音乐 probe/get 的**离线**行为测试（ReversePlan 工作包 2）。
 *
 * 为什么用合成响应而不是线上：QQ 的档位放行取决于账号权益与风控，拿线上接口当测试基建
 * 会让这套用例随机红；而且我们要断言的是「不确定时如何表述」，不是「平台今天给了什么」。
 *
 * 做法：替换 globalThis.fetch（`core/http.request` 与引擎的 streamTo 都走它），
 * 用 `%LOCALAPPDATA%` 指向临时目录来控制登录态，再把 ffmpeg 指到不存在的路径
 * （否则 `get` 会真的去 spawn 一个进程做标签写入）。
 *
 * 断言口径来自 docs/design/qq-capability-baseline.md §5。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getQQ, probeQQ } from '../src/engines/qq';

const MID = '003OUlho2HcRHC';
const CDN = 'https://dl.example.qqmusic/';

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
  tmpRoot = mkdtempSync(join(tmpdir(), 'vdacc-qq-'));
  outDir = join(tmpRoot, 'out');
  process.env.LOCALAPPDATA = tmpRoot;
  // 让 get 的标签步骤立刻失败返回 -2，不要在测试里 spawn 真 ffmpeg
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
    data: [{
      mid: MID,
      name: '测试曲',
      singer: [{ name: '歌手A' }, { name: '歌手B' }],
      album: { mid: 'ALB0001', name: '测试专辑' },
      interval: 240,
      file: {
        size_320mp3: 9_600_000,
        size_128mp3: 3_840_000,
        size_96aac: 2_880_000,
        size_flac: 25_000_000,
      },
      ...patch,
    }],
  };
}

const EXT: Record<string, string> = { M800: 'mp3', M500: 'mp3', C400: 'm4a', F000: 'flac' };

/** items 只写「接口真的返回了」的档位；没写的等于接口没给（probe 会当成未放行）。 */
function vkeyBody(items: Array<{ quality: string; result?: number; purl?: string | null }>) {
  return {
    req_1: {
      code: 0,
      data: {
        sip: [CDN],
        midurlinfo: items.map((item) => ({
          filename: `${item.quality}${MID}.${EXT[item.quality]}`,
          purl: item.purl === null ? '' : (item.purl ?? `${item.quality}${MID}.${EXT[item.quality]}?vkey=ok`),
          result: item.result ?? 0,
        })),
      },
    },
  };
}

function stubDetail(body: unknown = detailBody()) {
  routes.push({
    name: 'detail',
    match: (url) => url.includes('fcg_play_single_song'),
    handle: () => json(body),
  });
}

function stubVkey(body: unknown) {
  routes.push({
    name: 'vkey',
    match: (url) => url.includes('musicu.fcg'),
    handle: () => json(body),
  });
}

/** HEAD 按文件名里的档位前缀给字节数；不给就返回 0（引擎会退回声明大小）。 */
function stubHead(sizes: Record<string, number> = {}) {
  routes.push({
    name: 'head',
    match: (url, init) => url.startsWith(CDN) && String(init?.method || 'GET').toUpperCase() === 'HEAD',
    handle: (url) => {
      const quality = Object.keys(sizes).find((key) => url.includes(`${key}${MID}`));
      const size = quality ? sizes[quality] : 0;
      return new Response(null, { status: 200, headers: { 'content-length': String(size) } });
    },
  });
}

function stubDownload(bytes: number, status = 200) {
  routes.push({
    name: 'download',
    match: (url, init) => url.startsWith(CDN) && String(init?.method || 'GET').toUpperCase() === 'GET',
    handle: () => new Response(new Uint8Array(bytes), {
      status,
      headers: { 'content-length': String(bytes) },
    }),
  });
}

/** 写一份 `auth qq` 形状的凭据；expired 用来模拟「cookie 还在但已过期」。 */
function writeCredential(expired = false) {
  const dir = join(tmpRoot, 'vdl', 'auth');
  mkdirSync(dir, { recursive: true });
  const expires = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  writeFileSync(join(dir, 'qq.json'), JSON.stringify({
    cookies: [
      { name: 'uin', value: 'o1234567890', domain: '.qq.com', expires },
      { name: 'qm_keyst', value: 'FAKEKEY', domain: '.qq.com', expires },
    ],
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

describe('QQ 音乐 probe：档位呈现', () => {
  test('T0 放行档进入 formats，推荐的是最高可用档', async () => {
    stubDetail();
    stubVkey(vkeyBody([{ quality: 'M800' }, { quality: 'M500' }]));
    stubHead({ M800: 9_600_000, M500: 3_840_000 });

    const probe = await probeQQ(MID);
    const available = probe.formats.filter((f) => f.available);
    expect(available.map((f) => f.id)).toEqual(['m800', 'm500']);
    expect(probe.formats.find((f) => f.recommended)?.id).toBe('m800');
    expect(probe.media?.title).toBe('测试曲');
    expect(probe.media?.duration_ms).toBe(240_000);
  });

  test('T1 未放行档位也要出现：available=false 且 reason 带真实 code', async () => {
    stubDetail();
    stubVkey(vkeyBody([
      { quality: 'M500' },
      { quality: 'M800', result: 104003, purl: null },
      // C400 / F000 接口根本没返回，同样算「未放行」，但不能凭空断言原因
    ]));
    stubHead({ M500: 3_840_000 });

    const probe = await probeQQ(MID);
    expect(probe.formats.map((f) => f.id)).toEqual(['m800', 'm500', 'c400', 'f000']);

    const denied = probe.formats.find((f) => f.id === 'm800');
    expect(denied?.available).toBe(false);
    expect(denied?.reason || '').toContain('104003');

    // 接口没返回的档位：如实说「没有返回」，不要编成「需要会员」
    const missing = probe.formats.find((f) => f.id === 'c400');
    expect(missing?.available).toBe(false);
    expect(missing?.reason || '').not.toContain('会员');
  });

  test('T2 已登录且全档被拒：不报 need_login', async () => {
    writeCredential();
    stubDetail();
    stubVkey(vkeyBody([
      { quality: 'M800', result: 104003, purl: null },
      { quality: 'M500', result: 104003, purl: null },
      { quality: 'C400', result: 104003, purl: null },
      { quality: 'F000', result: 104003, purl: null },
    ]));

    expect(await codeOf(() => probeQQ(MID))).toBe('filtered');
  });

  test('T3 未登录且全档被拒：need_login，并给出下一步', async () => {
    stubDetail();
    stubVkey(vkeyBody([{ quality: 'M500', result: 104003, purl: null }]));

    try {
      await probeQQ(MID);
      throw new Error('应当抛错');
    } catch (error: any) {
      expect(error.code).toBe('need_login');
      expect(String(error.nextAction || '').length).toBeGreaterThan(0);
    }
  });

  test('T6 凭据过期：明确说「已失效」，不能当成普通未登录', async () => {
    writeCredential(true);
    stubDetail();
    stubVkey(vkeyBody([{ quality: 'M500' }]));
    stubHead({ M500: 3_840_000 });

    const probe = await probeQQ(MID);
    expect(probe.warnings.some((w) => /过期|失效/.test(w))).toBe(true);
  });

  test('T8 vkey 接口 code≠0：报 vkey_failed，不假装成「没有这首歌」', async () => {
    stubDetail();
    routes.push({
      name: 'vkey-fail',
      match: (url) => url.includes('musicu.fcg'),
      handle: () => json({ req_1: { code: 2001, data: {} } }),
    });

    expect(await codeOf(() => probeQQ(MID))).toBe('vkey_failed');
  });

  test('T7 网络失败：不能误报成 not_found / need_login', async () => {
    routes.push({
      name: 'detail-net-error',
      match: (url) => url.includes('fcg_play_single_song'),
      handle: () => { throw new TypeError('fetch failed: ECONNRESET'); },
    });

    const code = await codeOf(() => probeQQ(MID));
    expect(['not_found', 'need_login', 'ok']).not.toContain(code);
  });
});

describe('QQ 音乐 get：不静默降级、不把片段当完整', () => {
  test('T4 显式指定的档位不可用：报 no_stream，不偷偷换成别的档', async () => {
    stubDetail();
    stubVkey(vkeyBody([{ quality: 'M500' }]));
    stubHead({ M500: 3_840_000 });
    stubDownload(200_000);

    const code = await codeOf(() => getQQ(MID, 'm800', outDir));
    expect(code).toBe('no_stream');
  });

  test('T5 实际字节远小于接口声明：不报「完成」', async () => {
    // 240 秒的歌、声明 3.84MB；接口只给了 480KB 的地址 —— 典型试听片段
    stubDetail();
    stubVkey(vkeyBody([{ quality: 'M500' }]));
    stubHead({ M500: 480_000 });
    stubDownload(480_000);

    const code = await codeOf(() => getQQ(MID, 'm500', outDir));
    expect(code).toBe('incomplete_media');
  });

  test('T5b 字节数与声明相符时仍然正常完成（防止上面那条把正常下载误判）', async () => {
    stubDetail();
    stubVkey(vkeyBody([{ quality: 'M500' }]));
    stubHead({ M500: 3_840_000 });
    stubDownload(3_840_000);

    const out: any = await getQQ(MID, 'm500', outDir);
    expect(out.bytes).toBe(3_840_000);
    expect(out.warnings.join(' ')).toContain('标签');
  });
});
