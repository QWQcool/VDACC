// 登录执行器：**必须用 node 运行**，不能用 bun。
//
// 2026-11-10 实测（同一台机器、同一份 Edge 157）：
//   node cdp_probe.mjs → CONNECTED, goto 成功, title=哔哩哔哩
//   bun  cdp_probe.mjs → connectOverCDP: Timeout
// 原因是 playwright-core 的 WebSocket 实现依赖 Node 的 ws 语义，在 Bun 下握手拿不到回应。
// Playwright 官方也只支持 Node（及实验性 Deno），不支持 Bun。
// 所以 server.ts（Bun）通过子进程调用本文件，本文件只依赖 node + playwright-core。
//
// 用法：node auth-node.mjs <site> <timeoutMs>
// 输出：最后一行打印 JSON { ok, site, cookies } 或 { ok:false, error }

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = join(process.env.LOCALAPPDATA || '', 'vdl');
const AUTH = join(BASE, 'auth');

const SITES = {
  bilibili: { url: 'https://www.bilibili.com/', keys: ['SESSDATA', 'DedeUserID'], domain: 'bilibili.com' },
  netease: { url: 'https://music.163.com/', keys: ['MUSIC_U'], domain: '163.com' },
  qq: { url: 'https://y.qq.com/', keys: ['qm_keyst'], domain: 'qq.com' },
};

function findEdge() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
  for (const root of roots) {
    const exe = join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

function toNetscape(state) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of state.cookies || []) {
    const domain = c.domain || '';
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push([domain, flag, c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

async function launchViaCdp(edge, profileDir) {
  const portFile = join(profileDir, 'DevToolsActivePort');
  // 必须清掉上次留下的端口文件：否则读到的是已经关闭的旧端口，connectOverCDP 会
  // 直接 ECONNREFUSED（2026-11-10 踩过）。
  try { rmSync(portFile, { force: true }); } catch { /* 不存在就算了 */ }
  const child = spawn(edge, [
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    'about:blank',
  ], { stdio: 'ignore' });

  const deadline = Date.now() + 25000;
  let port = 0;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const v = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (v && Number(v) > 0) { port = Number(v); break; }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!port) { try { child.kill(); } catch {} throw new Error('Edge 没有写出 DevToolsActivePort'); }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return { browser, child };
}

async function main() {
  const site = process.argv[2];
  const timeoutMs = Number(process.argv[3] || 300000);
  const info = SITES[site];
  if (!info) throw new Error('未知站点: ' + site);
  mkdirSync(AUTH, { recursive: true });

  const edge = findEdge();
  if (!edge) throw new Error('找不到系统 Edge（msedge.exe）');

  // 用一次性 profile：%LOCALAPPDATA%\vdl\profile 里有历史残留，且可能被别的实例占着，
  // 复用它时浏览器会连上 CDP 后立刻退出（browserContext.cookies: browser has been closed）。
  // 我们只需要登录后的 cookie，用临时 profile 最干净，登录完写 auth/*.json 即可。
  const profile = mkdtempSync(join(tmpdir(), 'vdacc-auth-'));

  const { browser, child } = await launchViaCdp(edge, profile);
  try {
    const context = browser.contexts()[0] || await browser.newContext({ viewport: null });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(info.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.error('[auth-node] loaded: ' + page.url());
    if (site === 'qq') {
      await page.locator('text=登录').first().click({ timeout: 5000 }).catch(() => {});
    }

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
    const filtered = {
      ...state,
      cookies: (state.cookies || []).filter((c) => String(c.domain || '').includes(info.domain)),
    };
    writeFileSync(join(AUTH, `${site}.json`), JSON.stringify(filtered, null, 2), 'utf8');
    writeFileSync(join(AUTH, `${site}.cookies.txt`), toNetscape(filtered), 'utf8');
    console.log(JSON.stringify({ ok: true, site, cookies: filtered.cookies.length }));
  } finally {
    await browser.close().catch(() => {});
    try { child.kill(); } catch {}
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exitCode = 1;
});
