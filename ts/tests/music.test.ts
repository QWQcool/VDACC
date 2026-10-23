import { describe, expect, test } from 'bun:test';

import { platformOf } from '../src/core/platform';
import { parseRid, toLrc } from '../src/engines/kuwo';
import { parseHash } from '../src/engines/kugou';

const HASH = 'b9b3a55ffb5b95f165839a26120e9fec';

describe('酷我链接解析', () => {
  test('play_detail / musicId / MUSIC_ 前缀 / 裸数字', () => {
    expect(parseRid('https://www.kuwo.cn/play_detail/474678847')).toBe('474678847');
    expect(parseRid('https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=474678847'))
      .toBe('474678847');
    expect(parseRid('https://www.kuwo.cn/play_detail/474678847?from=share')).toBe('474678847');
    expect(parseRid('MUSIC_474678847')).toBe('474678847');
    expect(parseRid('474678847')).toBe('474678847');
  });

  test('非酷我域名不猜', () => {
    expect(parseRid('https://example.com/play_detail/474678847')).toBe('');
    expect(parseRid('https://y.qq.com/n/ryqq/songDetail/000qgdMS2J7UZ9')).toBe('');
  });
});

describe('酷狗链接解析', () => {
  test('hash 参数 / fragment / 裸 hash', () => {
    expect(parseHash(`https://www.kugou.com/song/#hash=${HASH}`)).toBe(HASH);
    expect(parseHash(`https://www.kugou.com/song/?hash=${HASH}`)).toBe(HASH);
    expect(parseHash(HASH.toUpperCase())).toBe(HASH);
    expect(parseHash(`https://www.kugou.com/song/#/mix/1?hash=${HASH}`)).toBe(HASH);
  });

  test('非酷狗域名 / 非 hash 不猜', () => {
    expect(parseHash(`https://example.com/song/#hash=${HASH}`)).toBe('');
    expect(parseHash('https://www.kugou.com/song/#hash=abc')).toBe('');
  });
});

describe('酷我歌词转 LRC', () => {
  test('秒 → [mm:ss.cc]', () => {
    expect(toLrc([
      { time: '12.34', lineLyric: '第一句' },
      { time: 0, lineLyric: '第二句' },
    ])).toBe('[00:12.34]第一句\n[00:00.00]第二句');
  });

  test('百分秒进位不出现 .100', () => {
    expect(toLrc([{ time: 12.999, lineLyric: 'x' }])).toBe('[00:13.00]x');
    expect(toLrc([{ time: 61.5, lineLyric: 'y' }])).toBe('[01:01.50]y');
  });

  test('空列表', () => {
    expect(toLrc([])).toBe('');
  });
});

describe('新平台路由', () => {
  test('酷我 / 酷狗按域名', () => {
    expect(platformOf('https://www.kuwo.cn/play_detail/474678847')).toBe('kuwo');
    expect(platformOf('https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=1')).toBe('kuwo');
    expect(platformOf(`https://www.kugou.com/song/#hash=${HASH}`)).toBe('kugou');
    expect(platformOf('https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo')).toBe('kugou');
  });

  test('不误伤已有平台', () => {
    expect(platformOf('https://y.qq.com/n/ryqq/songDetail/000qgdMS2J7UZ9')).toBe('qq');
    expect(platformOf('https://music.163.com/song?id=28606052')).toBe('netease');
    expect(platformOf('https://example.com/')).toBe('unsupported');
  });
});
