/**
 * 端上的 `fetch`：底层走桥的 `http.request`（Kotlin 侧 HttpURLConnection）。
 *
 * 为什么必须换掉原生 fetch：页面跑在 `file:///android_asset/` 下，是不透明来源，
 * `fetch('https://www.douyin.com/...')` 会被 CORS 直接拒（对方不会给我们
 * `Access-Control-Allow-Origin`）。把 fetch 换成桥调用之后，引擎里所有
 * `core/http.request()` 和直接写 `fetch(...)` 的地方都自动走原生，**引擎源码一行不用改**。
 *
 * 为什么返回真正的 `Response` 而不是假对象：引擎会用 `res.text()` / `res.json()` /
 * `res.headers.get()` / `res.body`（异步迭代拿分块）。手搓一个只有三个方法的假对象，
 * 迟早漏掉某个成员并在真机上炸；构造原生 Response 只多几行 base64 解码。
 *
 * 边界：这是「一次往返拿完整响应体」的接口，上限 24MB（原生侧拦）。
 * 视频/音频必须走 `transfer.*` 流式写盘，不要走这里。
 */
import { call } from './bridge';
import { bytesToBase64 } from './crypto';

type HttpReply = {
  status: number;
  url: string;
  headers: Record<string, string>;
  setCookie: string[];
  bodyBase64: string;
  bytes: number;
};

/** 只声明用到的成员，避免 shim 依赖 lib.dom 的具体类型。 */
type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: { aborted: boolean; addEventListener?: (type: string, fn: () => void) => void };
};

const DEFAULT_TIMEOUT_MS = 20_000;

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text || '');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const anyRaw = raw as { forEach?: (fn: (value: string, key: string) => void) => void };
  if (typeof anyRaw.forEach === 'function') {
    anyRaw.forEach((value, key) => { out[key] = String(value); });
    return out;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

function toResponse(reply: HttpReply, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(reply.headers || {})) {
    // 原生侧把同名头用 \n 合并了，这里按行拆开逐条 append，保留多值语义
    for (const one of String(value).split('\n')) {
      if (one) headers.append(name, one);
    }
  }

  const bodyless = method === 'HEAD' || reply.status === 204 || reply.status === 304;
  const bytes = reply.bodyBase64 ? base64ToBytes(reply.bodyBase64) : new Uint8Array(0);
  const response = new Response(bodyless ? null : bytes, { status: reply.status, headers });

  // CookieJar.absorb 优先调 getSetCookie()：多条 Set-Cookie 合成一条会丢 cookie
  Object.defineProperty(response.headers, 'getSetCookie', {
    value: () => (reply.setCookie || []).slice(),
  });
  return response;
}

/** 换掉全局 fetch。桥不存在（例如在 Bun 里跑 selftest）时什么都不做，返回 false。 */
export function installBridgeFetch(): boolean {
  const holder = globalThis as unknown as {
    VDACC_BRIDGE?: { post?: unknown };
    fetch?: unknown;
    __VDACC_FETCH_BRIDGE__?: boolean;
  };
  if (!holder.VDACC_BRIDGE || typeof holder.VDACC_BRIDGE.post !== 'function') return false;
  if (holder.__VDACC_FETCH_BRIDGE__) return true;
  holder.fetch = bridgeFetch as unknown as typeof fetch;
  holder.__VDACC_FETCH_BRIDGE__ = true;
  return true;
}

export function bridgeFetchInstalled(): boolean {
  return !!(globalThis as unknown as { __VDACC_FETCH_BRIDGE__?: boolean }).__VDACC_FETCH_BRIDGE__;
}

/** 与浏览器 fetch 同签名的最小实现。 */
export async function bridgeFetch(input: unknown, init: FetchInit = {}): Promise<Response> {
  const url = typeof input === 'string'
    ? input
    : String((input as { url?: string } | null)?.url || '');
  if (!url) throw new TypeError('fetch: 缺少 url');

  const method = String(init.method || 'GET').toUpperCase();
  const headers = normalizeHeaders(init.headers);
  const bodyText = init.body === undefined || init.body === null ? '' : String(init.body);
  const bodyBase64 = bodyText
    ? bytesToBase64(new TextEncoder().encode(bodyText))
    : '';

  const signal = init.signal;
  if (signal?.aborted) throw abortError();

  const pending = call<HttpReply>('http.request', {
    url, method, headers, bodyBase64, timeoutMs: DEFAULT_TIMEOUT_MS,
  }, { timeoutMs: DEFAULT_TIMEOUT_MS + 5_000 });

  // 原生调用不可中断（M1-c 的 transfer 才支持取消），但至少让 JS 侧的 abort 语义成立：
  // 上层 20s 超时 abort 之后不该继续等桥。
  const reply = signal?.addEventListener
    ? await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        signal.addEventListener!('abort', () => reject(abortError()));
      }),
    ])
    : await pending;

  if (signal?.aborted) throw abortError();
  return toResponse(reply, method);
}
