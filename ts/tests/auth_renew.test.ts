import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renewStatus } from '../src/auth_renew';

const tempAuthDir = () => mkdtempSync(join(tmpdir(), 'vdacc-renew-'));

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

/** 写一份最小可用的 storage_state；meta 可选（模拟"扫码时是否记了 refresh_token"）。 */
function writeCred(dir: string, opts: { meta?: Record<string, unknown>; noCsrf?: boolean } = {}) {
  const cookies = [
    { name: 'SESSDATA', value: 's', domain: '.bilibili.com', path: '/', expires: -1 },
    { name: 'DedeUserID', value: '42', domain: '.bilibili.com', path: '/', expires: -1 },
    ...(opts.noCsrf ? [] : [{ name: 'bili_jct', value: 'jct', domain: '.bilibili.com', path: '/', expires: -1 }]),
  ];
  writeFileSync(join(dir, 'bilibili.json'), JSON.stringify({
    cookies, origins: [], ...(opts.meta ? { meta: opts.meta } : {}),
  }), 'utf8');
}

describe('B站 续期状态', () => {
  test('没有凭据时如实说没有', async () => {
    const st = await renewStatus({ authDir: tempAuthDir() });
    expect(st.state).toBe('no_credential');
    expect(st.canAutoRenew).toBe(false);
  });

  test('缺 bili_jct（拿不到 csrf）→ need_login，而不是发一个没有 csrf 的请求', async () => {
    const dir = tempAuthDir();
    writeCred(dir, { noCsrf: true });
    let called = false;
    const st = await renewStatus({
      authDir: dir,
      fetch: (async () => { called = true; return json({ code: 0, data: { refresh: false } }); }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(st.state).toBe('need_login');
  });

  test('平台说不需要续期：needsRenew=false，并说明没记 refresh_token', async () => {
    const dir = tempAuthDir();
    writeCred(dir);
    let seen = '';
    const st = await renewStatus({
      authDir: dir,
      fetch: (async (url: string) => {
        seen = String(url);
        return json({ code: 0, data: { refresh: false, timestamp: 1 } });
      }) as unknown as typeof fetch,
    });
    expect(seen).toContain('/cookie/info?csrf=jct');
    expect(st.state).toBe('ok');
    expect(st.needsRenew).toBe(false);
    expect(st.canAutoRenew).toBe(false);
    expect(st.message).toContain('未记录 refresh_token');
  });

  test('平台建议刷新 + 本地有 refresh_token → needsRenew 与 canAutoRenew 都为真', async () => {
    const dir = tempAuthDir();
    writeCred(dir, { meta: { refreshToken: 'rt', refreshAt: 1 } });
    const st = await renewStatus({
      authDir: dir,
      fetch: (async () => json({ code: 0, data: { refresh: true } })) as unknown as typeof fetch,
    });
    expect(st.needsRenew).toBe(true);
    expect(st.canAutoRenew).toBe(true);
    expect(st.message).toContain('平台建议刷新');
  });

  test('平台回 -101：凭据已失效，要求重新扫码', async () => {
    const dir = tempAuthDir();
    writeCred(dir);
    const st = await renewStatus({
      authDir: dir,
      fetch: (async () => json({ code: -101, message: '账号未登录' })) as unknown as typeof fetch,
    });
    expect(st.state).toBe('need_login');
    expect(st.message).toContain('重新扫码');
  });

  test('网络失败归到 error，不冒充"需要续期"', async () => {
    const dir = tempAuthDir();
    writeCred(dir);
    const st = await renewStatus({
      authDir: dir,
      fetch: (async () => { throw new Error('socket hang up'); }) as unknown as typeof fetch,
    });
    expect(st.state).toBe('error');
    expect(st.needsRenew).toBe(false);
  });

  test('凭据文件损坏：报 error，不抛出去', async () => {
    const dir = tempAuthDir();
    writeFileSync(join(dir, 'bilibili.json'), '{not json', 'utf8');
    const st = await renewStatus({ authDir: dir });
    expect(st.state).toBe('error');
    expect(st.message).toContain('凭据文件读不出来');
  });
});
