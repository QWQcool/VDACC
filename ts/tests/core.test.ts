import { describe, expect, test } from 'bun:test';

import { platformOf } from '../src/core/platform';
import { safeName } from '../src/core/naming';
import { format, emptyMedia } from '../src/core/types';

describe('platformOf', () => {
  test('抖音：裸 ID / 链接 / modal_id', () => {
    expect(platformOf('6961737553342991651')).toBe('douyin');
    expect(platformOf('https://www.douyin.com/video/6961737553342991651')).toBe('douyin');
    expect(platformOf('https://www.douyin.com/?modal_id=6961737553342991651')).toBe('douyin');
  });

  test('网易云：裸 ID / song 链接 / 短链', () => {
    expect(platformOf('28606052')).toBe('netease');
    expect(platformOf('https://music.163.com/song?id=28606052')).toBe('netease');
    expect(platformOf('https://163cn.tv/abc')).toBe('netease');
  });

  test('B站：裸 BV / 视频 / 番剧 / 短链', () => {
    expect(platformOf('BV1j5nj68E48')).toBe('bilibili');
    expect(platformOf('https://www.bilibili.com/video/BV1j5nj68E48?p=2')).toBe('bilibili');
    expect(platformOf('https://www.bilibili.com/bangumi/play/ep733316')).toBe('bilibili');
    expect(platformOf('https://b23.tv/x')).toBe('bilibili');
  });

  test('未知与空值', () => {
    expect(platformOf('https://example.com/x')).toBe('unsupported');
    expect(platformOf('随便一段话')).toBe('unsupported');
    expect(platformOf('')).toBe('unsupported');
    expect(platformOf('123')).toBe('netease');   // 1~12 位纯数字按网易云 ID 处理
  });
});

describe('safeName', () => {
  test('非法字符替换与长度截断', () => {
    expect(safeName('a/b:c*d?e"f<g>h|i#j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(safeName('x'.repeat(100)).length).toBe(55);
  });

  test('空白/纯点回退', () => {
    expect(safeName('   ')).toBe('media');
    expect(safeName(' ... ')).toBe('media');
    expect(safeName('', 10, 'fallback')).toBe('fallback');
  });

  test('中文保留', () => {
    expect(safeName('凡人修仙传 EP1')).toBe('凡人修仙传 EP1');
  });
});

describe('契约默认值', () => {
  test('format 补齐默认字段', () => {
    const f = format({ id: 'bili-1920', label: '1080P' });
    expect(f.available).toBe(true);
    expect(f.recommended).toBe(false);
    expect(f.subtitles).toEqual([]);
    expect(f.bytes).toBeNull();
  });

  test('media 序列化包含 parts', () => {
    const media = emptyMedia('bilibili');
    expect(media.parts).toEqual([]);
    expect(media.platform).toBe('bilibili');
  });
});
