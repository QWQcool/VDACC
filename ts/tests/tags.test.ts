/**
 * ID3v2 解析（`core/tags.ts`）。
 *
 * 用途：酷我的元数据接口大面积失败时，标题/歌手只能靠**文件自带的 ID3**。
 * 这里用合成帧覆盖三种编码与三个版本，避免「只有 latin1 能读」这类半吊子实现。
 */
import { describe, expect, test } from 'bun:test';

import { readId3v2 } from '../src/core/tags';

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const syncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];

function frame(version: number, id: string, encoding: number, text: Uint8Array): Uint8Array {
  const body = concat([new Uint8Array([encoding]), text]);
  const head = new Uint8Array(10);
  for (let i = 0; i < 4; i += 1) head[i] = id.charCodeAt(i);
  if (version === 4) {
    head.set(syncsafe(body.length), 4);
  } else {
    head[4] = (body.length >>> 24) & 0xff;
    head[5] = (body.length >>> 16) & 0xff;
    head[6] = (body.length >>> 8) & 0xff;
    head[7] = body.length & 0xff;
  }
  return concat([head, body]);
}

function id3(version: number, frames: Uint8Array[]): Uint8Array {
  const body = concat(frames);
  const head = new Uint8Array(10);
  head[0] = 0x49; head[1] = 0x44; head[2] = 0x33; // "ID3"
  head[3] = version;
  head.set(syncsafe(body.length), 6);
  return concat([head, body]);
}

const latin1 = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));
const utf8 = (text: string) => new TextEncoder().encode(text);
function utf16leWithBom(text: string): Uint8Array {
  const out: number[] = [0xff, 0xfe];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out.push(code & 0xff, (code >> 8) & 0xff);
  }
  return new Uint8Array(out);
}

describe('readId3v2', () => {
  test('v2.3 latin1', () => {
    const buf = id3(3, [frame(3, 'TIT2', 0, latin1('Hello'))]);
    expect(readId3v2(buf).title).toBe('Hello');
  });

  test('v2.3 UTF-16（带 BOM，中文）', () => {
    const buf = id3(3, [
      frame(3, 'TIT2', 1, utf16leWithBom('花海')),
      frame(3, 'TPE1', 1, utf16leWithBom('周杰伦')),
    ]);
    const tags = readId3v2(buf);
    expect(tags.title).toBe('花海');
    expect(tags.artist).toBe('周杰伦');
  });

  test('v2.4 UTF-8 + 专辑', () => {
    const buf = id3(4, [
      frame(4, 'TIT2', 3, utf8('雨爱(钢琴版)')),
      frame(4, 'TPE1', 3, utf8('Ben George')),
      frame(4, 'TALB', 3, utf8('钢琴翻奏')),
    ]);
    const tags = readId3v2(buf);
    expect(tags.title).toBe('雨爱(钢琴版)');
    expect(tags.artist).toBe('Ben George');
    expect(tags.album).toBe('钢琴翻奏');
  });

  test('不是 ID3（裸 mp3 帧）→ 空对象，不抛', () => {
    expect(readId3v2(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toEqual({});
  });

  test('声明长度大于实际内容：不越界，能读到的就返回', () => {
    const full = id3(3, [frame(3, 'TIT2', 0, latin1('Cut'))]);
    const cut = full.subarray(0, 12); // 头部完整，帧体不全
    expect(() => readId3v2(cut)).not.toThrow();
    expect(readId3v2(cut).title).toBeUndefined();
  });

  test('未知帧被跳过，不影响已知帧', () => {
    const buf = id3(3, [
      frame(3, 'TXXX', 0, latin1('whatever')),
      frame(3, 'TIT2', 0, latin1('Title')),
    ]);
    expect(readId3v2(buf).title).toBe('Title');
  });
});
