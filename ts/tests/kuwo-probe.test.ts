/**
 * 酷我 probe/get 的**离线**行为测试（ReversePlan 工作包 2，第三批）。
 *
 * 方法与前两批一致：替换 `globalThis.fetch`、临时 `%LOCALAPPDATA%`、
 * `VDL_FFMPEG` 指向不存在的路径（避免真跑标签写入）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getKuwo, probeKuwo } from '../src/engines/kuwo';

const RID = '228908';
const AUDIO = 'https://kw.example/';
const TOTAL = 3_368_054;

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
  tmpRoot = mkdtempSync(join(tmpdir(), 'vdacc-kw-'));
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

function stubInfo() {
  routes.push({
    name: 'songinfo',
    match: (url) => url.includes('/singles/songinfoandlrc'),
    handle: () => json({
      data: {
        songinfo: { songName: '测试曲', artist: '歌手A', album: '专辑', pic: '', duration: 240 },
        lrclist: [{ time: 0, lineLyric: '测试曲 - 歌手A' }],
      },
    }),
  });
}

function stubMobi(body: unknown) {
  routes.push({
    name: 'mobi',
    match: (url) => url.includes('mobi.kuwo.cn'),
    handle: () => json(body),
  });
}

function stubAnti(value: string) {
  routes.push({
    name: 'anti',
    match: (url) => url.includes('antiserver.kuwo.cn'),
    handle: () => new Response(value, { status: 200, headers: { 'content-type': 'text/plain' } }),
  });
}

/** 探测用 Range 请求 → 206 + content-range；下载请求 → 200 + 真实 body。 */
function stubAudio(total: number, downloadBytes: number) {
  routes.push({
    name: 'audio',
    match: (url) => url.startsWith(AUDIO),
    handle: (_url, init) => {
      if (headerOf(init, 'Range')) {
        return new Response(null, {
          status: 206,
          headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-15/${total}` },
        });
      }
      return new Response(new Uint8Array(downloadBytes), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(downloadBytes) },
      });
    },
  });
}

/** 下载返回指定字节（用来造带 ID3 的假 mp3）；总字节数按 body 长度给。 */
function stubAudioBytes(body: Uint8Array) {
  routes.push({
    name: 'audio-bytes',
    match: (url) => url.startsWith(AUDIO),
    handle: (_url, init) => {
      if (headerOf(init, 'Range')) {
        return new Response(null, {
          status: 206,
          headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-15/${body.length}` },
        });
      }
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(body.length) },
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

describe('酷我 probe', () => {
  test('K0 公开档正常：mobi 给出 128kbps 档', async () => {
    stubInfo();
    stubMobi({ data: { url: `${AUDIO}a.mp3`, format: 'mp3', bitrate: 128, duration: 240 } });
    stubAnti('not-a-url');
    stubAudio(TOTAL, TOTAL);

    const probe = await probeKuwo(RID);
    expect(probe.formats.map((f) => f.id)).toEqual(['kuwo-mobi']);
    expect(probe.formats[0].label).toBe('128kbps');
    expect(probe.formats[0].recommended).toBe(true);
  });

  test('K1 所有候选都不可用：filtered，而不是让用户去登录', async () => {
    stubInfo();
    stubMobi({ data: {} });          // mobi 没给地址
    stubAnti('error');               // antiserver 给的也不是地址

    expect(await codeOf(() => probeKuwo(RID))).toBe('filtered');
  });
});

describe('酷我 get', () => {
  test('K2 显式指定的档位不存在：no_stream，不换成别的档', async () => {
    stubInfo();
    stubMobi({ data: { url: `${AUDIO}a.mp3`, format: 'mp3', bitrate: 128, duration: 240 } });
    stubAnti('not-a-url');
    stubAudio(TOTAL, 200_000);

    expect(await codeOf(() => getKuwo(RID, 'kuwo-anti', outDir))).toBe('no_stream');
  });

  test('K3 实际字节远小于探测到的总大小：不报「完成」', async () => {
    stubInfo();
    stubMobi({ data: { url: `${AUDIO}a.mp3`, format: 'mp3', bitrate: 128, duration: 240 } });
    stubAnti('not-a-url');
    stubAudio(TOTAL, 480_000);

    expect(await codeOf(() => getKuwo(RID, 'kuwo-mobi', outDir))).toBe('incomplete_media');
  });

  test('K4 字节数与探测一致时正常完成（防误杀）', async () => {
    stubInfo();
    stubMobi({ data: { url: `${AUDIO}a.mp3`, format: 'mp3', bitrate: 128, duration: 240 } });
    stubAnti('not-a-url');
    stubAudio(TOTAL, TOTAL);

    const out: any = await getKuwo(RID, 'kuwo-mobi', outDir);
    expect(out.bytes).toBe(TOTAL);
    expect(out.warnings.join(' ')).toContain('标签');
  });

  test('K5 接口没给元数据时，标题取自文件内嵌 ID3', async () => {
    // 真实环境：songinfoandlrc 回 status=301「音乐查询失败」，标题退化成 kuwo-<rid>
    routes.push({
      name: 'songinfo-degraded',
      match: (url) => url.includes('/singles/songinfoandlrc'),
      handle: () => json({ data: null, msg: '音乐查询失败', status: 301 }),
    });
    stubMobi({ data: { url: `${AUDIO}a.mp3`, format: 'mp3', bitrate: 128, duration: 210 } });
    stubAnti('not-a-url');

    // 造一个带 ID3v2.3 的「mp3」：TIT2=花海 / TPE1=周杰伦（UTF-16 带 BOM，与真实文件一致）
    const tag = buildId3([
      ['TIT2', '花海'],
      ['TPE1', '周杰伦'],
    ]);
    const body = new Uint8Array(200_000);
    body.set(tag, 0);
    stubAudioBytes(body);

    const out: any = await getKuwo(RID, 'kuwo-mobi', outDir);
    expect(out.path).toContain('花海');
    expect(out.path).not.toContain('kuwo-');
    expect(out.warnings.join(' ')).toContain('内嵌标签');
  });
});

/* ── ID3 构造（只为造一个真实形状的文件头） ── */

function syncsafe4(n: number): number[] {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}

function buildId3(frames: Array<[string, string]>): Uint8Array {
  const parts: number[] = [];
  for (const [id, text] of frames) {
    const textBytes: number[] = [0xff, 0xfe]; // UTF-16LE BOM
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      textBytes.push(code & 0xff, (code >> 8) & 0xff);
    }
    const body = [1, ...textBytes]; // encoding=1 (UTF-16 with BOM)
    parts.push(...[...id].map((c) => c.charCodeAt(0)));
    parts.push((body.length >> 24) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff);
    parts.push(0, 0); // flags
    parts.push(...body);
  }
  const size = parts.length;
  return new Uint8Array([
    0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe4(size),
    ...parts,
  ]);
}
