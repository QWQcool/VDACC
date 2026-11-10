/**
 * B站 扫码登录：三个 GET 就够，全程不启浏览器。
 *
 * 为什么不复用 `auth.ts` 的 Edge 方案：那条路要系统 Edge + `node` + `playwright-core`，
 * 还要抢 `%LOCALAPPDATA%\vdl\profile` 的单例锁，失败只留一行 console——用户说的"卡网页"
 * 就出在这条链上（Plan §2.7.1）。B站 官方扫码是公开 REST，扫码本身不需要任何浏览器环境。
 *
 * 接口事实（2026-11-10 实测，见 Plan §2.7.2）：
 *   GET x/passport-login/web/qrcode/generate        → { code:0, data:{ url, qrcode_key } }
 *   GET x/passport-login/web/qrcode/poll?qrcode_key → 外层 code 恒 0，**状态在内层 data.code**
 *       86101 未扫码 / 86090 已扫码待确认 / 86038 已过期 / 0 成功
 *   成功时 cookie 有两条来源：响应 `Set-Cookie`（主）与 `data.url` 的查询串（兜底）。
 *   两路都收，按 name 去重，Set-Cookie 优先——不赌其中一条一定全。
 */
import { existsSync, unlinkSync } from 'node:fs';
import { renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { VdlError } from './core/errors';
import { writeJsonAtomic } from './core/storage';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const API = 'https://passport.bilibili.com/x/passport-login/web/qrcode';
const NAV = 'https://api.bilibili.com/x/web-interface/nav';
const REFERER = 'https://www.bilibili.com/';

/**
 * 二维码有效期。B站 页面自己标 180 秒，但**本地计时只用于界面倒计时**：
 * 真正的过期信号是 poll 返回的 86038，别用本地时间宣布"过期"。
 */
const QR_TTL_SECONDS = 180;

export interface QrCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
}

export interface QrStart {
  key: string;
  url: string;
  qrDataUrl: string;
  expiresIn: number;
}

export type QrState = 'pending' | 'scanned' | 'expired' | 'ok' | 'unverified' | 'error';

export interface QrAccount {
  mid: string;
  uname: string;
  vipLabel: string;
}

export interface QrPollResult {
  state: QrState;
  message: string;
  /** 平台原始状态码：排障时必须有，不然只能看到我们翻译后的中文。 */
  rawCode?: number;
  account?: QrAccount;
  /** 凭据是否已落盘。`unverified` 时是 true——文件在，只是没验通。 */
  saved?: boolean;
}

/** 依赖注入点：测试里替换 fetch / 二维码渲染 / 数据目录，不真的联网也不写用户目录。 */
export interface QrDeps {
  fetch?: typeof fetch;
  authDir?: string;
  now?: () => number;
  qr?: (url: string) => Promise<string>;
}

function authDirOf(deps: QrDeps): string {
  if (deps.authDir) return deps.authDir;
  // VDL_AUTH_DIR 是给测试/冒烟用的隔离开关：默认仍然是用户目录，
  // 但对着它跑"退出登录"会把真人凭据删掉（本轮踩过），所以冒烟必须能指到别处。
  if (process.env.VDL_AUTH_DIR) return process.env.VDL_AUTH_DIR;
  return join(process.env.LOCALAPPDATA || '', 'vdl', 'auth');
}

/**
 * 扫码登录支持的站点。加站点时三处一起改：adapter、server 路由白名单、前端按钮。
 *
 * 只有 B站：网易云扫码 2026-11-10 实测被平台拒绝（连续 6 次 `801 等待扫码` 后直接跳
 * `8821 请切换其他登录方式或升级新版本再试`，全程没有出现 `802`），适配器已撤掉。
 * 想恢复请看 `docs/CHANGELOG.md` 里那条记录，别只把站点加回这个数组。
 */
export type QrSite = 'bilibili';
export const QR_SITES: QrSite[] = ['bilibili'];

function credentialFile(site: QrSite, deps: QrDeps): string {
  return join(authDirOf(deps), `${site}.json`);
}

function credentialTxt(site: QrSite, deps: QrDeps): string {
  return join(authDirOf(deps), `${site}.cookies.txt`);
}

