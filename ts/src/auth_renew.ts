/**
 * B站 凭据续期状态（N19a）。
 *
 * 只做**只读判断**：用官方 `cookie/info` 问一句"现在需要续期吗"，不动凭据。
 *
 * 为什么不做自动续期：真正的续期链路是
 *   `cookie/info` → `correspondPath`（用 B站 的公钥做 RSA-OAEP 加密 timestamp）→
 *   抓 `www.bilibili.com/correspond/1/<correspondPath>` 里的 `refresh_csrf` →
 *   `POST cookie/refresh` → `POST cookie/confirm` 收尾。
 * 其中公钥与 `correspondPath` 的生成细节拿不到可信来源，**猜一个公钥写进去等于埋雷**；
 * 而且续期一旦只做了一半（refresh 成功、confirm 没做），旧 cookie 会失效——
 * 那就是"帮用户续期"变成"把用户踢下线"。所以在验证清楚之前，这里只报告状态，
 * 真需要续期时让用户重新扫码（现在 10 秒就能扫完）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VdlError } from './core/errors';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const INFO = 'https://passport.bilibili.com/x/passport-login/web/cookie/info';

export type RenewState = 'ok' | 'no_credential' | 'need_login' | 'error';

export interface RenewStatus {
  site: 'bilibili';
  state: RenewState;
  /** 平台是否建议现在刷新（`cookie/info` 的 `refresh` 字段）。 */
  needsRenew: boolean;
  /** 本地是否记着 `refresh_token`——没有就只能重新扫码。 */
  canAutoRenew: boolean;
  message: string;
}

export interface RenewDeps {
  authDir?: string;
  fetch?: typeof fetch;
}

function authDirOf(deps: RenewDeps): string {
  if (deps.authDir) return deps.authDir;
  if (process.env.VDL_AUTH_DIR) return process.env.VDL_AUTH_DIR;
  return join(process.env.LOCALAPPDATA || '', 'vdl', 'auth');
}

interface Cookie { name: string; value: string; domain?: string; expires?: number }

/** 与 `auth.ts` 的 cookieHeader 同一口径：只带 bilibili 域、未过期的。 */
function jarOf(cookies: Cookie[]): Map<string, string> {
  const now = Date.now() / 1000;
  const map = new Map<string, string>();
  for (const c of cookies) {
    if (!String(c.domain || '').includes('bilibili.com')) continue;
    if (c.expires && c.expires > 0 && c.expires < now) continue;
    map.set(c.name, c.value);
  }
  return map;
}

export async function renewStatus(deps: RenewDeps = {}): Promise<RenewStatus> {
  const file = join(authDirOf(deps), 'bilibili.json');
  if (!existsSync(file)) {
    return {
      site: 'bilibili', state: 'no_credential', needsRenew: false, canAutoRenew: false,
      message: '本地没有 B站 凭据',
    };
  }

  let state: { cookies?: Cookie[]; meta?: { refreshToken?: string } };
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return {
      site: 'bilibili', state: 'error', needsRenew: false, canAutoRenew: false,
      message: `凭据文件读不出来：${(err as Error).message}`,
    };
  }

  const jar = jarOf(state.cookies || []);
  const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
  const csrf = jar.get('bili_jct') || '';
  const canAutoRenew = Boolean(state.meta?.refreshToken);
  if (!cookie || !csrf) {
    return {
      site: 'bilibili', state: 'need_login', needsRenew: false, canAutoRenew,
      message: '凭据不完整（缺 SESSDATA 或 bili_jct），需要重新扫码登录',
    };
  }

  const doFetch = deps.fetch || fetch;
  let body: any;
  try {
    const res = await doFetch(`${INFO}?csrf=${encodeURIComponent(csrf)}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: cookie },
      signal: AbortSignal.timeout(8000),
    });
    body = await res.json().catch(() => null);
  } catch (err) {
    return {
      site: 'bilibili', state: 'error', needsRenew: false, canAutoRenew,
      message: `查询续期状态失败：${(err as Error).message}`,
    };
  }

  const code = Number(body?.code);
  if (code === -101) {
    return {
      site: 'bilibili', state: 'need_login', needsRenew: false, canAutoRenew,
      message: '平台说未登录，凭据已失效，需要重新扫码',
    };
  }
  if (code !== 0) {
    return {
      site: 'bilibili', state: 'error', needsRenew: false, canAutoRenew,
      message: `平台返回 code=${code}${body?.message ? `：${body.message}` : ''}`,
    };
  }

  const needsRenew = Boolean(body?.data?.refresh);
  const tail = canAutoRenew
    ? '（本地已记录 refresh_token，但自动续期尚未验证，需要时请重新扫码）'
    : '（这次登录在续期功能之前，未记录 refresh_token；重新扫码后会记录）';
  return {
    site: 'bilibili',
    state: 'ok',
    needsRenew,
    canAutoRenew,
    message: needsRenew ? `平台建议刷新凭据${tail}` : `凭据有效，暂时不需要续期${tail}`,
  };
}

/** 供 CLI / 路由统一转错误体用。 */
export function renewError(status: RenewStatus): VdlError | null {
  if (status.state === 'need_login') {
    return new VdlError('need_login', status.message, '设置 → 账号 → B站 → 登录（扫码即可）');
  }
  return null;
}
