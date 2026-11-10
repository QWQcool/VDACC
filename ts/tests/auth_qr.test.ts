import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cookiesFromUrl, generateBilibili, logoutSite, mergeCookies,
  parseSetCookie, pollBilibili, qrGenerate,
} from '../src/auth_qr';

const tempAuthDir = () => mkdtempSync(join(tmpdir(), 'vdacc-qr-'));

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(
  JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } },
);

const CROSS_DOMAIN = 'https://passport.biligame.com/crossDomain?DedeUserID=42&DedeUserID__ckMd5=ck'
  + '&Expires=1893456000&SESSDATA=sess%2Cvalue&bili_jct=jct&gourl=https%3A%2F%2Fwww.bilibili.com';

describe('扫码 generate', () => {
  test('拿到 key 与二维码图，不碰真实网络', async () => {
    const dir = tempAuthDir();
    const out = await generateBilibili({
      authDir: dir,
      qr: async (url) => `data:image/png;base64,FAKE:${url.length}`,
      fetch: (async () => json({
        code: 0,
        data: { url: 'https://account.bilibili.com/h5/scan?qrcode_key=k1', qrcode_key: 'k1' },
      })) as unknown as typeof fetch,
    });
    expect(out.key).toBe('k1');
    expect(out.qrDataUrl.startsWith('data:image/png;base64,FAKE:')).toBe(true);
    expect(out.expiresIn).toBe(180);
  });

  test('接口少字段时明确报错，不返回半成品', async () => {
    await expect(generateBilibili({
      fetch: (async () => json({ code: 0, data: { url: '' } })) as unknown as typeof fetch,
    })).rejects.toThrow(/没有返回 url/);
  });

  test('网络异常归到 network，而不是内部错误', async () => {
    await expect(generateBilibili({
      fetch: (async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch,
    })).rejects.toThrow(/网络请求失败|请求 B站 失败/);
  });
});

describe('扫码状态机', () => {
  const pollWith = (data: unknown) => (async () => json({ code: 0, data })) as unknown as typeof fetch;

  test('86101 未扫码', async () => {
    const r = await pollBilibili('k', { fetch: pollWith({ code: 86101, message: '未扫码' }) });
    expect(r.state).toBe('pending');
    expect(r.saved).toBeUndefined();
  });

  test('86090 已扫码待确认', async () => {
    const r = await pollBilibili('k', { fetch: pollWith({ code: 86090, message: '扫码成功，请在手机上确认' }) });
    expect(r.state).toBe('scanned');
  });

  test('86038 已过期', async () => {
    const r = await pollBilibili('k', { fetch: pollWith({ code: 86038, message: '二维码已失效' }) });
    expect(r.state).toBe('expired');
  });

  test('未知状态码不当成功处理', async () => {
    const r = await pollBilibili('k', { fetch: pollWith({ code: 12345, message: '怪东西' }) });
    expect(r.state).toBe('error');
    expect(r.message).toContain('12345');
  });
});

describe('扫码成功后的 cookie 落盘', () => {
  test('两路并集写 storage_state 形状，并用 nav 判真', async () => {
    const dir = tempAuthDir();
    let seenCookie = '';
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/qrcode/poll')) {
        return json(
          { code: 0, data: { code: 0, url: CROSS_DOMAIN, timestamp: 1893456000 } },
          { 'set-cookie': 'buvid3=buv; Path=/; Max-Age=15552000' },
        );
      }
      seenCookie = 'nav-called';
      return json({ code: 0, data: { isLogin: true, mid: 42, uname: '测试账号', vip_label: '年度大会员' } });
    }) as unknown as typeof fetch;

    const r = await pollBilibili('k', { authDir: dir, fetch: fetchImpl, now: () => 1_700_000_000 });
    expect(r.state).toBe('ok');
    expect(r.account?.uname).toBe('测试账号');
    expect(r.account?.vipLabel).toBe('年度大会员');
    expect(seenCookie).toBe('nav-called');

    const state = JSON.parse(readFileSync(join(dir, 'bilibili.json'), 'utf8'));
    const names = state.cookies.map((c: { name: string }) => c.name).sort();
    // Set-Cookie 的 buvid3 + url 里的四个，且 gourl/Expires 不能被当成 cookie
    expect(names).toEqual(['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct', 'buvid3']);
    expect(state.origins).toEqual([]);
    const sess = state.cookies.find((c: { name: string }) => c.name === 'SESSDATA');
    expect(sess.value).toBe('sess,value');
    expect(sess.domain).toContain('bilibili.com');

    // 必须同时写 Netscape txt：bilibili_api.cookieHeader() 优先读它，
    // 只写 json 时旧 txt 会把新 cookie 盖住（扫码成功但引擎仍用旧凭据）
    const txt = readFileSync(join(dir, 'bilibili.cookies.txt'), 'utf8');
    expect(txt.split('\n')[0]).toBe('# Netscape HTTP Cookie File');
    const sessLine = txt.split('\n').find((l) => l.includes('\tSESSDATA\t'));
    expect(sessLine).toBeTruthy();
    expect(sessLine?.split('\t').length).toBe(7);
  });

  test('vip_label 是对象时取 text（实测真实账号就是这样）', async () => {
    const dir = tempAuthDir();
    const fetchImpl = (async (url: string) => (String(url).includes('/qrcode/poll')
      ? json({ code: 0, data: { code: 0, url: CROSS_DOMAIN } }, { 'set-cookie': 'buvid3=buv' })
      : json({
        code: 0,
        data: {
          isLogin: true,
          mid: 42,
          uname: '晨星成焰',
          vip_label: { path: 'http://i0.hdslb.com/bfs/vip/label_annual.png', text: '年度大会员', label_theme: 'annual_vip' },
        },
      }))) as unknown as typeof fetch;

    const r = await pollBilibili('k', { authDir: dir, fetch: fetchImpl, now: () => 1_700_000_000 });
    expect(r.account?.vipLabel).toBe('年度大会员');
  });

  test('nav 说未登录时删掉凭据并报错，不留假成功', async () => {
    const dir = tempAuthDir();
    const fetchImpl = (async (url: string) => (String(url).includes('/qrcode/poll')
      ? json({ code: 0, data: { code: 0, url: CROSS_DOMAIN } }, { 'set-cookie': 'buvid3=buv' })
      : json({ code: -101, data: { isLogin: false } }))) as unknown as typeof fetch;

    const r = await pollBilibili('k', { authDir: dir, fetch: fetchImpl, now: () => 1_700_000_000 });
    expect(r.state).toBe('error');
    expect(r.saved).toBe(false);
    expect(existsSync(join(dir, 'bilibili.json'))).toBe(false);
  });

  test('nav 请求本身失败时保留凭据，但标 unverified 而不是 ok', async () => {
    const dir = tempAuthDir();
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/qrcode/poll')) {
        return json({ code: 0, data: { code: 0, url: CROSS_DOMAIN } }, { 'set-cookie': 'buvid3=buv' });
      }
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;

    const r = await pollBilibili('k', { authDir: dir, fetch: fetchImpl, now: () => 1_700_000_000 });
    expect(r.state).toBe('unverified');
    expect(r.saved).toBe(true);
    expect(existsSync(join(dir, 'bilibili.json'))).toBe(true);
  });

  test('一条 cookie 都没拿到就说不完整，不写空文件', async () => {
    const dir = tempAuthDir();
    const r = await pollBilibili('k', {
      authDir: dir,
      fetch: (async () => json({ code: 0, data: { code: 0, url: '' } })) as unknown as typeof fetch,
    });
    expect(r.state).toBe('error');
    expect(existsSync(join(dir, 'bilibili.json'))).toBe(false);
  });
});

