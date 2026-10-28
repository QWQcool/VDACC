/**
 * 错误码归一：网络层失败不该被说成「内部错误」。
 *
 * 背景：各引擎直接用 `fetch`，断网/DNS 失败/超时抛的是 TypeError 或 AbortError；
 * 这些错误一路冒到 `fail()`，原来统一记成 `internal`。用户看到「内部错误」
 * 会往程序 bug 方向查，其实只是网络问题；网易云引擎早就有 `network` 码，这里对齐。
 */
import { describe, expect, test } from 'bun:test';

import { VdlError, fail } from '../src/core/errors';

describe('fail() 的错误分类', () => {
  test('fetch 失败（断网/DNS）→ network，并给出可执行下一步', () => {
    const body = fail('qq', 'qq-api', new TypeError('fetch failed'));
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('network');
    expect(body.error?.next_action).toContain('网络');
  });

  test('Bun 的 fetch 失败会带 cause.code（ECONNRESET 等）', () => {
    const err = new TypeError('fetch failed');
    (err as any).cause = { code: 'ECONNRESET', message: 'connection reset by peer' };
    expect(fail('qq', 'qq-api', err).error?.code).toBe('network');
  });

  test('超时（AbortError）也算网络失败，文案说明可能超时', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const body = fail('qq', 'qq-api', err);
    expect(body.error?.code).toBe('network');
    expect(body.error?.message).toContain('网络');
  });

  test('普通程序错误仍然是 internal（不能把 bug 说成网络问题）', () => {
    const body = fail('qq', 'qq-api', new Error("Cannot read properties of undefined"));
    expect(body.error?.code).toBe('internal');
  });

  test('VdlError 自带的码原样保留', () => {
    const body = fail('qq', 'qq-api', new VdlError('need_login', '没有匿名可用地址', '登录后再试'));
    expect(body.error?.code).toBe('need_login');
    expect(body.error?.next_action).toBe('登录后再试');
  });

  test('非 Error 值也能处理，不抛二次异常', () => {
    const body = fail('qq', 'qq-api', { weird: true });
    expect(body.error?.code).toBe('internal');
    expect(typeof body.error?.message).toBe('string');
  });
});
