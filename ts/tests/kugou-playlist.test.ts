import { describe, expect, test } from 'bun:test';

import { parsePlaylistId, playlistTracks } from '../src/engines/kugou';

const hashOf = (n: number) => String(n).padStart(32, '0');

const meta = (over: Record<string, unknown> = {}) => ({
  data: {
    specialname: '震惊！这些歌居然被翻唱这么多次',
    nickname: '傻傻抵',
    songcount: 3,
    imgurl: 'http://imge.kugou.com/soft/collection/{size}/20170417/cover.jpg',
    ...over,
  },
});

const songPage = (items: any[], total: number) => ({ data: { total, info: items } });

function makeFetch(routes: Array<{ match: (url: string) => boolean; body: any }>) {
  const calls: string[] = [];
  const fn = async (input: any) => {
    const url = String(input);
    calls.push(url);
    const hit = routes.find((r) => r.match(url));
    if (!hit) throw new Error(`未预期的请求: ${url}`);
    return new Response(JSON.stringify(hit.body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('酷狗歌单链接解析', () => {
  test('网页歌单页 / 手机列表页 / 查询参数 / 裸数字', () => {
    expect(parsePlaylistId('https://www.kugou.com/yy/special/single/123456.html')).toBe('123456');
    expect(parsePlaylistId('https://m.kugou.com/plist/list/123456?from=share')).toBe('123456');
    expect(parsePlaylistId('https://www.kugou.com/special/single/123456.html?specialid=123456')).toBe('123456');
    expect(parsePlaylistId('123456')).toBe('123456');
  });

  test('专辑 / 单曲 / 其它域名不能当歌单', () => {
    expect(parsePlaylistId('https://www.kugou.com/album/single/999.html')).toBe('');
    expect(parsePlaylistId('https://www.kugou.com/song/#hash=abc')).toBe('');
    expect(parsePlaylistId('https://example.com/special/single/123.html')).toBe('');
  });
});

describe('酷狗歌单曲目', () => {
  test('一次给全：字段映射、filename 拆分、时长换算', async () => {
    const { fn, calls } = makeFetch([
      { match: (u) => u.includes('/special/info'), body: meta() },
      {
        match: (u) => u.includes('/special/song'),
        body: songPage([
          { hash: 'A231178B69E6811AF6DB650359195DF8', filename: '王丽坤、朱亚文 - 漂洋过海来看你', duration: 280 },
          { hash: 'B231178B69E6811AF6DB650359195DF9', filename: '李翊君 - 漂洋过海来看你', duration: 251 },
          { hash: 'C231178B69E6811AF6DB650359195DFA', filename: '只有歌名没有歌手', duration: 0 },
        ], 3),
      },
    ]);

    const info = await playlistTracks('https://www.kugou.com/yy/special/single/123456.html', { fetch: fn });

    expect(info.kind).toBe('playlist');
    expect(info.title).toBe('震惊！这些歌居然被翻唱这么多次');
    expect(info.cover).toBe('https://imge.kugou.com/soft/collection/240/20170417/cover.jpg');
    expect(info.tracks.length).toBe(3);
    expect(info.tracks[0]).toEqual({
      id: 'a231178b69e6811af6db650359195df8',
      title: '漂洋过海来看你',
      author: '王丽坤、朱亚文',
      url: 'https://www.kugou.com/song/#hash=a231178b69e6811af6db650359195df8',
      duration_ms: 280_000,
    });
    // 没有 " - " 时不硬拆，歌名原样、歌手留空
    expect(info.tracks[2].title).toBe('只有歌名没有歌手');
    expect(info.tracks[2].author).toBe('');
    expect(info.tracks[2].duration_ms).toBeNull();
    expect(info.warnings).toEqual([]);
    const songCall = calls.find((u) => u.includes('/special/song'));
    expect(calls.filter((u) => u.includes('/special/song')).length).toBe(1);
    expect(songCall).toContain('page=1');
  });

  test('超过一页时按 pagesize 翻页，顺序保持', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ hash: hashOf(i + 1), filename: `歌手 - 歌${i + 1}`, duration: 100 }));
    const second = Array.from({ length: 50 }, (_, i) => ({ hash: hashOf(i + 101), filename: `歌手 - 歌${i + 101}`, duration: 100 }));
    const { fn, calls } = makeFetch([
      { match: (u) => u.includes('/special/info'), body: meta({ songcount: 150 }) },
      {
        match: (u) => u.includes('/special/song') && u.includes('page=1'),
        body: songPage(first, 150),
      },
      {
        match: (u) => u.includes('/special/song') && u.includes('page=2'),
        body: songPage(second, 150),
      },
    ]);

    const info = await playlistTracks('123456', { fetch: fn });

    expect(info.tracks.length).toBe(150);
    expect(info.tracks[0].id).toBe(hashOf(1));
    expect(info.tracks[149].id).toBe(hashOf(150));
    expect(calls.filter((u) => u.includes('/special/song')).length).toBe(2);
  });

  test('不存在的歌单（total:0 + info:[]）报 not_found，不当成空列表成功', async () => {
    const { fn } = makeFetch([
      { match: (u) => u.includes('/special/info'), body: meta({ songcount: 0 }) },
      { match: (u) => u.includes('/special/song'), body: songPage([], 0) },
    ]);

    try {
      await playlistTracks('999999999', { fetch: fn });
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('not_found');
      expect(err.message).toContain('id=999999999');
    }
  });

  test('认不出歌单 ID 时报 bad_input', async () => {
    try {
      await playlistTracks('https://www.kugou.com/album/single/999.html', {});
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('bad_input');
    }
  });
});