describe('cookie 解析细节', () => {
  test('Max-Age 换算成绝对时间，Expires 用 GMT 日期', () => {
    const now = 1_700_000_000;
    const a = parseSetCookie('SESSDATA=x; Path=/; Max-Age=3600', now);
    expect(a?.expires).toBe(now + 3600);
    const b = parseSetCookie('DedeUserID=42; Expires=Wed, 01 Jan 2031 00:00:00 GMT', now);
    expect(b?.expires).toBe(Math.floor(Date.parse('Wed, 01 Jan 2031 00:00:00 GMT') / 1000));
    expect(parseSetCookie('no-equals', now)).toBeNull();
  });

  test('跳转参数不会被当成 cookie', () => {
    const list = cookiesFromUrl(CROSS_DOMAIN);
    const names = list.map((c) => c.name).sort();
    expect(names).toEqual(['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct']);
    expect(list.every((c) => c.expires === 1893456000)).toBe(true);
    expect(cookiesFromUrl('not-a-url')).toEqual([]);
  });

  test('同名以 Set-Cookie 为准，空值丢弃', () => {
    const merged = mergeCookies(
      [{ name: 'SESSDATA', value: 'from-header', domain: '.bilibili.com', path: '/', expires: -1 },
        { name: 'bili_jct', value: '', domain: '.bilibili.com', path: '/', expires: -1 }],
      [{ name: 'SESSDATA', value: 'from-url', domain: '.bilibili.com', path: '/', expires: 1 },
        { name: 'bili_jct', value: 'jct', domain: '.bilibili.com', path: '/', expires: 1 }],
    );
    expect(merged).toEqual([
      { name: 'SESSDATA', value: 'from-header', domain: '.bilibili.com', path: '/', expires: -1 },
      { name: 'bili_jct', value: 'jct', domain: '.bilibili.com', path: '/', expires: 1 },
    ]);
  });
});

describe('退出登录', () => {
  test('有文件则删，没有则返回 false', async () => {
    const dir = tempAuthDir();
    const fetchImpl = (async (url: string) => (String(url).includes('/qrcode/poll')
      ? json({ code: 0, data: { code: 0, url: CROSS_DOMAIN } }, { 'set-cookie': 'buvid3=buv' })
      : json({ code: 0, data: { isLogin: true, mid: 1, uname: 'u' } }))) as unknown as typeof fetch;
    await pollBilibili('k', { authDir: dir, fetch: fetchImpl, now: () => 1_700_000_000 });
    expect(existsSync(join(dir, 'bilibili.json'))).toBe(true);
    expect(logoutSite('bilibili', { authDir: dir })).toBe(true);
    expect(existsSync(join(dir, 'bilibili.json'))).toBe(false);
    expect(logoutSite('bilibili', { authDir: dir })).toBe(false);
  });
});
