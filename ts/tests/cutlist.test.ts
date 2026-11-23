/**
 * 粗剪清单：切点 / 删除段 / EDL 保留段。
 *
 * 全都是纯计算，不碰 ffmpeg 也不碰文件——这样才能把「边界条件」写清楚：
 * 过短的静音不该删、过短的保留缝不该留、时间码不该越界。
 * 真实视频的端到端在 `analyze.test.ts` 里（有 ffmpeg 才跑）。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCutlist, renderCutlistCsv, renderCutlistEdl, timecode } from '../src/analyze/cutlist';
import { analyzeFile } from '../src/analyze';
import { ffmpegBin } from '../src/core/ffmpeg';

import { HAS_FFMPEG } from './env';

const base = (over: any = {}) => ({
  metrics: { fps: 25, duration_ms: 10_000, ...(over.metrics || {}) },
  scenes: over.scenes ?? [
    { index: 1, start_ms: 0, end_ms: 3000 },
    { index: 2, start_ms: 3000, end_ms: 7000 },
    { index: 3, start_ms: 7000, end_ms: 10_000 },
  ],
  audio: over.audio === undefined
    ? { hasTrack: true, silences: [{ start_ms: 2000, end_ms: 4000 }] }
    : over.audio,
});

describe('时间码', () => {
  test('整秒与帧号', () => {
    expect(timecode(0, 25)).toBe('00:00:00:00');
    expect(timecode(1000, 25)).toBe('00:00:01:00');
    expect(timecode(40, 25)).toBe('00:00:00:01');   // 40ms = 1 帧（25fps）
    expect(timecode(1040, 25)).toBe('00:00:01:01');
    expect(timecode(1000, 30)).toBe('00:00:01:00');
  });

  test('进位与非法输入', () => {
    expect(timecode(60_000, 25)).toBe('00:01:00:00');
    expect(timecode(59_960, 25)).toBe('00:00:59:24');  // 1499 帧，差一帧不硬进位
    expect(timecode(3_600_000, 25)).toBe('01:00:00:00');
    expect(timecode(-5, 25)).toBe('00:00:00:00');
    expect(timecode(Number.NaN, 25)).toBe('00:00:00:00');
  });
});

describe('删除段与保留段', () => {
  test('只在够长的静音上动手，两端各留 pad', () => {
    const list = buildCutlist(base() as any);
    expect(list.drops.length).toBe(1);
    expect(list.drops[0].start_ms).toBe(2120);   // 2000 + 默认 pad 120
    expect(list.drops[0].end_ms).toBe(3880);     // 4000 - 120
    expect(list.dropped_ms).toBe(1760);
    expect(list.keeps).toEqual([{ start_ms: 0, end_ms: 2120 }, { start_ms: 3880, end_ms: 10_000 }]);
  });

  test('短静音不删（阈值可调）', () => {
    const audio = { hasTrack: true, silences: [{ start_ms: 1000, end_ms: 1600 }] };  // 600ms
    const byDefault = buildCutlist(base({ audio }) as any);
    expect(byDefault.drops).toEqual([]);
    expect(byDefault.keeps).toEqual([{ start_ms: 0, end_ms: 10_000 }]);

    const loose = buildCutlist(base({ audio }) as any, { minSilenceMs: 300, padMs: 0 });
    expect(loose.drops.length).toBe(1);
  });

  test('两段静音之间的短保留缝被合并（否则 EDL 全是碎片）', () => {
    const audio = {
      hasTrack: true,
      silences: [{ start_ms: 1000, end_ms: 2000 }, { start_ms: 2050, end_ms: 3000 }],
    };
    // minSilence 放到 300：两段（1000ms / 950ms）都算「够长」，才能测到合并
    const list = buildCutlist(base({ audio }) as any, { padMs: 0, minKeepMs: 200, minSilenceMs: 300 });
    expect(list.drops.length).toBe(1);
    expect(list.drops[0]).toEqual({ start_ms: 1000, end_ms: 3000, reason: expect.stringContaining('过短缝') });
  });

  test('没有音轨时只给切点，不删任何东西，并说明原因', () => {
    const list = buildCutlist(base({ audio: { hasTrack: false, silences: [] } }) as any);
    expect(list.drops).toEqual([]);
    expect(list.keeps).toEqual([{ start_ms: 0, end_ms: 10_000 }]);
    expect(list.warnings.join()).toContain('没有音轨');
  });

  test('非整数 fps 会在 warnings 里说明按整帧近似', () => {
    const list = buildCutlist(base({ metrics: { fps: 29.97, duration_ms: 10_000 } }) as any);
    expect(list.fps).toBe(30);
    expect(list.warnings.join()).toContain('29.97');
  });

  test('切点包含镜头边界（跳过 0）与删除段两端', () => {
    const list = buildCutlist(base() as any);
    const kinds = list.cuts.map((c) => c.kind);
    expect(list.cuts.filter((c) => c.kind === 'scene').map((c) => c.at_ms)).toEqual([3000, 7000]);
    expect(kinds).toContain('silence-in');
    expect(kinds).toContain('silence-out');
    // 有序
    const at = list.cuts.map((c) => c.at_ms);
    expect(at).toEqual(at.slice().sort((a, b) => a - b));
  });
});

describe('产物格式', () => {
  const list = buildCutlist(base() as any);

  test('CSV：表头 + 每行 8 列，含逗号/引号的理由要转义', () => {
    const csv = renderCutlistCsv(list);
    const rows = csv.trim().split('\n');
    expect(rows[0]).toBe('type,action,start_tc,end_tc,start_ms,end_ms,scene,reason');
    for (const row of rows.slice(1)) {
      // 简单断言列数：转义后仍应是 8 段（理由里的逗号在引号内）
      expect(row.split(',').length).toBeGreaterThanOrEqual(8);
    }
    // 2120ms@25 = 53 帧 = 00:00:02:03；3880ms@25 = 97 帧 = 00:00:03:22
    expect(csv).toContain('silence,drop,00:00:02:03,00:00:03:22,2120,3880,,静音 2.0s');

    // 理由里出现逗号与引号时必须整体加引号、内部引号翻倍（Excel 的规矩）
    const escaped = renderCutlistCsv({
      fps: 25, total_ms: 1000, cuts: [], keeps: [], dropped_ms: 500, warnings: [],
      drops: [{ start_ms: 0, end_ms: 500, reason: '静音, 0.5s "长"' }],
    });
    expect(escaped).toContain('"静音, 0.5s ""长"""');
  });

  test('EDL：标题、FCM、事件数与保留段一致，记录时间连续', () => {
    const edl = renderCutlistEdl(list, '测试片');
    const lines = edl.split('\n');
    expect(lines[0]).toBe('TITLE: 测试片');
    expect(lines[1]).toBe('FCM: NON-DROP FRAME');
    const events = lines.filter((l) => /^\d{3}  AX/.test(l));
    expect(events.length).toBe(2);
    // 第一段：源 0→2120，记录也从 0 开始
    expect(events[0]).toContain('00:00:00:00 00:00:02:03 00:00:00:00 00:00:02:03');
    // 第二段接在 2120ms 之后（记录端不从 0 重新开始）
    expect(events[1]).toContain('00:00:03:22 00:00:10:00 00:00:02:03');
  });

  test('EDL 标题里的换行被压平，避免生成非法文件', () => {
    const edl = renderCutlistEdl(list, 'a\nb');
    expect(edl.split('\n')[0]).toBe('TITLE: a b');
  });
});

describe('端到端：真跑 ffmpeg（没装就跳过）', () => {
  test.skipIf(!HAS_FFMPEG)('中间 3 秒静音的片子：落盘 cutlist.csv/edl，并真的删掉那段', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdacc-cutlist-'));
    try {
      const clip = join(dir, 'silence.mp4');
      const made = Bun.spawn([
        ffmpegBin(), '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=8:size=160x120:rate=10',
        // 2–5s 静音，其余是 440Hz 正弦：只有静音段该被删
        '-f', 'lavfi', '-i',
        'aevalsrc=if(between(t\\,2\\,5)\\,0\\,0.4*sin(2*PI*440*t)):s=44100:d=8',
        '-shortest', '-pix_fmt', 'yuv420p', clip,
      ], { stdout: 'ignore', stderr: 'pipe', windowsHide: true });
      expect(await made.exited).toBe(0);

      const out = join(dir, 'out');
      const result = await analyzeFile(clip, { outDir: out, cutlist: true });
      expect(result.cutlist).toBeDefined();
      expect(result.cutlist!.drops).toBeGreaterThanOrEqual(1);
      expect(result.cutlist!.dropped_ms).toBeGreaterThan(1000);
      expect(result.cutlist!.keeps).toBeGreaterThanOrEqual(2);

      expect(existsSync(result.cutlist!.files.csv)).toBe(true);
      expect(existsSync(result.cutlist!.files.edl)).toBe(true);
      const csv = readFileSync(result.cutlist!.files.csv, 'utf8');
      expect(csv.startsWith('\uFEFF')).toBe(true);      // Excel 打开不乱码
      expect(csv).toContain('silence,drop');
      const edl = readFileSync(result.cutlist!.files.edl, 'utf8');
      expect(edl).toContain('FCM: NON-DROP FRAME');
      expect(edl).toMatch(/001  AX {2,}V {2,}C/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
