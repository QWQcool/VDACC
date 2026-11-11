import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const BASE = join(process.env.LOCALAPPDATA || '', 'vdl');
// VDL_AUTH_DIR 只用于测试/冒烟隔离：默认仍是用户目录。
// 没有这个开关时，对着运行中的服务点一次"退出登录"就会删掉真人凭据（本轮踩过）。
const AUTH = process.env.VDL_AUTH_DIR || join(BASE, 'auth');

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
  qq: {
    // 扫码入口在首页右上角「登录」；login() 里会尝试点一下，点不到就手点
    url: 'https://y.qq.com/',
    keys: ['qm_keyst'],
    label: 'QQ音乐',
    domain: 'qq.com',
  },
};

/**
 * 「上次登录为什么失败」（N19c）。
 *
 * 以前登录失败只留一行 `console.error('[auth_login_failed]')`——用户界面上看不到，
 * 事后也查不到。这里在进程内存里记一条：谁失败了、什么码、什么话、什么时候。
 * 只存内存，不落盘：重启后清零可以接受（失败信息本来就该是"最近一次"）。
 */
export interface AuthError { at: number; code: string; message: string }

const lastErrors = new Map<string, AuthError>();

export function noteAuthError(site: string, code: string, message: string) {
  lastErrors.set(site, { at: Date.now(), code, message: String(message || '').slice(0, 300) });
}

export function clearAuthError(site: string) {
  lastErrors.delete(site);
}

export function authErrorOf(site: string): AuthError | null {
  return lastErrors.get(site) || null;
}

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function fetchJson(url: string, init: RequestInit = {}, referer = ''): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': UA,
      ...(referer ? { Referer: referer } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  return res.json();
}

const CHECKS: Record<string, {
  label?: string;
  run: (cookie: string) => Promise<{ ok: boolean; message: string }>;
}> = {
  bilibili: {
    run: async (cookie) => {
      const j = await fetchJson('https://api.bilibili.com/x/web-interface/nav',
        { headers: { Cookie: cookie } }, 'https://www.bilibili.com/');
      return j?.data?.isLogin
        ? { ok: true, message: String(j.data.uname || '') }
        : { ok: false, message: `未登录（code=${j?.code ?? '?'}）` };
    },
  },
  netease: {
    run: async (cookie) => {
      const j = await fetchJson('https://music.163.com/api/nuser/account/get',
        { headers: { Cookie: cookie } }, 'https://music.163.com/');
      return j?.account?.id
        ? { ok: true, message: String(j?.profile?.nickname || j.account.id) }
        : { ok: false, message: `未登录（code=${j?.code ?? '?'}）` };
    },
  },
  qq: {
    run: async (cookie) => {
      const uin = /(?:^|;\s*)uin=o?(\d+)/.exec(cookie)?.[1] || '';
      if (!uin) return { ok: false, message: 'cookie 里没有 uin' };
      // 只带 uin 不够（实测 code=1000），还要带 qm_keyst 当 authst
      let authst = /(?:^|;\s*)qm_keyst=([^;]+)/.exec(cookie)?.[1] || '';
      try { authst = decodeURIComponent(authst); } catch { /* 保持原值 */ }
      if (!authst) return { ok: false, message: 'cookie 里没有 qm_keyst' };
      const data = JSON.stringify({
        comm: { ct: 24, cv: 0, uin: Number(uin), authst },
        req_1: { module: 'music.UserInfo.userInfoServer', method: 'GetLoginUserInfo', param: {} },
      });
      const j = await fetchJson(
        `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(data)}`,
        {}, 'https://y.qq.com/');
      const nick = j?.req_1?.data?.info?.nick;
      return j?.req_1?.code === 0 && nick
        ? { ok: true, message: String(nick) }
        : { ok: false, message: `未登录（code=${j?.req_1?.code ?? '?'}）` };
    },
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
      rows.push({ site, label: info.label, ...(await check.run(cookie)) });
    } catch (err) {
      rows.push({ site, label: info.label, ok: null, message: `校验失败：${(err as Error).message}` });
    }
  }
  return rows;
}

export async function login(site: string, timeoutMs = 300000) {
  const info = SITES[site];
  if (!info) throw new Error(`不认识这个站点: ${site}`);
  mkdirSync(AUTH, { recursive: true });

  // 真正的浏览器操作放在 auth-node.mjs，必须由 **node** 执行，不能用 bun。
  // 2026-11-10 实测（同机同版本 Edge 157）：node 下 connectOverCDP 成功、goto 拿到
  // 「哔哩哔哩」标题；bun 下 connectOverCDP 直接 30s 超时。原因是 playwright-core 的
  // WebSocket 依赖 Node 的 ws 语义，官方也只支持 Node。所以 Bun 侧只负责起子进程收结果。
  const script = join(import.meta.dir, 'auth-node.mjs');
  const child = spawn('node', [script, site, String(timeoutMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`无法启动 node（登录依赖它）：${err.message}`)));
    child.on('close', (c) => resolve(c ?? 1));
  });

  const last = stdout.trim().split('\n').pop() || '';
  let parsed: { ok: boolean; cookies?: number; error?: string } | null = null;
  try { parsed = JSON.parse(last); } catch { /* 落到下面统一报错 */ }

  if (!parsed) {
    const tail = (stderr.trim().split('\n').pop() || '').trim();
    throw new Error(`登录子进程退出码 ${code}，没有返回结果${tail ? '：' + tail : ''}`);
  }
  if (!parsed.ok) throw new Error(parsed.error || '登录失败');
  return { ok: true, site, cookies: Number(parsed.cookies || 0) };
}

