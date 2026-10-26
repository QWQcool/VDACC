import { describe, expect, test } from 'bun:test';

import { isBlockedResponse } from '../src/engines/douyin';

describe('抖音风控响应识别', () => {
  test('HTTP 403 一律算拦截', () => {
    expect(isBlockedResponse(403, '')).toBe(true);
    expect(isBlockedResponse(403, 'anything')).toBe(true);
  });

  test('200 但 body 为空算拦截', () => {
    // 2026-10-26 实测：Argus 会回 200 + 空 body，旧代码直接落到 bad_json
    expect(isBlockedResponse(200, '')).toBe(true);
    expect(isBlockedResponse(200, '   \n\t ')).toBe(true);
  });

  test('body 里出现 Argus / Uifid Not Found 算拦截', () => {
    expect(isBlockedResponse(200, 'Blocked by ArgusSecurityPlugin Uifid Not Found')).toBe(true);
    expect(isBlockedResponse(400, '{"msg":"Uifid Not Found"}')).toBe(true);
  });

  test('正常 JSON 不算拦截', () => {
    const ok = JSON.stringify({ aweme_detail: { aweme_id: '1', video: {} } });
    expect(isBlockedResponse(200, ok)).toBe(false);
  });

  test('其它 HTTP 错误不算拦截，交给上层按状态码报错', () => {
    expect(isBlockedResponse(500, '<html>internal error</html>')).toBe(false);
    expect(isBlockedResponse(404, 'not found')).toBe(false);
  });
});
