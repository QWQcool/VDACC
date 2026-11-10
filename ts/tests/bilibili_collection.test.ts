import { describe, expect, test } from 'bun:test';

import { fetchCollection, parseCollectionTarget } from '../src/engines/bilibili_collection';

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

describe('收藏夹/合集链接解析', () => {
  test('favlist?fid= 认成收藏夹', () => {
    expect(parseCollectionTarget('https://space.bilibili.com/123/favlist?fid=456')).toEqual({ kind: 'fav', id: '456' });
  });

  test('media_id= 也认成收藏夹（接口原始参数名）', () => {
    expect(parseCollectionTarget('https://space.bilibili.com/123/favlist?media_id=789')).toEqual({ kind: 'fav', id: '789' });
  });

  test('collectiondetail?sid= 认成合集', () => {
    expect(parseCollectionTarget('https://space.bilibili.com/123/channel/collectiondetail?sid=42'))
      .toEqual({ kind: 'season', id: '42' });
  });

  test('纯数字默认收藏夹，带 season 提示则按合集', () => {
    expect(parseCollectionTarget('100')).toEqual({ kind: 'fav', id: '100' });
    expect(parseCollectionTarget('100', 'season')).toEqual({ kind: 'season', id: '100' });
  });

  test('认不出就返回 null，不瞎猜', () => {
    expect(parseCollectionTarget('https://www.bilibili.com/video/BV1xx')).toBeNull();
    expect(parseCollectionTarget('')).toBeNull();
    expect(parseCollectionTarget('not a url')).toBeNull();
  });
});

describe('收藏夹列表拉取', () => {
  const target = { kind: 'fav' as const, id: '456' };

  test('分页参数进 URL，条目映射正确，失效项保留', async () => {
    let seen = '';
    const deps = {
      cookie: '',
      pageSize: 20,
      fetch: (async (url: string) => {
        seen = String(url);
        return json({
          code: 0,
          data: {
            info: { id: 456, title: '我的收藏', media_count: 41, upper: { name: '收藏夹主人' } },
            medias: [
              { bvid: 'BV1aa', title: '第一个', cover: 'http://i0/x.jpg', duration: 125, attr: 0, upper: { name: 'UP1' } },
              { bvid: '', title: '已失效视频', attr: 9 },
            ],
            has_more: true,
          },
        });
      }) as unknown as typeof fetch,
    };

    const page = await fetchCollection(target, 3, deps);
    expect(seen).toContain('media_id=456');
    expect(seen).toContain('pn=3');
    expect(seen).toContain('ps=20');
    expect(seen).toContain('order=mtime');

    expect(page.title).toBe('我的收藏');
    expect(page.owner).toBe('收藏夹主人');
    expect(page.total).toBe(41);
    expect(page.page).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]).toEqual({
      bvid: 'BV1aa',
      title: '第一个',
      author: 'UP1',
      cover: 'http://i0/x.jpg',
      duration_ms: 125_000,
      url: 'https://www.bilibili.com/video/BV1aa',
      state: 'ok',
    });
    // 失效条目必须留下并标 gone：过滤掉会让用户以为收藏夹少了东西
    expect(page.items[1].state).toBe('gone');
    expect(page.items[1].url).toBe('');
  });

  test('合集走 season_id，并兼容 archives 字段名', async () => {
    let seen = '';
    const page = await fetchCollection({ kind: 'season', id: '42' }, 1, {
      cookie: '',
      fetch: (async (url: string) => {
        seen = String(url);
        return json({
          code: 0,
          data: {
            info: { title: '合集A', media_count: 1 },
            archives: [{ bvid: 'BV1bb', title: '合集里的', duration: 60 }],
            has_more: false,
          },
        });
      }) as unknown as typeof fetch,
    });
    expect(seen).toContain('season_id=42');
    expect(seen).toContain('pn=1');
    expect(page.kind).toBe('season');
    expect(page.items[0].bvid).toBe('BV1bb');
    expect(page.items[0].author).toBe('');
  });

  test('data 为 null（不存在的收藏夹）不能被当成空列表', async () => {
    await expect(fetchCollection(target, 1, {
      cookie: '',
      fetch: (async () => json({ code: 0, message: 'OK', data: null })) as unknown as typeof fetch,
    })).rejects.toThrow(/没认出收藏夹的返回结构/);
  });

  test('未登录时给 need_login，而不是空列表', async () => {
    await expect(fetchCollection(target, 1, {
      cookie: '',
      fetch: (async () => json({ code: -101, message: '账号未登录' })) as unknown as typeof fetch,
    })).rejects.toThrow(/需要登录/);
  });

  test('私密收藏夹报权限，而不是内部错误', async () => {
    await expect(fetchCollection(target, 1, {
      cookie: '',
      fetch: (async () => json({ code: -403, message: '访问权限不足' })) as unknown as typeof fetch,
    })).rejects.toThrow(/私密/);
  });

  test('结构里既没有 medias 也没有 archives 时报结构错误', async () => {
    await expect(fetchCollection(target, 1, {
      cookie: '',
      fetch: (async () => json({ code: 0, data: { info: { title: 'x' } } })) as unknown as typeof fetch,
    })).rejects.toThrow(/没认出收藏夹的返回结构/);
  });
});
