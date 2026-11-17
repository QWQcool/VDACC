/**
 * 酷狗专辑批量（2026-11-16 新增，匿名可用）。
 *
 * 实测口径（`albumid=958909`「十一月的萧邦」，12 首）：
 *   `album/info?albumid=` → `albumname` / `singername` / `imgurl`（`{size}` 占位、下发改 http）
 *   `album/song?albumid=&page=&pagesize=` → `data.total` + `data.info[]`，字段与歌单项完全一致
 *
 * **关键的坑**：同一个专辑 `album/info` 回的 `songcount` 是 **0**，而 `album/song` 的 `total` 是 12。
 * 拿前者当总数会让「接口声明 0 首」的提示彻底失真，所以总数一律取曲目接口。
 */
import { describe, expect, test } from 'bun:test';

import { albumTracks, parseAlbumId } from '../src/engines/kugou';

const ALBUM_PAGE = 100;

const meta = (over: Record<string, unknown> = {}) => ({
  data: {
    albumname: '十一月的萧邦',
    singername: '周杰伦',
    // 实测就是 0，别拿它当总数
    songcount: 0,
    imgurl: 'http://imge.kugou.com/stdmusic/{size}/20250125/cover.jpg',
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

describe('酷狗专辑链接解析', () => {
  test('网页专辑页 / 查询参数 / 裸数字', () => {
    expect(parseAlbumId('https://www.kugou.com/yy/album/single/958909.html')).toBe('958909');
    expect(parseAlbumId('https://www.kugou.com/album/single/958909.html')).toBe('958909');
    expect(parseAlbumId('https://m.kugou.com/album/958909?albumid=958909')).toBe('958909');
    expect(parseAlbumId('https://www.kugou.com/share/album.html?albumid=958909')).toBe('958909');
    expect(parseAlbumId('958909')).toBe('958909');
  });

  test('歌单页 / 单曲页 / 其它域名不能当专辑', () => {
    expect(parseAlbumId('https://www.kugou.com/yy/special/single/958909.html')).toBe('');
    expect(parseAlbumId('https://m.kugou.com/plist/list/958909')).toBe('');
    expect(parseAlbumId('https://www.kugou.com/song/#hash=16c8ab298231370293d16bcf9e5ff9b6')).toBe('');
    expect(parseAlbumId('https://example.com/yy/album/single/958909.html')).toBe('');
  });
});

describe('酷狗专辑曲目', () => {
  test('字段映射：标题带歌手、封面提 https 且换 240、时长秒 → 毫秒', async () => {
    const { fn, calls } = makeFetch([
      { match: (u) => u.includes('/album/info'), body: meta() },
      {
        match: (u) => u.includes('/album/song'),
        body: songPage([
          { hash: 'A231178B69E6811AF6DB650359195DF8', filename: '周杰伦 - 夜曲', duration: 226 },
          { hash: 'B231178B69E6811AF6DB650359195DF9', filename: '周杰伦 - 发如雪', duration: 0 },
        ], 2),
      },
    ]);

    const info = await albumTracks('https://www.kugou.com/yy/album/single/958909.html', { fetch: fn });

    expect(info.kind).toBe('album');
    expect(info.id).toBe('958909');
    expect(info.title).toBe('十一月的萧邦（周杰伦）');
    expect(info.cover).toBe('https://imge.kugou.com/stdmusic/240/20250125/cover.jpg');
    expect(info.tracks).toEqual([
      { id: 'a231178b69e6811af6db650359195df8', title: '夜曲', author: '周杰伦', url: 'https://www.kugou.com/song/#hash=a231178b69e6811af6db650359195df8', duration_ms: 226000 },
      { id: 'b231178b69e6811af6db650359195df9', title: '发如雪', author: '周杰伦', url: 'https://www.kugou.com/song/#hash=b231178b69e6811af6db650359195df9', duration_ms: null },
    ]);
    expect(info.warnings).toEqual([]);
    // 曲目接口只该请求一次（2 首 < 一页 100）
    expect(calls.filter((u) => u.includes('/album/song')).length).toBe(1);
  });

  test('总数以 album/song 的 total 为准，不能用 album/info 的 songcount=0', async () => {
    const { fn } = makeFetch([
      { match: (u) => u.includes('/album/info'), body: meta() },
      { match: (u) => u.includes('/album/song'), body: songPage([], 12) },
    ]);

    try {
      await albumTracks('958909', { fetch: fn });
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.code).toBe('not_found');
      expect(err.message).toContain('专辑里没有可下载的曲目');
      // 说 12 首，不是 0 首
      expect(err.nextAction).toContain('接口声明 12 首');
    }
  });

  test('超过一页时分页取完，每页一次请求', async () => {
    const page1 = Array.from({ length: ALBUM_PAGE }, (_, i) => ({
      hash: hashOf(i + 1),
      filename: `周杰伦 - 曲目${i + 1}`,
      duration: 200,
    }));
    const page2 = [{ hash: hashOf(101), filename: '周杰伦 - 曲目101', duration: 200 }];

    const { fn, calls } = makeFetch([
      { match: (u) => u.includes('/album/info'), body: meta() },
      { match: (u) => u.includes('page=1'), body: songPage(page1, 101) },
      { match: (u) => u.includes('page=2'), body: songPage(page2, 101) },
    ]);

    const info = await albumTracks('958909', { fetch: fn });

    expect(info.tracks.length).toBe(101);
    expect(info.tracks[100].title).toBe('曲目101');
    expect(calls.filter((u) => u.includes('/album/song')).length).toBe(2);
  });

  test('歌单链接当专辑传进来时明确说「识别不出专辑 ID」，不发请求', async () => {
    await expect(albumTracks('https://www.kugou.com/yy/special/single/1.html'))
      .rejects.toThrow(/识别不出酷狗专辑 ID/);
  });
});

function hashOf(n: number): string {
  return n.toString(16).padStart(32, '0');
}
