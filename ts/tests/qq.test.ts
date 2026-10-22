import { describe, expect, test } from 'bun:test';

import { canHandle, parseSongmid } from '../src/engines/qq';

// 只测纯函数：probe 依赖真实接口，放进手工验收（docs/music-channels.md），
// 否则测试会因为匿名档位/接口策略变化而随机红。
describe('QQ 音乐 songmid 解析', () => {
  test('裸 mid', () => {
    expect(parseSongmid('003OUlho2HcRHC')).toBe('003OUlho2HcRHC');
    expect(parseSongmid('  000qgdMS2J7UZ9  ')).toBe('000qgdMS2J7UZ9');
  });

  test('songDetail 路径', () => {
    expect(parseSongmid('https://y.qq.com/n/ryqq/songDetail/003OUlho2HcRHC'))
      .toBe('003OUlho2HcRHC');
    expect(parseSongmid('https://y.qq.com/n/ryqq/songDetail/003OUlho2HcRHC/'))
      .toBe('003OUlho2HcRHC');
  });

  test('playsong 查询参数', () => {
    expect(parseSongmid('https://i.y.qq.com/v8/playsong.html?songmid=000qgdMS2J7UZ9'))
      .toBe('000qgdMS2J7UZ9');
  });

  test('长度不对 / 非 QQ 域名不猜', () => {
    expect(parseSongmid('003OUlho2HcRH')).toBe('');
    expect(parseSongmid('003OUlho2HcRHCX')).toBe('');
    expect(parseSongmid('https://example.com/songDetail/003OUlho2HcRHC')).toBe('');
    expect(parseSongmid('https://example.com/?songmid=003OUlho2HcRHC')).toBe('');
    expect(parseSongmid('随便一段话')).toBe('');
    expect(parseSongmid('')).toBe('');
  });

  test('canHandle 跟着 parseSongmid 走', () => {
    expect(canHandle('https://y.qq.com/n/ryqq/songDetail/003OUlho2HcRHC')).toBe(true);
    expect(canHandle('https://www.douyin.com/video/6961737553342991651')).toBe(false);
    expect(canHandle('https://example.com/x')).toBe(false);
  });
});
