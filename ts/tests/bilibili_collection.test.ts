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

  test('「系列」链接不认（系列与合集是两套 id，硬查可能返回另一个合集）', () => {
    expect(parseCollectionTarget('https://space.bilibili.com/123/channel/seriesdetail?sid=42')).toBeNull();
    // 纯数字 + season 提示仍按合集（显式指定时由用户承担语义）
    expect(parseCollectionTarget('42', 'season')).toEqual({ kind: 'season', id: '42' });
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

  test('合集：接口忽略 pn/ps，本地切片保证「每批 20 + 加载下一页」', async () => {
    // 真实形状（2026-11-17 实测 season_id=4137556「甜点小剧场」共 163 条）：
    // data = { info: {title, media_count, upper}, medias: [...163] }，**没有 has_more**
    const all = Array.from({ length: 163 }, (_, i) => ({
      bvid: `BV${String(i + 1).padStart(6, '0')}`,
      title: `第 ${i + 1} 个`,
      cover: `http://i0/${i + 1}.jpg`,
      duration: 60,
      upper: { name: '破米库' },
    }));
    let seen = '';
    const deps = {
      cookie: '',
      pageSize: 20,
      fetch: (async (url: string) => {
        seen = String(url);
        // 无论 pn 是多少，服务端都回全量——这就是要本地切片的原因
        return json({
          code: 0,
          data: { info: { season_type: 1, title: '甜点小剧场', media_count: 163, upper: { name: '破米库' } }, medias: all },
        });
      }) as unknown as typeof fetch,
    };

    const first = await fetchCollection({ kind: 'season', id: '4137556' }, 1, deps);
    expect(seen).toContain('season_id=4137556');
    expect(first.kind).toBe('season');
    expect(first.title).toBe('甜点小剧场');
    expect(first.owner).toBe('破米库');
    expect(first.total).toBe(163);
    expect(first.items.length).toBe(20);
    expect(first.items[0].title).toBe('第 1 个');
    expect(first.hasMore).toBe(true);

    const ninth = await fetchCollection({ kind: 'season', id: '4137556' }, 9, deps);
    expect(ninth.items.length).toBe(3);
    expect(ninth.items[0].title).toBe('第 161 个');
    expect(ninth.hasMore).toBe(false);

    // 翻过末页：空页，不报形状错误
    const tenth = await fetchCollection({ kind: 'season', id: '4137556' }, 10, deps);
    expect(tenth.items).toEqual([]);
    expect(tenth.hasMore).toBe(false);
    expect(tenth.total).toBe(163);
  });

  test('合集条目少于一批时不切片，hasMore 为 false', async () => {
    const page = await fetchCollection({ kind: 'season', id: '42' }, 1, {
      cookie: '',
      pageSize: 20,
      fetch: (async () => json({
        code: 0,
        data: { info: { title: '小合集', media_count: 2 }, medias: [{ bvid: 'BV1aa' }, { bvid: 'BV1bb' }] },
      })) as unknown as typeof fetch,
    });
    expect(page.items.map((x) => x.bvid)).toEqual(['BV1aa', 'BV1bb']);
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(2);
  });

  test('data 为 null（不存在的收藏夹）不能被当成空列表', async () => {
    await expect(fetchCollection(target, 1, {
      cookie: '',
      fetch: (async () => json({ code: 0, message: 'OK', data: null })) as unknown as typeof fetch,
    })).rejects.toThrow(/没认出收藏夹的返回结构/);
  });

  test('翻过末页（medias: null + has_more: false）返回空页，不冒充形状错误', async () => {
    // 实测 2026-11-11，media_id=3473916881 共 6 条：pn=2 回 data 对象 + medias:null + has_more:false
    const page = await fetchCollection(target, 2, {
      cookie: '',
      fetch: (async () => json({
        code: 0,
        data: { info: { title: '我的收藏', media_count: 6 }, medias: null, has_more: false },
      })) as unknown as typeof fetch,
    });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(6);
    expect(page.title).toBe('我的收藏');
    expect(page.page).toBe(2);
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
