import { describe, expect, test } from 'bun:test';

import { authErrorOf, clearAuthError, noteAuthError } from '../src/auth';

describe('上次失败原因（N19c）', () => {
  test('记录了就能读回来，且带时间戳与错误码', () => {
    noteAuthError('bilibili', 'qr_8821', '请切换其他登录方式');
    const got = authErrorOf('bilibili');
    expect(got?.code).toBe('qr_8821');
    expect(got?.message).toContain('切换其他登录方式');
    expect(typeof got?.at).toBe('number');
    clearAuthError('bilibili');
  });

  test('清除后读不到——成功登录必须把旧失败抹掉', () => {
    noteAuthError('netease', 'login_failed', '连接超时');
    expect(authErrorOf('netease')?.code).toBe('login_failed');
    clearAuthError('netease');
    expect(authErrorOf('netease')).toBeNull();
  });

  test('没有失败记录时返回 null，不是空对象', () => {
    expect(authErrorOf('qq')).toBeNull();
  });

  test('超长错误信息会截断，避免把整段 HTML 塞进接口', () => {
    noteAuthError('bilibili', 'login_failed', 'x'.repeat(1000));
    expect(authErrorOf('bilibili')?.message.length).toBe(300);
    clearAuthError('bilibili');
  });
});
