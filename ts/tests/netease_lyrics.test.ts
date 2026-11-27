/**
 * 网易云歌词落盘（`--lyrics` / `--lyrics-translate`）。
 *
 * 纯离线：`writeLyrics` 接受注入的 fetch，用例直接喂接口的 JSON 形状。
 * 真实接口形状（2026-11-27 实测 id=1989750731）：`{ code:200, lrc:{lyric}, tlyric:{lyric}, klyric:{...} }`。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lyricsPaths, writeLyrics } from '../src/engines/netease';

const LRC = '[00:00.000] 作词 : 某人\n[00:13.650] 看，那片星光在闪耀\n[01:41.310] 而去吧';
const ZH = '[00:13.650] Look, the starlight is shining';

const fake = (body: any) => (async () => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
})) as unknown as typeof fetch;

const withTmp = async (fn: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'vdacc-lyrics-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('lyricsPaths', () => {
  test('与音频同名，翻译用 .zh.lrc；没有扩展名也成立', () => {
    expect(lyricsPaths('a/b/空梦_无损 FLAC.flac')).toEqual({
      lrc: 'a/b/空梦_无损 FLAC.lrc',
      translation: 'a/b/空梦_无损 FLAC.zh.lrc',
    });
    expect(lyricsPaths('a/b/空梦').lrc).toBe('a/b/空梦.lrc');
  });
});

describe('writeLyrics', () => {
  test('原文与翻译都落盘，末尾补换行', async () => {
    await withTmp(async (dir) => {
      const base = join(dir, 'YΩkønϲy - 空梦');
      const out = await writeLyrics(base, '1989750731', { translateLyrics: true },
        fake({ code: 200, lrc: { lyric: LRC }, tlyric: { lyric: ZH } }));

      expect(out.warnings).toEqual([]);
      expect(out.files).toEqual([`${base}.lrc`, `${base}.zh.lrc`]);
      expect(readFileSync(`${base}.lrc`, 'utf8')).toBe(`${LRC}\n`);
      expect(readFileSync(`${base}.zh.lrc`, 'utf8')).toBe(`${ZH}\n`);
      // 时间轴必须原样保留
      expect(readFileSync(`${base}.lrc`, 'utf8')).toContain('[01:41.310]');
    });
  });

  test('翻译为空时不写空文件（空 .zh.lrc 会让播放器显示空白）', async () => {
    await withTmp(async (dir) => {
      const base = join(dir, 'song');
      const out = await writeLyrics(base, '1', { translateLyrics: true },
        fake({ code: 200, lrc: { lyric: LRC }, tlyric: { lyric: '   ' } }));

      expect(out.files).toEqual([`${base}.lrc`]);
      expect(out.warnings.join('')).toContain('没有翻译歌词');
      expect(existsSync(`${base}.zh.lrc`)).toBe(false);
    });
  });

  test('整首没有歌词时给 warning，而不是抛给上层炸掉下载', async () => {
    await withTmp(async (dir) => {
      const out = await writeLyrics(join(dir, 'x'), '1', {}, fake({ code: 200, lrc: { lyric: '' } }));
      expect(out.files).toEqual([]);
      expect(out.warnings.join('')).toContain('没有歌词');
    });
  });

  test('接口失败只记 warning，不影响调用方', async () => {
    await withTmp(async (dir) => {
      const boom = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
      const out = await writeLyrics(join(dir, 'x'), '1', {}, boom);
      expect(out.files).toEqual([]);
      expect(out.warnings.join('')).toContain('歌词获取失败');
    });
  });
});
