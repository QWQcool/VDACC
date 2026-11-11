import { describe, expect, test } from 'bun:test';

import { parsePlaylistId, playlistTracks } from '../src/engines/qq';

const SONG_PAGE = 'https://y.qq.com/n/ryqq/songDetail/';

function song(n: number) {
  return {
    mid: `mid${String(n).padStart(11, '0')}`,
    name: `歌${n}`,
    singer: [{ name: `歌手${n}` }],
  };
}

/** 按调用顺序吐出预设页；记录请求体，验证 song_begin / song_num 真的发对了。 */
function makeFetch(pages: any[]) {
  const calls: string[] = [];
  const fn = async (_input: any, init?: any) => {
    calls.push(String(init?.body || ''));
    const body = pages.shift() ?? { req: { code: 0, data: { dirinfo: { songnum: 0 }, songlist: [] } } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const page = (songlist: any[], songnum: number, title = '甜度爆表') => ({
  req: { code: 0, data: { dirinfo: { title, songnum, picurl: 'http://p1/cover.jpg' }, songlist } },
});

describe('QQ 歌单链接解析', () => {
  test('网页歌单 / 分享页 / 裸数字', () => {
    expect(parsePlaylistId('https://y.qq.com/n/ryqq/playlist/7707261125')).toBe('7707261125');
    expect(parsePlaylistId('https://i.y.qq.com/n2/m/share/details/taoge.html?id=7707261125&hosteuin=xx'))
      .toBe('7707261125');
    expect(parsePlaylistId('7707261125')).toBe('7707261125');
  });

  test('专辑 / 单曲 / 普通文本不能当歌单', () => {
    expect(parsePlaylistId('https://y.qq.com/n/ryqq/albumDetail/001zU1173lcnR3')).toBe('');
    expect(parsePlaylistId('https://y.qq.com/n/ryqq/songDetail/002xTzGb2UBQRk')).toBe('');
    expect(parsePlaylistId('随便一段话')).toBe('');
  });
});

describe('QQ 歌单曲目', () => {
  test('一页就够时只请求一次，字段映射正确', async () => {
    const { fn, calls } = makeFetch([page([song(1), song(2), song(3)], 3)]);
    const info = await playlistTracks('https://y.qq.com/n/ryqq/playlist/7707261125', { fetch: fn });

    expect(info.kind).toBe('playlist');
    expect(info.id).toBe('7707261125');
    expect(info.title).toBe('甜度爆表');
    expect(info.cover).toBe('http://p1/cover.jpg');
    expect(info.tracks.map((t) => t.title)).toEqual(['歌1', '歌2', '歌3']);
    expect(info.tracks[0].author).toBe('歌手1');
    expect(info.tracks[0].url).toBe(SONG_PAGE + song(1).mid);
    expect(info.warnings).toEqual([]);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('"song_begin":0');
    expect(calls[0]).toContain('"song_num":100');
  });

  test('超过一页时继续翻页，顺序保持', async () => {
    const first = Array.from({ length: 100 }, (_, i) => song(i + 1));
    const second = Array.from({ length: 50 }, (_, i) => song(i + 101));
    const { fn, calls } = makeFetch([page(first, 150), page(second, 150)]);

    const info = await playlistTracks('7707261125', { fetch: fn });

    expect(info.tracks.length).toBe(150);
    expect(info.tracks[0].id).toBe(song(1).mid);
    expect(info.tracks[149].id).toBe(song(150).mid);
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('"song_begin":100');
  });

  test('翻页边界重复的 mid 只留一条', async () => {
    const first = Array.from({ length: 100 }, (_, i) => song(i + 1));
    // 第二页把第 100 首又给了一次
    const second = [song(100), song(101)];
    const { fn } = makeFetch([page(first, 101), page(second, 101)]);

    const info = await playlistTracks('7707261125', { fetch: fn });

    expect(info.tracks.length).toBe(101);
    expect(new Set(info.tracks.map((t) => t.id)).size).toBe(101);
  });

  test('接口声明的总数多于实际拿到的，如实报出来', async () => {
    const { fn } = makeFetch([page([song(1), song(2)], 9)]);
    const info = await playlistTracks('7707261125', { fetch: fn });

    expect(info.tracks.length).toBe(2);
    expect(info.warnings.join('\n')).toContain('接口声明 9 首');
  });

  test('接口 code 非 0 时报 playlist_failed 并给下一步', async () => {
    const { fn } = makeFetch([{ req: { code: 500003, subcode: 860100005 } }]);
    try {
      await playlistTracks('7707261125', { fetch: fn });
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('playlist_failed');
      expect(err.message).toContain('500003');
      expect(String(err.nextAction || '')).toContain('公开');
    }
  });

  test('空歌单不冒充成功', async () => {
    const { fn } = makeFetch([page([], 0)]);
    try {
      await playlistTracks('7707261125', { fetch: fn });
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('not_found');
    }
  });

  test('认不出歌单 ID 时 bad_input', async () => {
    try {
      await playlistTracks('https://y.qq.com/n/ryqq/albumDetail/001zU1173lcnR3', {});
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('bad_input');
    }
  });
});