/** Netscape 格式（给 yt-dlp 与 bilibili_api 的 cookieHeader() 用），与 Edge 流程同一份口径。 */
export function toNetscape(cookies: QrCookie[]): string {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.domain || '';
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
    const prefix = (c as QrCookie & { httpOnly?: boolean }).httpOnly ? '#HttpOnly_' : '';
    lines.push([prefix + domain, flag, c.path || '/',
      (c as QrCookie & { secure?: boolean }).secure ? 'TRUE' : 'FALSE',
      expires, c.name, c.value].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 两份都要写：`bilibili.json`（storage_state，`status()` 与 `verify()` 读它）和
 * `bilibili.cookies.txt`（`bilibili_api.cookieHeader()` **优先读它**）。
 * 只写 json 的话，旧的 txt 会把新 cookie 盖住——扫码成功但引擎仍用旧凭据，看起来就是"登录没用"。
 */
function saveCredentials(site: QrSite, deps: QrDeps, cookies: QrCookie[]) {
  const jsonFile = credentialFile(site, deps);
  writeJsonAtomic(jsonFile, { cookies, origins: [] });
  const txtFile = credentialTxt(site, deps);
  const tmp = `${txtFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, toNetscape(cookies), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, txtFile);
  } finally {
    try { unlinkSync(tmp); } catch { /* 已 rename 或未创建 */ }
  }
}

async function getJson(
  url: string,
  deps: QrDeps,
  cookie = '',
  method: 'GET' | 'POST' = 'GET',
  referer = REFERER,
): Promise<{ body: any; res: Response }> {
  const doFetch = deps.fetch || fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        Referer: referer,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    // 断网/DNS 与"接口改版"是两件事，别都报成内部错误
    throw new VdlError('network', `请求 B站 失败：${(err as Error).message}`,
      '检查网络后重试；公司网络/VPN 拦截也可能表现为失败');
  }
  if (!res.ok) {
    throw new VdlError('bilibili_qr_http', `B站 返回 HTTP ${res.status}`,
      '稍后重试；连续失败可能是接口风控或改版');
  }
  const body = await res.json().catch(() => null);
  return { body, res };
}

/** 默认二维码渲染：服务端出 PNG data URL，Web 直接 <img>，CLI 另有终端版（见 cli.ts）。 */
export async function renderQrPng(url: string): Promise<string> {
  return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
}

export async function generateBilibili(deps: QrDeps = {}): Promise<QrStart> {
  const { body } = await getJson(`${API}/generate`, deps);
  const url = body?.data?.url;
  const key = body?.data?.qrcode_key;
  if (typeof url !== 'string' || typeof key !== 'string' || !url || !key) {
    throw new VdlError('bilibili_qr_failed', '二维码接口没有返回 url / qrcode_key',
      '稍后重试；若持续失败，说明该接口已变更，需要更新实现');
  }
  const qr = deps.qr || renderQrPng;
  return { key, url, qrDataUrl: await qr(url), expiresIn: QR_TTL_SECONDS };
}

/** `Set-Cookie` 单条解析：只要 name/value 与过期时间，域和路径统一按 bilibili 处理。 */
export function parseSetCookie(raw: string, nowSeconds: number, domain = '.bilibili.com'): QrCookie | null {
  const parts = raw.split(';');
  const pair = parts[0] || '';
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;
  let expires = -1;
  for (const attr of parts.slice(1)) {
    const idx = attr.indexOf('=');
    if (idx <= 0) continue;
    const k = attr.slice(0, idx).trim().toLowerCase();
    const v = attr.slice(idx + 1).trim();
    if (k === 'max-age') {
      const n = Number(v);
      if (Number.isFinite(n)) expires = nowSeconds + n;
    } else if (k === 'expires') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) expires = Math.floor(t / 1000);
    }
  }
  return { name, value, domain, path: '/', expires };
}

/** 成功响应里的 crossDomain url 带着同样的 cookie，查询串里还有一个 `Expires`（unix 秒）。 */
export function cookiesFromUrl(link: string): QrCookie[] {
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return [];
  }
  const expires = Number(parsed.searchParams.get('Expires') || 0);
  // 这些是跳转参数，不是 cookie；照着参数名全收会把 gourl 当成 cookie 写进凭据文件
  const skip = new Set(['Expires', 'gourl', 'from', 'navhide', 'callback', 'qrcode_key']);
  const out: QrCookie[] = [];
  for (const [name, value] of parsed.searchParams) {
    if (skip.has(name) || !value) continue;
    out.push({ name, value, domain: '.bilibili.com', path: '/', expires: expires > 0 ? expires : -1 });
  }
  return out;
}

/** 按 name 合并，前者优先；空值丢弃（Set-Cookie 里可能有 `name=;` 的清除指令）。 */
export function mergeCookies(primary: QrCookie[], fallback: QrCookie[]): QrCookie[] {
  const seen = new Set<string>();
  const out: QrCookie[] = [];
  for (const list of [primary, fallback]) {
    for (const c of list) {
      if (!c.value || seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
    }
  }
  return out;
}

function headerList(res: Response): string[] {
  // Bun/undici 都提供 getSetCookie；旧实现退化成合并串（此时只能取到第一条，如实少收）。
  const anyRes = res as Response & { headers: Headers & { getSetCookie?: () => string[] } };
  const fn = anyRes.headers.getSetCookie;
  if (typeof fn === 'function') return fn.call(anyRes.headers);
  const merged = anyRes.headers.get('set-cookie');
  return merged ? [merged] : [];
}

export async function fetchAccount(cookie: string, deps: QrDeps = {}): Promise<QrAccount | null> {
  const { body } = await getJson(NAV, deps, cookie);
  const data = body?.data;
  if (!data?.isLogin) return null;
  // 实测（2026-11-10 真实账号）：nav 的 vip_label 有时是**对象**
  // `{ path, text, label_theme, text_color }`，直接 String() 会得到 "[object Object]"。
  const rawVip = data.vip_label;
  const vipLabel = typeof rawVip === 'string'
    ? rawVip
    : (rawVip && typeof rawVip === 'object' && typeof rawVip.text === 'string' ? rawVip.text : '');
  return {
    mid: String(data.mid ?? ''),
    uname: String(data.uname ?? ''),
    // 为空就是非会员，不要自己猜
    vipLabel,
  };
}

export async function pollBilibili(key: string, deps: QrDeps = {}): Promise<QrPollResult> {
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const { body, res } = await getJson(`${API}/poll?qrcode_key=${encodeURIComponent(key)}`, deps);
  const data = body?.data || {};
  const code = Number(data.code);

  if (code === 86101) return { state: 'pending', message: data.message || '未扫码', rawCode: code };
  if (code === 86090) return { state: 'scanned', message: data.message || '已扫码，请在手机上确认', rawCode: code };
  if (code === 86038) return { state: 'expired', message: data.message || '二维码已过期', rawCode: code };
  if (code !== 0) {
    // 带上原始码：将来接口加状态时，用户截图的报错要能直接定位是哪一档
    const detail = data.message ? `：${data.message}` : '';
    return { state: 'error', message: `未识别的扫码状态码 ${code}${detail}`, rawCode: code };
  }

  const fromHeader = headerList(res)
    .map((raw) => parseSetCookie(raw, now))
    .filter((c): c is QrCookie => !!c);
  const cookies = mergeCookies(fromHeader, cookiesFromUrl(String(data.url || '')));
  if (!cookies.length) {
    return { state: 'error', message: '扫码通过但没拿到任何 cookie（响应头与跳转 url 都为空）' };
  }

  // 落盘沿用 Playwright storage_state 形状：`auth.ts` 的 cookieHeader() 与引擎的 cookie
  // 过滤都按 state.cookies 读，改形状会连带改三处，没必要。
  const file = credentialFile('bilibili', deps);
  saveCredentials('bilibili', deps, cookies);

  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  let account: QrAccount | null = null;
  let verifyError = '';
  try {
    account = await fetchAccount(cookie, deps);
  } catch (err) {
    verifyError = (err as Error).message;
  }

  if (account) {
    return { state: 'ok', message: `已登录：${account.uname}`, account, saved: true };
  }
  if (verifyError) {
    return {
      state: 'unverified',
      message: `凭据已保存，但在线校验失败：${verifyError}`,
      saved: true,
    };
  }
  // nav 明确说未登录：文件留着会让人以为登录成功，删掉并如实报错
  try { unlinkSync(file); } catch { /* 文件可能已被并发清理 */ }
  return {
    state: 'error',
    message: '扫码通过但 nav 校验显示未登录，已丢弃这次凭据（cookie 可能不完整）',
    saved: false,
  };
}

/** 退出登录：只删该站点的凭据（json 与 txt 两份），不动其它站点与 profile 目录。 */
export function logoutSite(site: QrSite, deps: QrDeps = {}): boolean {
  const file = credentialFile(site, deps);
  const txt = credentialTxt(site, deps);
  const hadJson = existsSync(file);
  const hadTxt = existsSync(txt);
  try {
    if (hadJson) unlinkSync(file);
    if (hadTxt) unlinkSync(txt);
    return hadJson || hadTxt;
  } catch (err) {
    throw new VdlError('storage_write_failed', `删除凭据失败：${(err as Error).message}`,
      '检查文件是否被其它程序占用后重试');
  }
}

// ── 分发 ───────────────────────────────────────────────────────────
// 2026-11-10：网易云扫码被平台拒（见 QR_SITES 上方注释），适配器已删除，只留 B站。
// 这里保留 site 参数，是为了将来加站点时 server / CLI / 前端不用再改签名。
function unsupported(site: string): never {
  throw new VdlError('unsupported', `扫码登录暂不支持 ${site}`,
    'B站 可用扫码；其它站点请用电脑上的 Edge 登录');
}

export function qrGenerate(site: QrSite, deps: QrDeps = {}): Promise<QrStart> {
  if (site !== 'bilibili') return Promise.reject(unsupported(site));
  return generateBilibili(deps);
}

export function qrPoll(site: QrSite, key: string, deps: QrDeps = {}): Promise<QrPollResult> {
  if (site !== 'bilibili') return Promise.reject(unsupported(site));
  return pollBilibili(key, deps);
}