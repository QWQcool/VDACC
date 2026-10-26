import { describe, expect, test } from 'bun:test';

import { isSameActiveJob } from '../src/core/jobmatch';

const job = (status: string, url = 'u', formatId = 'f') => ({ url, formatId, status });

describe('任务去重判定', () => {
  test('排队中或下载中的同链接同档位算重复', () => {
    expect(isSameActiveJob(job('queued'), 'u', 'f')).toBe(true);
    expect(isSameActiveJob(job('running'), 'u', 'f')).toBe(true);
  });

  test('已结束的任务不算重复，允许重新下载', () => {
    for (const status of ['done', 'failed', 'cancelled']) {
      expect(isSameActiveJob(job(status), 'u', 'f')).toBe(false);
    }
  });

  test('链接或档位不同都不算重复', () => {
    expect(isSameActiveJob(job('running', 'u2'), 'u', 'f')).toBe(false);
    expect(isSameActiveJob(job('running', 'u', 'f2'), 'u', 'f')).toBe(false);
  });

  test('空档位与缺省一致（单曲/推荐档）', () => {
    expect(isSameActiveJob({ url: 'u', status: 'running' }, 'u', '')).toBe(true);
    expect(isSameActiveJob({ url: 'u', status: 'running' }, 'u', 'bili-1920')).toBe(false);
  });
});
