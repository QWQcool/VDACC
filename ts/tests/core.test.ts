import { describe, expect, test } from 'bun:test';

import { firstUrl, platformOf } from '../src/core/platform';
import { safeName } from '../src/core/naming';
import { parseLimit, setLimitBytesPerSec, throttle } from '../src/core/rate';
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

  test('QQ 音乐：只认域名，裸 mid 不参与路由', () => {
    expect(platformOf('https://y.qq.com/n/ryqq/songDetail/003OUlho2HcRHC')).toBe('qq');
    expect(platformOf('https://i.y.qq.com/v8/playsong.html?songmid=003OUlho2HcRHC')).toBe('qq');
    // 14 位 base62 裸串太容易和普通文本撞车，裸 mid 请用分享链接
    expect(platformOf('003OUlho2HcRHC')).toBe('unsupported');
  });

  test('整段分享文案也能识别平台', () => {
    // 抖音「复制链接」给的是整段文案，链接夹在句子中间
    const share = 'AI运镜/镜头 第八期 https://v.douyin.com/TI17LkPCjX0/ 复制此链接，打开Dou音搜索';
    expect(platformOf(share)).toBe('douyin');
    expect(platformOf('看这个 https://www.bilibili.com/video/BV1j5nj68E48?p=2 好看')).toBe('bilibili');
    expect(platformOf('链接 https://music.163.com/song?id=28606052 在这')).toBe('netease');
    expect(platformOf('没有链接的一段话')).toBe('unsupported');
  });

  test('firstUrl 只取第一个链接，遇到中文标点截断', () => {
    expect(firstUrl('前 https://v.douyin.com/abc/，后面还有字')).toBe('https://v.douyin.com/abc/');
    expect(firstUrl('https://x.com/a?b=1')).toBe('https://x.com/a?b=1');
    expect(firstUrl('没有链接')).toBe('');
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

describe('限速', () => {
  test('parseLimit 支持 K/M/G 与纯数字', () => {
    expect(parseLimit('2M')).toBe(2 * 1024 * 1024);
    expect(parseLimit('1.5m')).toBe(Math.round(1.5 * 1024 * 1024));
    expect(parseLimit('300K')).toBe(300 * 1024);
    expect(parseLimit('2MB')).toBe(2 * 1024 * 1024);
    expect(parseLimit('1M/s')).toBe(1024 * 1024);
    expect(parseLimit('1048576')).toBe(1048576);
    expect(parseLimit('0')).toBe(0);
  });

  test('parseLimit 不猜非法输入', () => {
    expect(parseLimit('')).toBeNull();
    expect(parseLimit('abc')).toBeNull();
    expect(parseLimit('2X')).toBeNull();
    expect(parseLimit('-1M')).toBeNull();
  });

  test('未设置限速时不等待', async () => {
    setLimitBytesPerSec(0);
    const started = Date.now();
    await throttle(10 * 1024 * 1024, Date.now());
    expect(Date.now() - started).toBeLessThan(50);
  });

  test('throttle 只补足差额', async () => {
    setLimitBytesPerSec(1000);
    try {
      // 200 字节 @ 1000B/s = 目标 200ms，刚起步就该等满
      const started = Date.now();
      await throttle(200, started);
      expect(Date.now() - started).toBeGreaterThanOrEqual(170);

      // 同样 200 字节，但已经过去 1s，早该超速额度用完，直接放行
      const quick = Date.now();
      await throttle(200, Date.now() - 1000);
      expect(Date.now() - quick).toBeLessThan(50);
    } finally {
      setLimitBytesPerSec(0);
    }
  });
});
