import { describe, expect, test } from 'bun:test';

import { MAX_ALBUM_TRACKS, planAlbum } from '../src/core/album';
import { parseAlbumId } from '../src/engines/netease';
import { parseAlbumMid } from '../src/engines/qq';

const make = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `id${i}`, title: `曲目${i}`, author: '', url: `u${i}`,
}));

describe('专辑批量上限', () => {
  test('默认上限是 20', () => {
    expect(MAX_ALBUM_TRACKS).toBe(20);
    expect(planAlbum(make(20)).take.length).toBe(20);
    expect(planAlbum(make(20)).dropped).toBe(0);
  });

  test('超限取前 N 并如实报略过数量', () => {
    const plan = planAlbum(make(25));
    expect(plan.take.length).toBe(20);
    expect(plan.dropped).toBe(5);
    expect(plan.take[0].id).toBe('id0');
  });

  test('空列表与没有 id 的条目', () => {
    const empty = planAlbum([]);
    expect(empty.take.length).toBe(0);
    expect(empty.dropped).toBe(0);
    expect(empty.hasMore).toBe(false);
    const dirty: any = [...make(2), { id: '', title: '坏条目', author: '', url: '' }];
    expect(planAlbum(dirty).take.length).toBe(2);
  });

  test('第二批：从 offset 继续，且 nextOffset 能推到尾部', () => {
    const tracks = make(45);
    const first = planAlbum(tracks);
    expect(first.take.length).toBe(20);
    expect(first.dropped).toBe(25);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(20);

    const second = planAlbum(tracks, first.nextOffset);
    expect(second.take[0].id).toBe('id20');
    expect(second.take.length).toBe(20);
    expect(second.hasMore).toBe(true);
    expect(second.nextOffset).toBe(40);

    const third = planAlbum(tracks, second.nextOffset);
    expect(third.take.length).toBe(5);
    expect(third.hasMore).toBe(false);
    expect(third.dropped).toBe(0);
    expect(third.nextOffset).toBe(45);
  });

  test('offset 越界与负数都夹回合法范围', () => {
    expect(planAlbum(make(10), 999).take.length).toBe(0);
    expect(planAlbum(make(10), 999).hasMore).toBe(false);
    expect(planAlbum(make(10), -3).take[0].id).toBe('id0');
  });
});

describe('专辑链接解析', () => {
  test('网易云：query / 路径 / hash / 裸 ID', () => {
    expect(parseAlbumId('https://music.163.com/album?id=513433')).toBe('513433');
    expect(parseAlbumId('https://music.163.com/#/album?id=2854052')).toBe('2854052');
    expect(parseAlbumId('https://music.163.com/album/513433')).toBe('513433');
    expect(parseAlbumId('513433')).toBe('513433');
    // 歌曲链接不能当专辑：id 同名但不是一回事
    expect(parseAlbumId('https://music.163.com/song?id=513433')).toBe('');
    expect(parseAlbumId('随便一段话')).toBe('');
  });

  test('QQ：albumDetail / albummid / 裸 mid', () => {
    expect(parseAlbumMid('https://y.qq.com/n/ryqq/albumDetail/001zU1173lcnR3')).toBe('001zU1173lcnR3');
    expect(parseAlbumMid('https://y.qq.com/n/ryqq/albumDetail/001zU1173lcnR3/')).toBe('001zU1173lcnR3');
    expect(parseAlbumMid('https://i.y.qq.com/n2/m/share/details/album.html?albummid=001zU1173lcnR3'))
      .toBe('001zU1173lcnR3');
    expect(parseAlbumMid('001zU1173lcnR3')).toBe('001zU1173lcnR3');
    expect(parseAlbumMid('https://example.com/albumDetail/001zU1173lcnR3')).toBe('');
  });
});
