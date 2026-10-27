import type { ErrorBody } from './types';

export class VdlError extends Error {
  constructor(public code: string, message: string, public nextAction = '') {
    super(message);
    this.name = 'VdlError';
  }

  toBody(): ErrorBody {
    return { code: this.code, message: this.message, next_action: this.nextAction };
  }
}

export function fail(platform: string, engine: string, err: unknown, nextAction = '') {
  if (err instanceof VdlError) {
    return {
      schema: 2, ok: false, platform, engine, media: null, formats: [],
      warnings: [], error: err.toBody(),
    };
  }
  const message = err instanceof Error ? err.message : String(err);

  // fetch 在断网 / DNS 失败 / 超时下抛的是 TypeError（`fetch failed`）或 AbortError，
  // 不是 VdlError。这类失败若记成 `internal`，用户看到「内部错误」会往程序 bug 方向查，
  // 实际只是网络问题；网易云引擎早就有 `network` 码，这里把其余引擎对齐。
  if (isNetworkFailure(err)) {
    return {
      schema: 2, ok: false, platform, engine, media: null, formats: [],
      warnings: [],
      error: {
        code: 'network',
        message: `网络请求失败：${message}`,
        next_action: nextAction || '检查网络连接或稍后重试；平台限流/风控也会表现为失败',
      },
    };
  }

  return {
    schema: 2, ok: false, platform, engine, media: null, formats: [],
    warnings: [],
    error: { code: 'internal', message, next_action: nextAction || '看一下原始报错' },
  };
}

/** 只认「确实是网络层失败」的形态，避免把普通 TypeError（代码 bug）也说成网络问题。 */
function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const text = [err.message, cause?.message, cause?.code].filter(Boolean).join(' ');
  return /fetch failed|failed to fetch|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network is unreachable|networkerror/i.test(text);
}
