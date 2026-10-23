import { describe, expect, test } from 'bun:test';

import { canHandle, parseMasterPlaylist, parseMediaDuration, sniffExt } from '../src/engines/sniff';

describe('L2 嗅探只接管直链媒体', () => {
  test('扩展名识别', () => {
    expect(sniffExt('https://cdn.example.com/a/b.MP4?token=1')).toBe('mp4');
    expect(sniffExt('https://cdn.example.com/live/index.m3u8')).toBe('m3u8');
    expect(sniffExt('https://cdn.example.com/page.html')).toBe('html');
    expect(sniffExt('https://cdn.example.com/watch/123')).toBe('');
  });

  test('canHandle 只认媒体扩展名', () => {
    expect(canHandle('https://cdn.example.com/v/1.mp4')).toBe(true);
    expect(canHandle('https://cdn.example.com/v/1.m3u8?sign=x')).toBe(true);
    expect(canHandle('https://cdn.example.com/v/1.webm')).toBe(true);
    expect(canHandle('https://example.com/watch?v=1')).toBe(false);
    expect(canHandle('https://example.com/index.html')).toBe(false);
    expect(canHandle('不是链接')).toBe(false);
  });
});

describe('m3u8 解析', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2149280,CODECS="mp4a.40.2,avc1.64001f",RESOLUTION=1280x720,NAME="720"',
    'url_0/193039199_mp4_h264_aac_hd_7.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=246440,CODECS="mp4a.40.5,avc1.42000d",RESOLUTION=320x184,NAME="240"',
    'url_2/193039199_mp4_h264_aac_ld_7.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=6221600,RESOLUTION=1920x1080,NAME="1080"',
    'url_8/193039199_mp4_h264_aac_fhd_7.m3u8',
  ].join('\n');

  test('变体按高度降序、相对地址补全', () => {
    const list = parseMasterPlaylist(master, 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
    expect(list.length).toBe(3);
    expect(list[0].height).toBe(1080);
    expect(list[0].url).toBe('https://test-streams.mux.dev/x36xhzz/url_8/193039199_mp4_h264_aac_fhd_7.m3u8');
    expect(list[1].height).toBe(720);
    // CODECS 里的逗号不能把 RESOLUTION 吃掉
    expect(list[1].width).toBe(1280);
    expect(list[1].bandwidth).toBe(2149280);
  });

  test('媒体列表总时长 = EXTINF 之和', () => {
    expect(parseMediaDuration([
      '#EXTM3U', '#EXT-X-TARGETDURATION:10',
      '#EXTINF:9.009,', 'a.ts',
      '#EXTINF:9.009,', 'b.ts',
      '#EXTINF:3.5,', 'c.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'))).toBe(21.518);
    expect(parseMediaDuration('#EXTM3U')).toBe(0);
  });
});
