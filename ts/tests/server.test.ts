import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
  proc = Bun.spawn([
    process.execPath,
    join(import.meta.dir, '..', 'src', 'server.ts'),
    '--port', String(PORT), '--token', TOKEN,
    '-o', join(TMP, 'out'),
  ], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, VDL_STORE: join(TMP, 'jobs.json') },
    stdout: 'ignore', stderr: 'ignore',
  });
  await waitUp();
});

afterAll(() => {
  try { proc?.kill(); } catch { /* ignore */ }
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
    expect(data.version).toStartWith('3.3.0');
  });

  test('伪造 Origin 403', async () => {
    const res = await authed('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.com' },
      body: JSON.stringify({ url: 'BV1j5nj68E48' }),
    });
    expect(res.status).toBe(403);
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
});
