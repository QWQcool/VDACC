export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** fetch 不带 cookie 容器，这里自己维护一个最小实现。 */
export class CookieJar {
  private jar = new Map<string, string>();

  set(name: string, value: string) {
    this.jar.set(name, value);
  }

  get(name: string): string {
    return this.jar.get(name) || '';
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** 重试时换一套身份：清空后重新注册 ttwid / 重新取 uifid。 */
  clear() {
    this.jar.clear();
  }

  absorb(res: Response) {
    const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
    const list = anyHeaders.getSetCookie?.() ||
      (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
    for (const line of list) {
      const pair = line.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) this.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  jar?: CookieJar;
  timeoutMs?: number;
}

export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...(opts.headers || {}),
  };
  if (opts.jar) {
    const cookie = opts.jar.header();
    if (cookie) headers['Cookie'] = cookie;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (opts.jar) opts.jar.absorb(res);
    return res;
  } finally {
    clearTimeout(timer);
  }
}
