/**
 * 「码 → 人话」的集中表（`core/hints.ts`）。
 *
 * 这里锁两件事：
 * 1. 确实搞得清的码要说人话（401/403/416/429/5xx；QQ 104003；B站 87007）；
 * 2. 搞不清的一律返回空串——**不猜**。空串会让调用方保留自己的 next_action，
 *    而不是被一句编出来的解释覆盖。
 */
import { describe, expect, test } from 'bun:test';

import { httpHint, platformCodeHint, withHint } from '../src/core/hints';

describe('HTTP 状态码解释', () => {
  test('常见的要说出下一步', () => {
    expect(httpHint(401)).toContain('登录');
    expect(httpHint(403)).toContain('拒绝');
    expect(httpHint(404)).toContain('不存在');
    expect(httpHint(416)).toContain('续传');
    expect(httpHint(429)).toContain('限流');
    expect(httpHint(500)).toContain('稍后重试');
    expect(httpHint(503)).toContain('稍后重试');
  });

  test('正常状态与非法输入返回空串（不硬解释）', () => {
    for (const code of [200, 206, 302, 0, -1, Number.NaN]) {
      expect(httpHint(code)).toBe('');
    }
  });

  test('没收录的状态码不编，但当它是 5xx 时仍给「稍后重试」', () => {
    expect(httpHint(418)).toBe('');
    expect(httpHint(599)).toContain('稍后重试');
  });
});

describe('平台业务码解释', () => {
  test('QQ 104003 指向账号权益，而不是 cookie', () => {
    const text = platformCodeHint('qq', 104003);
    expect(text).toContain('权益');
    expect(text).toContain('绿钻');
    // 明确写清「不是 cookie 没带上」，避免又被误解成鉴权问题
    expect(text).not.toContain('cookie');
  });

  test('字符串形式的码也认（接口给的多半是数字字符串）', () => {
    expect(platformCodeHint('qq', '104003')).toBe(platformCodeHint('qq', 104003));
  });

  test('B站 需要大会员的码有解释', () => {
    expect(platformCodeHint('bilibili', 87007)).toContain('大会员');
    expect(platformCodeHint('bilibili', -403)).toContain('权限');
  });

  test('未收录的平台/码返回空串，不猜', () => {
    expect(platformCodeHint('kugou', 104003)).toBe('');
    expect(platformCodeHint('qq', 999999)).toBe('');
    expect(platformCodeHint('', '1')).toBe('');
  });
});

describe('withHint', () => {
  test('有解释才加括号，没有就原样', () => {
    expect(withHint('权限不足')).toBe('（权限不足）');
    expect(withHint('')).toBe('');
  });
});
