import { describe, expect, test } from 'bun:test';

import { exitCodeFor, parseFfmpegVersion, pickSha256For, type Check } from '../src/core/doctor';

const check = (level: Check['level']): Check => ({
  id: `c-${level}`, label: 'x', level, detail: '',
});

describe('doctor 纯函数', () => {
  test('ffmpeg 版本行解析', () => {
    expect(parseFfmpegVersion('ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright'))
      .toBe('9.0.2-full_build-www.gyan.dev');
    expect(parseFfmpegVersion('ffmpeg version n8.1.2 Copyright')).toBe('n8.1.2');
    expect(parseFfmpegVersion('')).toBe('');
    expect(parseFfmpegVersion('not ffmpeg output')).toBe('');
  });

  test('只有 fail 才让退出码为 1，warn 不算失败', () => {
    expect(exitCodeFor([check('ok'), check('warn')])).toBe(0);
    expect(exitCodeFor([check('ok'), check('fail')])).toBe(1);
    expect(exitCodeFor([])).toBe(0);
  });

  test('从 SHA2-256SUMS 里挑出指定文件，不误匹配同前缀文件', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const sums = [
      `${a}  yt-dlp.exe`,
      `${b}  yt-dlp_x86.exe`,
      `${b}  yt-dlp_macos`,
    ].join('\r\n');
    expect(pickSha256For(sums, 'yt-dlp.exe')).toBe(a);
    expect(pickSha256For(sums, 'yt-dlp_macos')).toBe(b);
    expect(pickSha256For(sums, 'yt-dlp')).toBe('');
    expect(pickSha256For('', 'yt-dlp.exe')).toBe('');
    expect(pickSha256For('not-a-hash  yt-dlp.exe', 'yt-dlp.exe')).toBe('');
  });
});
