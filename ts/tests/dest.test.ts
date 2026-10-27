import { afterEach, describe, expect, test } from 'bun:test';
import { basename } from 'node:path';

import { activeDestCount, releaseDest, reserveDest } from '../src/core/dest';

const dir = 'C:\\tmp\\vdl-out';
const reserved: string[] = [];

afterEach(() => {
  for (const path of reserved.splice(0)) releaseDest(path);
});

describe('输出路径预留', () => {
  test('首次直接使用原文件名', () => {
    const first = reserveDest(dir, '标题_1080P.mp4');
    reserved.push(first);
    expect(basename(first)).toBe('标题_1080P.mp4');
  });

  test('并发同名追加 (2)/(3)，扩展名保持在末尾', () => {
    const a = reserveDest(dir, '标题.mp4');
    const b = reserveDest(dir, '标题.mp4');
    const c = reserveDest(dir, '标题.mp4');
    reserved.push(a, b, c);
    expect([basename(a), basename(b), basename(c)])
      .toEqual(['标题.mp4', '标题 (2).mp4', '标题 (3).mp4']);
  });

  test('Windows 路径大小写不敏感，重下覆盖语义不受影响', () => {
    const a = reserveDest(dir, 'Song.MP3');
    const b = reserveDest(dir, 'song.mp3');
    reserved.push(a, b);
    expect(basename(b)).toBe('song (2).mp3');
  });

  test('释放后可复用原名，且全部释放后计数归零', () => {
    const a = reserveDest(dir, 'x.webm');
    releaseDest(a);
    const b = reserveDest(dir, 'x.webm');
    expect(basename(b)).toBe('x.webm');
    releaseDest(b);
    expect(activeDestCount()).toBe(0);
  });

  test('无扩展名文件也能加后缀', () => {
    const a = reserveDest(dir, 'noext');
    const b = reserveDest(dir, 'noext');
    reserved.push(a, b);
    expect([basename(a), basename(b)]).toEqual(['noext', 'noext (2)']);
  });
});
