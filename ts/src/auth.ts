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
