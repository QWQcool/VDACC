import { describe, expect, test } from 'bun:test';

import { LIST_MAX, collectPages } from '../src/core/paging';

const mk = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `s${from + i}` }));
const keyOf = (raw: any) => String(raw?.id || '');

describe('通用分页器', () => {
  test('声明总数小于一页：只请求一次', async () => {
    const calls: number[] = [];
    const out = await collectPages({
      pageSize: 100,
      keyOf,
      fetchPage: async (cursor) => { calls.push(cursor); return { raws: mk(3), total: 3 }; },
    });
    expect(out.raws.length).toBe(3);
    expect(out.declared).toBe(3);
    expect(out.warnings).toEqual([]);
    expect(calls).toEqual([0]);
  });

  test('按声明总数收敛：总数 5、每页 3 时取两页就停', async () => {
    const calls: number[] = [];
    const out = await collectPages({
      pageSize: 3,
      keyOf,
      fetchPage: async (cursor) => {
        calls.push(cursor);
        return cursor === 0 ? { raws: mk(3), total: 5 } : { raws: mk(2, 3), total: 5 };
      },
    });
    expect(out.raws.length).toBe(5);
    expect(calls).toEqual([0, 3]);
    expect(out.warnings).toEqual([]);
  });

  test('总数缺失时按「本页不满」停，不额外请求空页', async () => {
    const calls: number[] = [];
    const out = await collectPages({
      pageSize: 2,
      keyOf,
      fetchPage: async (cursor) => {
        calls.push(cursor);
        return cursor === 0 ? { raws: mk(2) } : { raws: mk(1, 2) };
      },
    });
    expect(out.raws.length).toBe(3);
    expect(calls).toEqual([0, 2]);
    expect(out.declared).toBe(0);
  });

  test('翻页重叠按 key 去重，重复数如实统计', async () => {
    const out = await collectPages({
      pageSize: 3,
      keyOf,
      fetchPage: async (cursor) => (cursor === 0
        ? { raws: mk(3), total: 4 }
        // 第一页的第 3 条又出现一次
        : { raws: [{ id: 's2' }, { id: 's3' }], total: 4 }),
    });
    expect(out.raws.map((r: any) => r.id)).toEqual(['s0', 's1', 's2', 's3']);
    expect(out.deduped).toBe(1);
    expect(out.warnings).toEqual([]);
  });

  test('超过上限时真截断到 max，只留一条说明', async () => {
    const out = await collectPages({
      pageSize: 100,
      max: 250,
      keyOf,
      fetchPage: async (cursor) => ({ raws: mk(100, cursor), total: 1000 }),
    });
    expect(out.raws.length).toBe(250);
    expect(out.raws.at(-1)).toEqual({ id: 's249' });
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toContain('单次最多列 250 首');
    expect(out.warnings[0]).toContain('接口声明 1000 首');
  });

  test('空首页：不抛错、不产生假 warning', async () => {
    const out = await collectPages({ pageSize: 20, keyOf, fetchPage: async () => ({ raws: [], total: 0 }) });
    expect(out.raws).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  test('没有唯一键的条目被跳过', async () => {
    const out = await collectPages({
      pageSize: 5,
      keyOf,
      fetchPage: async () => ({ raws: [{ id: 'a' }, { id: '' }, {}, { id: 'b' }], total: 2 }),
    });
    expect(out.raws.map((r: any) => r.id)).toEqual(['a', 'b']);
  });

  test('默认上限就是 LIST_MAX', () => {
    expect(LIST_MAX).toBe(5000);
  });
});
