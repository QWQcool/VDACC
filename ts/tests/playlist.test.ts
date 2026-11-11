import { describe, expect, test } from 'bun:test';

import { expandShortLink, parsePlaylistId, playlistTracks } from '../src/engines/netease';

const API = 'https://music.163.com';
const PLAYLIST_URL = 'https://music.163.com/playlist?id=3778678';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface Route { match: (url: string) => boolean; body: unknown }

/** 记录请求顺序的假 fetch：测试不碰网络，也断言「只请求应该请求的端点」。 */
function makeFetch(routes: Route[]) {
  const calls: string[] = [];
  const fn = async (input: any) => {
    const url = String(input);
    calls.push(url);
    const hit = routes.find((r) => r.match(url));
    if (!hit) throw new Error(`未预期的请求: ${url}`);
    return jsonResponse(hit.body);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const detail = (over: Record<string, any> = {}) => ({
  code: 200,
  playlist: {
    id: 3778678,
    name: '热歌榜',
    coverImgUrl: 'http://p1.music.126.net/cover.jpg',
    trackCount: 5,
    trackIds: [{ id: 11 }, { id: 22 }, { id: 33 }, { id: 44 }, { id: 55 }],
    ...over,
  },
});

describe('歌单链接解析', () => {
  test('query / hash / 手机分享 / 路径 / 裸 ID', () => {
    expect(parsePlaylistId('https://music.163.com/playlist?id=3778678')).toBe('3778678');
    expect(parsePlaylistId('https://music.163.com/#/playlist?id=3778678')).toBe('3778678');
    expect(parsePlaylistId('https://music.163.com/m/playlist?id=3778678&userid=1')).toBe('3778678');
    expect(parsePlaylistId('https://music.163.com/playlist/3778678')).toBe('3778678');
    expect(parsePlaylistId('3778678')).toBe('3778678');
  });

  test('专辑 / 歌曲 / 普通文本都不能当歌单', () => {
    expect(parsePlaylistId('https://music.163.com/album?id=513433')).toBe('');
    expect(parsePlaylistId('https://music.163.com/song?id=513433')).toBe('');
    expect(parsePlaylistId('随便一段话')).toBe('');
    // 短链要跟跳转才知道指向哪里，这里不猜
    expect(parsePlaylistId('https://163cn.tv/abcdef')).toBe('');
  });
});

describe('163cn.tv 短链', () => {
  test('非短链原样返回，不发请求', async () => {
    let called = 0;
    const fn = (async () => { called += 1; return { status: 200, url: '' }; }) as unknown as typeof fetch;

    expect(await expandShortLink('https://music.163.com/playlist?id=1', fn))
      .toBe('https://music.163.com/playlist?id=1');
    expect(await expandShortLink('3778678', fn)).toBe('3778678');
    expect(await expandShortLink('随便一段话', fn)).toBe('随便一段话');
    expect(called).toBe(0);
  });

  test('跟随跳转后落在 music.163.com 才算成功', async () => {
    const fn = (async () => ({
      status: 200, url: 'https://music.163.com/#/playlist?id=3778678',
    })) as unknown as typeof fetch;
    expect(await expandShortLink('https://163cn.tv/abc', fn))
      .toBe('https://music.163.com/#/playlist?id=3778678');
  });

  test('落在活动页要明说，不能吞成「识别不出 ID」', async () => {
    const fn = (async () => ({
      status: 200, url: 'https://st.music.163.com/webpage-cntv',
    })) as unknown as typeof fetch;
    try {
      await expandShortLink('https://163cn.tv/abc', fn);
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('bad_input');
      expect(err.message).toContain('不是歌曲/专辑/歌单');
    }
  });

  test('短链失效（403）给出重新复制的下一步', async () => {
    const fn = (async () => ({ status: 403, url: 'https://163cn.tv/abc' })) as unknown as typeof fetch;
    try {
      await expandShortLink('https://163cn.tv/abc', fn);
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('bad_input');
      expect(err.message).toContain('已失效');
      expect(String(err.nextAction || '')).toContain('重新复制');
    }
  });
});

describe('歌单曲目：trackIds + song/detail 批量补齐', () => {
  test('按 trackIds 顺序还原，song/detail 乱序也不影响', async () => {
    const { fn, calls } = makeFetch([
      { match: (u) => u.includes('/api/v6/playlist/detail'), body: detail() },
      {
        match: (u) => u.includes('/api/song/detail'),
        body: {
          code: 200,
          songs: [
            { id: 33, name: 'C', ar: [{ name: '丙' }] },
            { id: 11, name: 'A', ar: [{ name: '甲' }, { name: '甲二' }] },
            { id: 55, name: 'E', ar: [] },
            { id: 22, name: 'B', ar: [{ name: '乙' }] },
            { id: 44, name: 'D', ar: [{ name: '丁' }] },
          ],
        },
      },
    ]);

    const info = await playlistTracks(PLAYLIST_URL, { fetch: fn, cookie: '' });

    expect(info.kind).toBe('playlist');
    expect(info.id).toBe('3778678');
    expect(info.title).toBe('热歌榜');
    expect(info.cover).toBe('http://p1.music.126.net/cover.jpg');
    expect(info.tracks.map((t) => t.id)).toEqual(['11', '22', '33', '44', '55']);
    expect(info.tracks.map((t) => t.title)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(info.tracks[0].author).toBe('甲 / 甲二');
    expect(info.tracks[0].url).toBe(`${API}/song?id=11`);
    expect(info.warnings).toEqual([]);
    // 5 首一批够用：detail 一次 + song/detail 一次
    expect(calls.filter((u) => u.includes('/api/song/detail')).length).toBe(1);
    // 元信息用 n=0 省流（实测 34KB vs 472KB）
    expect(calls.filter((u) => u.includes('n=0')).length).toBe(1);
  });

  test('超过 batchSize 时分批请求，最后仍按原顺序拼接', async () => {
    const ids = [101, 102, 103, 104, 105];
    const { fn, calls } = makeFetch([
      {
        match: (u) => u.includes('/api/v6/playlist/detail'),
        body: detail({ trackCount: ids.length, trackIds: ids.map((id) => ({ id })) }),
      },
      {
        match: (u) => u.includes('/api/song/detail'),
        body: { code: 200, songs: ids.map((id) => ({ id, name: `S${id}`, ar: [] })) },
      },
    ]);

    const info = await playlistTracks(PLAYLIST_URL, { fetch: fn, cookie: '', batchSize: 2 });

    expect(info.tracks.map((t) => t.id)).toEqual(ids.map(String));
    expect(calls.filter((u) => u.includes('/api/song/detail')).length).toBe(3);
  });

  test('拿不到详情的曲目如实报出来，不静默补齐', async () => {
    const { fn } = makeFetch([
      { match: (u) => u.includes('/api/v6/playlist/detail'), body: detail() },
      {
        match: (u) => u.includes('/api/song/detail'),
        body: {
          code: 200,
          songs: [
            { id: 11, name: 'A', ar: [] },
            { id: 22, name: 'B', ar: [] },
            { id: 44, name: 'D', ar: [] },
            { id: 55, name: 'E', ar: [] },
          ],
        },
      },
    ]);

    const info = await playlistTracks(PLAYLIST_URL, { fetch: fn, cookie: '' });

    expect(info.tracks.map((t) => t.id)).toEqual(['11', '22', '44', '55']);
    const text = info.warnings.join('\n');
    expect(text).toContain('只拿到 4 首详情');
    expect(text).toContain('1 首拿不到详情');
  });

  test('接口声明的曲目数与 trackIds 对不上时给 warning', async () => {
    const { fn } = makeFetch([
      {
        match: (u) => u.includes('/api/v6/playlist/detail'),
        body: detail({ trackCount: 9, trackIds: [{ id: 11 }, { id: 22 }] }),
      },
      {
        match: (u) => u.includes('/api/song/detail'),
        body: { code: 200, songs: [{ id: 11, name: 'A', ar: [] }, { id: 22, name: 'B', ar: [] }] },
      },
    ]);

    const info = await playlistTracks(PLAYLIST_URL, { fetch: fn, cookie: '' });

    expect(info.tracks.length).toBe(2);
    expect(info.warnings.join('\n')).toContain('接口声明 9 首');
  });

  test('n=0 没给 trackIds 时退回默认详情再取一次', async () => {
    const { fn, calls } = makeFetch([
      {
        match: (u) => u.includes('/api/v6/playlist/detail') && u.includes('n=0'),
        body: detail({ trackIds: [], tracks: [] }),
      },
      {
        match: (u) => u.includes('/api/v6/playlist/detail'),
        body: detail({ trackIds: [], tracks: [{ id: 77, name: 'G', ar: [] }] }),
      },
      {
        match: (u) => u.includes('/api/song/detail'),
        body: { code: 200, songs: [{ id: 77, name: 'G', ar: [{ name: '庚' }] }] },
      },
    ]);

    const info = await playlistTracks(PLAYLIST_URL, { fetch: fn, cookie: '' });

    expect(info.tracks.map((t) => t.id)).toEqual(['77']);
    expect(calls.filter((u) => u.includes('/api/v6/playlist/detail')).length).toBe(2);
    expect(info.warnings.join('\n')).toContain('没有返回完整曲目 ID 列表');
  });

  test('私密 / 不存在的歌单不冒充空歌单', async () => {
    const { fn } = makeFetch([
      { match: (u) => u.includes('/api/v6/playlist/detail'), body: { code: 404, msg: 'not found' } },
    ]);

    try {
      await playlistTracks(PLAYLIST_URL, { fetch: fn, cookie: '' });
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('not_found');
      expect(err.message).toContain('id=3778678');
      // 不能只说"空歌单"，要给出可执行下一步
      expect(String(err.nextAction || '')).toContain('公开');
    }
  });

  test('曲目全部拿不到详情时报 not_found', async () => {
    const { fn } = makeFetch([
      { match: (u) => u.includes('/api/v6/playlist/detail'), body: detail() },
      { match: (u) => u.includes('/api/song/detail'), body: { code: 200, songs: [] } },
    ]);

    try {
      await playlistTracks(PLAYLIST_URL, { fetch: fn, cookie: '' });
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('not_found');
      expect(err.message).toContain('都拿不到详情');
    }
  });

  test('认不出歌单 ID 时报 bad_input', async () => {
    try {
      await playlistTracks('https://music.163.com/album?id=1', { cookie: '' });
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('bad_input');
    }
  });
});
