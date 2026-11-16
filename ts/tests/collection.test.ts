/**
 * 列表入口共用件（core/collection.ts）的行为测试。
 *
 * 这三块原先在 netease / qq / kugou 各写一份，口径已经开始分叉
 * （酷狗那段抄了「登录后重试」，而酷狗根本没有登录态）。抽出来之后
 * 这里锁住「分开的两种情况别混」：**空列表** 与 **拿到了 ID 但详情全空**
 * 是两种故障，文案与码都不能一样。
 */
import { describe, expect, test } from 'bun:test';

import { bareNumericId, detailsByIds, emptyCollection } from '../src/core/collection';

function catchError(fn: () => never): any {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('应当抛错');
}

describe('bareNumericId', () => {
  test('纯数字（含首尾空白）原样返回', () => {
    expect(bareNumericId('3778678')).toBe('3778678');
    expect(bareNumericId('  42 ')).toBe('42');
  });

  test('URL / 带字母 / 空串一律返回空串，不能瞎认', () => {
    expect(bareNumericId('https://music.163.com/playlist?id=1')).toBe('');
    expect(bareNumericId('BV1xx411c7mD')).toBe('');
    expect(bareNumericId('12a')).toBe('');
    expect(bareNumericId('')).toBe('');
    expect(bareNumericId(undefined as unknown as string)).toBe('');
  });
});

describe('emptyCollection', () => {
  test('没声明总数 → 说「没有可下载的曲目」，让用户确认歌单不是空的', () => {
    const err = catchError(() => emptyCollection({ id: '99' }));
    expect(err.code).toBe('not_found');
    expect(err.message).toContain('没有可下载的曲目');
    expect(err.message).toContain('id=99');
    expect(err.nextAction).toContain('确认这个歌单不是空的');
  });

  test('声明了总数却没给条目 → 必须说清是平台侧拿不到，并给登录下一步', () => {
    const err = catchError(() => emptyCollection({ id: '99', declared: 66 }));
    expect(err.code).toBe('not_found');
    expect(err.nextAction).toContain('接口声明 66 首');
    expect(err.nextAction).toContain('登录后重试');
  });

  test('平台可以覆盖提示（酷狗没有登录态，不能抄「登录后重试」）', () => {
    const err = catchError(() => emptyCollection({
      id: '7', declared: 51, blockedHint: '接口声明 51 首但没有给出曲目：可能整单下架或地区限制',
    }));
    expect(err.nextAction).not.toContain('登录');
    expect(err.nextAction).toContain('整单下架');
  });

  test('详情段全空与列表为空是两种故障', () => {
    const err = catchError(() => emptyCollection({ id: '1', declared: 5, detailPhase: true }));
    expect(err.message).toContain('都拿不到详情');
    expect(err.message).not.toContain('没有可下载的曲目');
  });

  test('label 能换（专辑 / 收藏夹）', () => {
    const err = catchError(() => emptyCollection({ id: '1', label: '专辑' }));
    expect(err.message).toContain('专辑里没有可下载的曲目');
  });
});

describe('detailsByIds', () => {
  const songs = [
    { id: 33, name: 'C' },
    { id: 11, name: 'A' },
    { id: 55, name: 'E' },
  ];

  test('按 ids 顺序还原，不依赖接口返回顺序', async () => {
    const out = await detailsByIds({
      ids: ['11', '33', '55'],
      batchSize: 10,
      fetchBatch: async () => songs,
      keyOf: (s) => String(s.id),
    });
    expect(out.ordered.map((s) => s.name)).toEqual(['A', 'C', 'E']);
    expect(out.missing).toBe(0);
    expect(out.warnings).toEqual([]);
  });

  test('分批：每批一次调用，批次内短少与整体缺失都要报数', async () => {
    const calls: string[][] = [];
    const out = await detailsByIds({
      ids: ['11', '22', '33', '44', '55'],
      batchSize: 2,
      fetchBatch: async (batch) => {
        calls.push(batch);
        // 第二批（33/44）故意只回一条：模拟同批里有下架曲目
        return batch.filter((id) => id !== '44').map((id) => ({ id, name: `S${id}` }));
      },
      keyOf: (s) => String(s.id),
    });
    expect(calls).toEqual([['11', '22'], ['33', '44'], ['55']]);
    expect(out.ordered.map((s) => String(s.id))).toEqual(['11', '22', '33', '55']);
    expect(out.missing).toBe(1);
    expect(out.warnings.join('\n')).toContain('第 3–4 首里只拿到 1 首详情');
    expect(out.warnings.join('\n')).toContain('1 首拿不到详情');
  });

  test('空 ids 不发请求', async () => {
    let called = 0;
    const out = await detailsByIds({
      ids: [],
      batchSize: 10,
      fetchBatch: async () => { called += 1; return []; },
      keyOf: (s: any) => String(s.id),
    });
    expect(called).toBe(0);
    expect(out).toEqual({ ordered: [], warnings: [], missing: 0 });
  });

  test('取详情失败（网络）不吞：整单都不可信，交给上层报错', async () => {
    await expect(detailsByIds({
      ids: ['1'],
      batchSize: 10,
      fetchBatch: async () => { throw new Error('fetch failed'); },
      keyOf: (s: any) => String(s.id),
    })).rejects.toThrow('fetch failed');
  });
});
