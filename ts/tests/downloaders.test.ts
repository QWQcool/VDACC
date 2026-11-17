/**
 * 「平台 → 下载引擎」这张表的行为测试。
 *
 * 2026-11-16 的真 bug：批量的下载循环写死 `netease ? getNetease : getQQ`，
 * 酷狗歌单里每一首都被交给 QQ 引擎，20 首全报「识别不出 QQ 音乐 songmid」。
 * 单条下载那条分支是对的——两份分派各写一遍，就一定会漏。
 *
 * 所以这里锁住两件事：
 * 1. 表里每个平台指向**自己的**引擎（不是「随手拿到了一个函数」）；
 * 2. 不在表里的平台返回 null，让调用方给出可读错误，而不是被默认丢给 QQ。
 */
import { describe, expect, test } from 'bun:test';

import { downloaderFor, musicDownloadPlatforms } from '../src/engines/downloaders';
import { getKugou } from '../src/engines/kugou';
import { getNetease } from '../src/engines/netease';
import { getQQ } from '../src/engines/qq';

describe('音乐下载引擎分派表', () => {
  test('三个音乐平台各自指向自己的引擎', () => {
    expect(downloaderFor('netease')).toBe(getNetease);
    expect(downloaderFor('qq')).toBe(getQQ);
    expect(downloaderFor('kugou')).toBe(getKugou);
  });

  test('不支持批量的平台返回 null，不能被默默当成 QQ', () => {
    for (const platform of ['kuwo', 'douyin', 'bilibili', 'sniff', 'unsupported', '']) {
      expect(downloaderFor(platform)).toBeNull();
    }
  });

  test('平台清单与表一致（错误文案从这里取，别各写一份）', () => {
    expect(musicDownloadPlatforms().sort()).toEqual(['kugou', 'netease', 'qq']);
  });
});
