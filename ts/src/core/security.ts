import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { VdlError } from './errors';

/** 来源必须是完整 origin；前缀匹配会把 localhost.evil 等外站当成本机。 */
export function originAllowed(req: Request, allowedOrigin = ''): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    return origin === new URL(req.url).origin || (!!allowedOrigin && origin === allowedOrigin);
  } catch { return false; }
}

/** 返回真实文件路径，既阻止相邻前缀目录，也阻止 symlink / junction 逃出根目录。 */
export function jailedPath(root: string, candidate: string, fileOnly = true): string | null {
  try {
    const base = realpathSync(resolve(root));
    const target = realpathSync(resolve(candidate));
    const rel = relative(base, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    if (fileOnly && !statSync(target).isFile()) return null;
    return target;
  } catch { return null; }
}

/** 只接受媒体 CDN；不接受用户信息、非默认端口或把白名单当成前缀的域名。 */
export function streamUrlAllowed(input: string): boolean {
  try {
    const url = new URL(input);
    const match = (suffix: string) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`);
    const qq = ['qqmusic.qq.com', 'tc.qq.com'].some(match);
    const known = qq || ['douyin.com', 'douyinvod.com', 'byteicdn.com',
      'bilivideo.com', 'bilivideo.cn', '126.net', '127.net'].some(match);
    return known && !url.username && !url.password && !url.port &&
      (url.protocol === 'https:' || (qq && url.protocol === 'http:'));
  } catch { return false; }
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** fetch 自动跳转会绕过初始白名单，所以每一跳都先检查并释放旧响应。 */
export async function fetchMediaStream(input: string, init: RequestInit = {}, fetcher: Fetcher = fetch) {
  let target = input;
  const seen = new Set<string>();
  for (let hop = 0; hop <= 5; hop += 1) {
    if (!streamUrlAllowed(target)) throw new VdlError('forbidden', '不允许的流地址或重定向');
    if (seen.has(target)) throw new VdlError('redirect_loop', '媒体地址发生循环重定向');
    seen.add(target);
    const response = await fetcher(target, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new VdlError('bad_redirect', '媒体重定向缺少地址');
    try { target = new URL(location, target).href; }
    catch { throw new VdlError('bad_redirect', '媒体重定向地址无效'); }
  }
  throw new VdlError('redirect_limit', '媒体地址重定向次数过多');
}
