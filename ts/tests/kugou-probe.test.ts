/**
 * 酷狗 probe/get 的**离线**行为测试（ReversePlan 工作包 2，第三批）。
 *
 * 重点盯两处「说得比知道的更多」：
 * 1. 公开档被文案称作「试听档」——实测那通常是整首 128kbps，不是片段；
 * 2. 把「搜索接口失败」说成「付费曲或账号未登录」——原因不明时不能下结论。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getKugou, probeKugou } from '../src/engines/kugou';

const HASH = 'a'.repeat(32);
const AUDIO = 'https://kg.example/';
const TOTAL = 4_631_150;

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
  tmpRoot = mkdtempSync(join(tmpdir(), 'vdacc-kg-'));
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

function stubInfo(patch: Record<string, unknown> = {}) {
  routes.push({
    name: 'songinfo',
    match: (url) => url.includes('getSongInfo.php'),
    handle: () => json({
      errcode: 0,
      songName: '测试曲',
      author_name: '歌手A',
      albumName: '专辑',
      album_img: '',
      url: `${AUDIO}a.mp3`,
      extName: 'mp3',
      bitRate: 128,
      fileSize: TOTAL,
      timeLength: 240,
      ...patch,
    }),
  });
}

/** 搜索接口：`paid` 表示平台把 320K/无损标成付费（pay_type=1）。 */
function stubSearch(mode: 'paid' | 'empty' | 'free') {
  routes.push({
    name: 'search',
    match: (url) => url.includes('/api/v3/search/song'),
    handle: () => json({
      data: {
        info: mode === 'empty' ? [] : [{
          hash: HASH,
          sqhash: mode === 'free' ? 'b'.repeat(32) : '',
          '320hash': mode === 'free' ? 'c'.repeat(32) : '',
          pay_type_sq: mode === 'paid' ? 1 : 0,
          pay_type_320: mode === 'paid' ? 1 : 0,
          sqfilesize: 25_000_000,
          '320filesize': 11_000_000,
        }],
      },
    }),
  });
}

function stubAudio(downloadBytes: number) {
  routes.push({
    name: 'audio',
    match: (url) => url.startsWith(AUDIO),
    handle: (_url, init) => {
      if (headerOf(init, 'Range')) {
        return new Response(null, {
          status: 206,
          headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-15/${TOTAL}` },
        });
      }
      return new Response(new Uint8Array(downloadBytes), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(downloadBytes) },
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

describe('酷狗 probe 的措辞与分类', () => {
  test('G0 公开档就是整首 128kbps：不能叫「试听档」，也不能断言账号未登录', async () => {
    stubInfo();
    stubSearch('paid');
    stubAudio(TOTAL);

    const probe = await probeKugou(HASH);
    expect(probe.formats.map((f) => f.id)).toEqual(['kg-128']);
    const text = probe.warnings.join(' ');
    expect(text).not.toContain('试听档');
    expect(text).not.toContain('账号未登录');
    // 平台标记付费是**证据**，可以照说
    expect(text).toContain('pay_type');
  });

  test('G1 搜索接口失败：说「档位信息获取失败」，不说成「未放行/付费」', async () => {
    stubInfo();
    // 不打桩 search → fetch 抛错 → searchQualities 吞掉
    stubAudio(TOTAL);

    const probe = await probeKugou(HASH);
    const text = probe.warnings.join(' ');
    expect(text).toContain('获取失败');
    expect(text).not.toContain('pay_type');
  });

  test('G2 完全没有地址：filtered（本引擎不支持登录，不指向登录）', async () => {
    stubInfo({ url: '' });
    stubSearch('empty');

    expect(await codeOf(() => probeKugou(HASH))).toBe('filtered');
  });
});

describe('酷狗 get', () => {
  test('G3 显式指定的档位不存在：no_stream，不换成公开档', async () => {
    stubInfo();
    stubSearch('paid');
    stubAudio(200_000);

    expect(await codeOf(() => getKugou(HASH, 'kg-320', outDir))).toBe('no_stream');
  });

  test('G4 实际字节远小于探测到的总大小：不报「完成」', async () => {
    stubInfo();
    stubSearch('paid');
    stubAudio(480_000);

    expect(await codeOf(() => getKugou(HASH, 'kg-128', outDir))).toBe('incomplete_media');
  });

  test('G5 字节数与探测一致时正常完成（防误杀）', async () => {
    stubInfo();
    stubSearch('paid');
    stubAudio(TOTAL);

    const out: any = await getKugou(HASH, 'kg-128', outDir);
    expect(out.bytes).toBe(TOTAL);
    expect(out.warnings.join(' ')).toContain('标签');
  });
});
