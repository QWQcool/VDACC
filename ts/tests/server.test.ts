import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 18000 + Math.floor(Math.random() * 2000);
const TOKEN = 'test-token';
const TMP = mkdtempSync(join(tmpdir(), 'vdl-ts-test-'));
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitUp() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`, { headers: { 'X-VDL-Token': TOKEN } });
      if (res.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server 未在 10s 内启动');
}

beforeAll(async () => {
  mkdirSync(join(TMP, 'out'));
  mkdirSync(join(TMP, 'out-neighbor'));
  writeFileSync(join(TMP, 'out', 'inside.txt'), 'inside');
  writeFileSync(join(TMP, 'out-neighbor', 'outside.txt'), 'outside');
  writeFileSync(join(TMP, 'jobs.json'), JSON.stringify({ jobs: [
    { id: 'aabb', status: 'done', path: join(TMP, 'out', 'inside.txt'), createdAt: 1 },
    { id: 'ccdd', status: 'done', path: join(TMP, 'out-neighbor', 'outside.txt'), createdAt: 2 },
  ] }));
  proc = Bun.spawn([
    process.execPath,
    join(import.meta.dir, '..', 'src', 'server.ts'),
    '--port', String(PORT), '--token', TOKEN,
    '-o', join(TMP, 'out'),
  ], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, LOCALAPPDATA: join(TMP, 'user'), VDL_STORE: join(TMP, 'jobs.json'), VDL_ALLOW_ORIGIN: '' },
    stdout: 'ignore', stderr: 'ignore',
  });
  await waitUp();
});

afterAll(async () => {
  try { proc?.kill(); } catch { /* ignore */ }
  await proc?.exited;
  rmSync(TMP, { recursive: true, force: true });
});

const authed = (path: string, init: RequestInit = {}) =>
  fetch(BASE + path, {
    ...init,
    headers: { 'X-VDL-Token': TOKEN, ...(init.headers || {}) },
  });

describe('服务端安全边界', () => {
  test('无 token 401', async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.status).toBe(401);
  });

  test('带 token 200', async () => {
    const res = await authed('/api/health');
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.version).toBe('3.4.1');
  });

  test('伪造 Origin 403', async () => {
    const res = await authed('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.com' },
      body: JSON.stringify({ url: 'BV1j5nj68E48' }),
    });
    expect(res.status).toBe(403);
  });

  test('本机名前缀和错误端口也拒绝，同源正常放行', async () => {
    for (const origin of ['http://localhost.evil.invalid', 'http://127.0.0.1.evil.invalid',
      `http://127.0.0.1:${PORT + 1}`]) {
      expect((await authed('/api/health', { headers: { Origin: origin } })).status).toBe(403);
    }
    expect((await authed('/api/health', { headers: { Origin: BASE } })).status).toBe(200);
  });

  test('preview / files / reveal 均拒绝相邻前缀目录，正常文件可读', async () => {
    const outside = join(TMP, 'out-neighbor', 'outside.txt');
    expect((await authed('/api/preview?path=' + encodeURIComponent(outside))).status).toBe(403);
    expect((await authed('/api/files/ccdd')).status).toBe(403);
    expect((await authed('/api/reveal', { method: 'POST', body: JSON.stringify({ path: outside }) })).status).toBe(400);
    expect(await (await authed('/api/files/aabb')).text()).toBe('inside');
    expect(await (await authed('/api/preview?path=' + encodeURIComponent(join(TMP, 'out', 'inside.txt')))).text()).toBe('inside');
  });

  test('未知接口 404', async () => {
    const res = await authed('/api/nope');
    expect(res.status).toBe(404);
  });

  test('文件回传只认已完成任务', async () => {
    const res = await authed('/api/files/deadbeef');
    expect(res.status).toBe(404);
  });

  test('静态页无需 token', async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toContain('text/html');
  });

  test('Vue 页面可访问（目录自动补 index.html）', async () => {
    const res = await fetch(`${BASE}/vue/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('vue.global.prod.js');
  });

  test('Vue 运行时本地托管', async () => {
    const res = await fetch(`${BASE}/vendor/vue.global.prod.js`);
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('content-length') || 0)).toBeGreaterThan(100000);
  });
});

describe('设置', () => {
  test('GET 返回对象', async () => {
    const res = await authed('/api/settings');
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(typeof data.settings).toBe('object');
  });

  test('首次保存持久化，非法配置不改变运行中的值', async () => {
    const patch = (body: unknown) => authed('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });
    const res = await patch({ theme: 'dark', limitRate: 4096 });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(join(TMP, 'user', 'vdl', 'config.json'), 'utf8')))
      .toEqual({ theme: 'dark', limitRate: 4096 });
    expect((await patch({ limitRate: -1 })).status).toBe(400);
    expect((await patch(null)).status).toBe(400);
    expect((await (await authed('/api/health')).json() as any).limitRate).toBe(4096);
  });
});

describe('队列持久化与事件重连', () => {
  test('历史写盘失败时整批回滚，API 不假报成功或启动下载', async () => {
    const file = join(TMP, 'jobs.json');
    renameSync(file, file + '.backup'); mkdirSync(file);
    const before = (await (await authed('/api/jobs')).json() as any).jobs.length;
    try {
      const res = await authed('/api/jobs', { method: 'POST', body: JSON.stringify({
        url: 'https://example.invalid/unsupported', formatIds: ['a', 'b'],
      }) });
      expect(res.status).toBe(500);
      expect((await res.json() as any).error.code).toBe('storage_write_failed');
      expect((await (await authed('/api/jobs')).json() as any).jobs.length).toBe(before);
    } finally { rmdirSync(file); renameSync(file + '.backup', file); }
  });

  test('无效批量请求不创建任务；失败任务写盘且 SSE 新连接得到终态', async () => {
    const invalid = await authed('/api/jobs', { method: 'POST', body: JSON.stringify({
      url: 'https://example.invalid/unsupported', formatIds: Array.from({ length: 21 }, (_, i) => String(i)),
    }) });
    expect(invalid.status).toBe(400);
    const res = await authed('/api/jobs', { method: 'POST', body: JSON.stringify({
      url: 'https://example.invalid/unsupported', formatId: '', cover: true,
    }) });
    expect(res.status).toBe(202);
    const data = await res.json() as any;
    const id = data.job?.id || data.jobs?.[0]?.id;
    expect(id).toBeTruthy();
    for (let i = 0; i < 30; i++) {
      const stored = JSON.parse(readFileSync(join(TMP, 'jobs.json'), 'utf8')).jobs.find((j: any) => j.id === id);
      if (stored?.status === 'failed') break;
      await Bun.sleep(20);
    }
    const stored = JSON.parse(readFileSync(join(TMP, 'jobs.json'), 'utf8')).jobs.find((j: any) => j.id === id);
    expect(stored.status).toBe('failed'); expect(stored.cover).toBe(true);
    expect(stored.error.code).toBe('engine_unavailable');
    const abort = new AbortController();
    const events = await authed('/api/events', { signal: abort.signal });
    const reader = events.body!.getReader();
    let snapshot = '';
    while (!snapshot.includes(': connected')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      snapshot += new TextDecoder().decode(chunk.value);
    }
    abort.abort();
    expect(snapshot).toContain(`"id":"${id}"`);
    expect(snapshot).toContain('engine_unavailable');
  });
});
