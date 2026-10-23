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
    expect(planAlbum([])).toEqual({ take: [], dropped: 0 });
    const dirty: any = [...make(2), { id: '', title: '坏条目', author: '', url: '' }];
    expect(planAlbum(dirty).take.length).toBe(2);
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
