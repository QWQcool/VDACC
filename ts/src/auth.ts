import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

const BASE = join(process.env.LOCALAPPDATA || '', 'vdl');
const PROFILE = join(BASE, 'profile');
const AUTH = join(BASE, 'auth');

export const SITES: Record<string, { url: string; keys: string[]; label: string; domain: string }> = {
  bilibili: {
    url: 'https://www.bilibili.com/',
    keys: ['SESSDATA', 'DedeUserID'],
    label: 'B站',
    domain: 'bilibili.com',
  },
  netease: {
    url: 'https://music.163.com/',
    keys: ['MUSIC_U'],
    label: '网易云',
    domain: '163.com',
  },
};

export function status() {
  const rows = [];
  for (const [site, info] of Object.entries(SITES)) {
    const file = join(AUTH, `${site}.json`);
    let cookies = 0;
    let updatedAt = 0;
    let loggedIn = false;
    if (existsSync(file)) {
      updatedAt = statSync(file).mtimeMs / 1000;
      try {
        const state = JSON.parse(readFileSync(file, 'utf8'));
        // 同一个 profile 里有多个站点的 cookie，只统计本站域名下的
        const own = (state.cookies || []).filter((c: any) =>
          String(c.domain || '').includes(info.domain));
        cookies = own.length;
        const names = new Set(own.map((c: any) => c.name));
        loggedIn = info.keys.every((k) => names.has(k));
      } catch {
        loggedIn = false;
      }
    }
    rows.push({ site, label: info.label, loggedIn, cookies, updatedAt });
  }
  return rows;
}

export function clear(site: string) {
  const info = SITES[site];
  if (!info) throw new Error(`不认识这个站点: ${site}`);
  for (const file of [`${site}.json`, `${site}.cookies.txt`]) {
    const path = join(AUTH, file);
    if (existsSync(path)) unlinkSync(path);
  }
  return true;
}

/**
 * 在线校验本地凭据是否还有效。
 * 只数 cookie 名会误报——实测 B站 的 SESSDATA 过期后名字还在，`auth --status` 仍显示「已登录」，
 * 而 probe 只给到 480P。网络失败单独返回 ok=null，不要把它说成「登录过期」。
 */
export interface VerifyRow {
  site: string;
  label: string;
  ok: boolean | null;
  message: string;
}

const CHECKS: Record<string, { url: string; inspect: (json: any) => { ok: boolean; message: string } }> = {
  bilibili: {
    url: 'https://api.bilibili.com/x/web-interface/nav',
    inspect: (j) => (j?.data?.isLogin
      ? { ok: true, message: String(j.data.uname || '') }
      : { ok: false, message: `未登录（code=${j?.code ?? '?'}）` }),
  },
  netease: {
    url: 'https://music.163.com/api/nuser/account/get',
    inspect: (j) => (j?.account?.id
      ? { ok: true, message: String(j?.profile?.nickname || j.account.id) }
      : { ok: false, message: `未登录（code=${j?.code ?? '?'}）` }),
  },
};

/** 从 storage_state 里拼本站未过期 cookie；值只用于请求头，不打印。 */
function cookieHeader(site: string): string {
  const file = join(AUTH, `${site}.json`);
  if (!existsSync(file)) return '';
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const now = Date.now() / 1000;
    return (state.cookies || [])
      .filter((c: any) => String(c.domain || '').includes(SITES[site]?.domain || site))
      .filter((c: any) => !c.expires || c.expires < 0 || c.expires > now)
      .map((c: any) => `${c.name}=${c.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

export async function verify(): Promise<VerifyRow[]> {
  const rows: VerifyRow[] = [];
  for (const [site, info] of Object.entries(SITES)) {
    const check = CHECKS[site];
    if (!check) continue;
    const cookie = cookieHeader(site);
    if (!cookie) {
      rows.push({ site, label: info.label, ok: false, message: '本地没有凭据' });
      continue;
    }
    try {
      const res = await fetch(check.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
          Referer: info.url,
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(8000),
      });
      rows.push({ site, label: info.label, ...check.inspect(await res.json()) });
    } catch (err) {
      rows.push({ site, label: info.label, ok: null, message: `校验失败：${(err as Error).message}` });
    }
  }
  return rows;
}

function toNetscape(state: any): string {
  const lines = ['# Netscape HTTP Cookie File', ''];
  for (const c of state.cookies || []) {
    const domain = c.domain || '';
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expiry = Math.round(Number(c.expires || 0) > 0 ? c.expires : 0);
    lines.push([domain, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE',
      String(expiry), c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

export async function login(site: string, timeoutMs = 300000) {
  const info = SITES[site];
  if (!info) throw new Error(`不认识这个站点: ${site}`);
  mkdirSync(AUTH, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: false,
    viewport: null,
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(info.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const deadline = Date.now() + timeoutMs;
    let ok = false;
    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      const names = new Set(cookies.map((c) => c.name));
      if (info.keys.every((k) => names.has(k))) { ok = true; break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ok) throw new Error('等待登录超时');

    const state = await context.storageState();
    // 只落本站域名，避免把 B站 与网易云的 cookie 混进同一个文件
    const filtered = {
      ...state,
      cookies: (state.cookies || []).filter((c) =>
        String(c.domain || '').includes(info.domain)),
    };
    writeFileSync(join(AUTH, `${site}.json`), JSON.stringify(filtered, null, 2), 'utf8');
    writeFileSync(join(AUTH, `${site}.cookies.txt`), toNetscape(filtered), 'utf8');
    return { ok: true, site, cookies: filtered.cookies.length };
  } finally {
    await context.close();
  }
}
