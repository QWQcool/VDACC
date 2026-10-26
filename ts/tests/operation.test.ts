import { afterAll, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationState, runOperation } from '../src/core/operation';
import { report } from '../src/core/progress';
import { DownloadCancelled, isCancelled, throwIfCancelled } from '../src/core/cancel';
import { getBilibiliApi, probeBilibiliApi } from '../src/engines/bilibili_api';
import { saveCover } from '../src/core/sidecar';

const dir = mkdtempSync(join(tmpdir(), 'vdl-operation-'));
const originalFetch = globalThis.fetch;
const originalLocal = process.env.LOCALAPPDATA;
const originalFfmpeg = process.env.VDL_FFMPEG;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocal;
  if (originalFfmpeg === undefined) delete process.env.VDL_FFMPEG;
  else process.env.VDL_FFMPEG = originalFfmpeg;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('isCancelled 只看当前任务作用域，不误伤别的任务', () => {
  expect(isCancelled()).toBe(false);
  runOperation(() => {
    expect(isCancelled()).toBe(true);
  }, { cancelled: () => true });
  runOperation(() => {
    expect(isCancelled()).toBe(false);
  }, { cancelled: () => false });
});

test('交错执行的进度、取消和媒体状态只属于各自任务', async () => {
  const state = operationState(() => ({ title: '' }));
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const a = runOperation(async () => {
    state().title = 'A'; await gate;
    expect(state().title).toBe('A'); report(10, 100);
    expect(() => throwIfCancelled()).toThrow(DownloadCancelled);
  }, { progress: (w) => events.push(`A:${w}`), cancelled: () => true });
  await runOperation(async () => {
    state().title = 'B'; report(20, 100);
    expect(() => throwIfCancelled()).not.toThrow(); release();
  }, { progress: (w) => events.push(`B:${w}`), cancelled: () => false });
  await a;
  expect(events).toEqual(['B:20', 'A:10']);
});

const A = 'BV1234567890', B = 'BV0987654321';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function mockBili(onSubtitle: () => Promise<void> = async () => {}, subtitleFails = false) {
  const calls: string[] = [];
  process.env.LOCALAPPDATA = join(dir, 'empty-user');
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input)); calls.push(url.href);
    const reply = (data: any) => Response.json({ code: 0, data });
    if (url.pathname === '/x/web-interface/view') {
      const isA = url.searchParams.get('bvid') === A;
      return reply({ title: isA ? 'Alpha' : 'Beta', pic: 'https://media.invalid/cover',
        pages: [{ page: 1, cid: isA ? 111 : 222 }], duration: 10 });
    }
    if (url.pathname === '/x/player/playurl') return reply({ timelength: 10000, dash: {
      video: [{ width: 1920, height: 1080, codecs: 'avc1', bandwidth: 100,
        baseUrl: 'https://media.invalid/video' }],
      audio: [{ bandwidth: 10, codecs: 'mp4a', baseUrl: 'https://media.invalid/audio' }],
    } });
    if (url.pathname === '/x/player/v2') {
      await onSubtitle();
      return reply({ subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://media.invalid/sub' }] } });
    }
    if (url.pathname === '/x/v1/dm/list.so') return new Response('<i><d p="0">Alpha</d></i>');
    if (url.pathname === '/sub') return subtitleFails ? new Response('failed', { status: 500 })
      : Response.json({ body: [{ from: 0, to: 1, content: 'Alpha subtitle' }] });
    if (url.pathname === '/cover') return new Response(png);
    if (['/video', '/audio'].includes(url.pathname)) return new Response('track', { headers: { 'Content-Length': '5' } });
    throw new Error('未模拟的请求');
  }) as typeof fetch;
  return calls;
}

test('真实 B站 get A 等字幕时 probe B，不串弹幕 cid；跳过已有视频仍补封面和字幕', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const calls = mockBili(async () => { entered(); await gate; });
  const dest = join(dir, `${A}_Alpha_1080P.mp4`);
  writeFileSync(dest, 'original video');
  const pending = getBilibiliApi(A, 'bili-1920', dir, { subs: true, danmaku: true, cover: true });
  await started;
  try { await probeBilibiliApi(B); } finally { release(); }
  const out = await pending;
  expect(out.skipped).toBe(true); expect(out.srtCount).toBe(1); expect(out.danmakuCount).toBe(1);
  expect(out.warnings).toEqual([]); expect(out.cover).toEndWith('.png');
  expect(readFileSync(out.srt!, 'utf8')).toContain('Alpha subtitle');
  expect(readFileSync(dest, 'utf8')).toBe('original video');
  expect(calls.filter((url) => url.includes('list.so'))).toEqual(['https://api.bilibili.com/x/v1/dm/list.so?oid=111']);
});

test('字幕下载失败不把轨道数当成已保存行数，不丢主文件', async () => {
  mockBili(undefined, true);
  writeFileSync(join(dir, `${A}_Alpha_1080P.mp4`), 'original video');
  const out = await getBilibiliApi(A, 'bili-1920', dir, { subs: true });
  expect(out.srt).toBeNull(); expect(out.srtCount).toBe(0);
  expect(out.warnings.join(' ')).toContain('字幕'); expect(out.bytes).toBe(14);
});

test('ffmpeg 不可用保留音视频分离流，不留下貌似成功的 mp4', async () => {
  mockBili();
  process.env.VDL_FFMPEG = join(dir, 'missing-ffmpeg.exe');
  const output = join(dir, 'merge-failure');
  await expect(getBilibiliApi(A, 'bili-1920', output)).rejects.toMatchObject({ code: 'ffmpeg_missing' });
  const dest = join(output, `${A}_Alpha_1080P.mp4`);
  expect(existsSync(dest)).toBe(false);
  expect(readFileSync(dest + '.video.m4s', 'utf8')).toBe('track');
  expect(readFileSync(dest + '.audio.m4s', 'utf8')).toBe('track');
});

test('200 HTML 错误页不能覆盖有效封面；附属失败只返回警告', async () => {
  const dest = join(dir, 'existing.mp4');
  writeFileSync(dest, 'video'); writeFileSync(join(dir, 'existing.jpg'), 'keep image');
  globalThis.fetch = (async () => new Response('<html>error</html>')) as typeof fetch;
  const out = await saveCover(dest, 'https://media.invalid/image', 'https://example.invalid');
  expect(out.cover).toBeNull(); expect(out.warnings).toHaveLength(1);
  expect(readFileSync(join(dir, 'existing.jpg'), 'utf8')).toBe('keep image');
  expect(readFileSync(dest, 'utf8')).toBe('video');
});
