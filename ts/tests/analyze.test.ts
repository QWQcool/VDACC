import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildScenes, MIN_SCENE_MS, parseScdet } from '../src/analyze/scenes';
import { frameBudget, LONG_FRAMES, lumaOfGray, planFrames, SHORT_FRAMES } from '../src/analyze/frames';
import { cuesForScenes, loadTranscript, parseLrc, parseSrt } from '../src/analyze/transcript';
import { summarizeFfprobe } from '../src/analyze/metrics';
import { analyzeFile, readVisualsFile } from '../src/analyze';
import { buildDescribePrompt, parseShotDescription } from '../src/analyze/describe';
import { ffmpegBin } from '../src/core/ffmpeg';

describe('分镜：scdet 解析', () => {
  test('配对的 score/time 被识别成切点', () => {
    const out = [
      'frame:10 pts:100 pts_time:1.0',
      'lavfi.scd.mafd=3.2 lavfi.scd.score=12.5 lavfi.scd.time=1.234',
      'frame:20 pts:200 pts_time:2.0',
      'lavfi.scd.mafd=1.0 lavfi.scd.score=30.1 lavfi.scd.time=3.5',
    ].join('\n');
    const cuts = parseScdet(out);
    expect(cuts.length).toBe(2);
    expect(cuts[0]).toEqual({ t_ms: 1234, score: 12.5 });
    expect(cuts[1]).toEqual({ t_ms: 3500, score: 30.1 });
  });

  test('没有 score 时给 0，不编造分数', () => {
    const cuts = parseScdet('lavfi.scd.time=2.000');
    expect(cuts).toEqual([{ t_ms: 2000, score: 0 }]);
  });

  test('空输出与无关日志不产生切点', () => {
    expect(parseScdet('')).toEqual([]);
    expect(parseScdet('frame:1 pts:1 pts_time:0.1')).toEqual([]);
  });
});

describe('分镜：切点拼段', () => {
  test('无切点 → 整段一个镜头', () => {
    const scenes = buildScenes(10_000, []);
    expect(scenes.length).toBe(1);
    expect(scenes[0].start_ms).toBe(0);
    expect(scenes[0].end_ms).toBe(10_000);
  });

  test('切点按时间排成连续段，总长等于片长', () => {
    const scenes = buildScenes(10_000, [
      { t_ms: 5000, score: 20 },
      { t_ms: 2000, score: 15 },
    ]);
    expect(scenes.map((s) => [s.start_ms, s.end_ms])).toEqual([[0, 2000], [2000, 5000], [5000, 10_000]]);
    const total = scenes.reduce((sum, s) => sum + s.duration_ms, 0);
    expect(total).toBe(10_000);
    expect(scenes.every((s) => s.luma === null)).toBe(true);
  });

  test('越界与重复切点被丢掉', () => {
    const scenes = buildScenes(10_000, [
      { t_ms: 0, score: 99 },
      { t_ms: 4000, score: 9 },
      { t_ms: 4000, score: 9 },
      { t_ms: 12_000, score: 9 },
    ]);
    expect(scenes.length).toBe(2);
    expect(scenes[1].start_ms).toBe(4000);
  });

  test('碎段并入上一段，不制造一闪而过的镜头', () => {
    const scenes = buildScenes(10_000, [
      { t_ms: 5000, score: 9 },
      { t_ms: 5100, score: 30 }, // 只有 100ms，小于 MIN_SCENE_MS
    ]);
    // 5000–5100 被并进前一段，所以第二段从 5100 开始，而不是把 100ms 当成一个镜头
    expect(scenes.length).toBe(2);
    expect(scenes[0].end_ms).toBe(5100);
    expect(scenes[1].start_ms).toBe(5100);
    expect(scenes[1].end_ms).toBe(10_000);
    expect(MIN_SCENE_MS).toBeGreaterThan(100);
  });
});

describe('抽帧：预算与选点', () => {
  test('预算边界：30s→30 帧，10min→100 帧，中间线性', () => {
    expect(frameBudget(1000)).toBe(SHORT_FRAMES);
    expect(frameBudget(30_000)).toBe(SHORT_FRAMES);
    expect(frameBudget(315_000)).toBe(Math.round(30 + 0.5 * 70));
    expect(frameBudget(600_000)).toBe(LONG_FRAMES);
    expect(frameBudget(3_600_000)).toBe(LONG_FRAMES);
  });

  test('每镜取中点', () => {
    const scenes = buildScenes(10_000, [{ t_ms: 4000, score: 9 }]);
    const picks = planFrames(scenes, 10_000);
    expect(picks).toEqual([{ t_ms: 2000, scene: 1 }, { t_ms: 7000, scene: 2 }]);
  });

  test('镜头数超预算时均匀抽稀且保留最后一镜', () => {
    const scenes = buildScenes(100_000, Array.from({ length: 99 }, (_, i) => ({
      t_ms: (i + 1) * 1000, score: 9,
    })));
    const picks = planFrames(scenes, 100_000, 5);
    expect(picks.length).toBe(5);
    expect(picks[0].scene).toBe(1);
    expect(picks[picks.length - 1].scene).toBe(scenes[scenes.length - 1].index);
  });

  test('没有分镜时按预算均匀撒点（至少 1 帧）', () => {
    const picks = planFrames([], 10_000, 4);
    expect(picks.map((p) => p.t_ms)).toEqual([1250, 3750, 6250, 8750]);
    expect(planFrames([], 10_000, 0).length).toBe(1);
  });

  test('灰度均值：算不出来返回 null，不填 0', () => {
    expect(lumaOfGray(Buffer.from([0, 0, 255, 255]))).toBe(127.5);
    expect(lumaOfGray(Buffer.alloc(0))).toBeNull();
  });
});

describe('台词：字幕解析', () => {
  const srt = [
    '1',
    '00:00:01,500 --> 00:00:03,200',
    '第一句',
    '',
    '2',
    '00:00:03,200 --> 00:00:05,000',
    '第二句',
    '续行',
  ].join('\n');

  test('SRT 时间与正文', () => {
    const cues = parseSrt(srt);
    expect(cues.length).toBe(2);
    expect(cues[0]).toEqual({ start_ms: 1500, end_ms: 3200, text: '第一句' });
    expect(cues[1].text).toBe('第二句 续行');
  });

  test('LRC 一行多标签、按时间排序', () => {
    const cues = parseLrc('[00:10.00]第二段\n[00:01.50][00:05.00]第一段');
    expect(cues.map((c) => c.start_ms)).toEqual([1500, 5000, 10_000]);
    expect(cues[0].text).toBe('第一段');
  });

  test('逐镜台词按发生顺序拼接，不在本镜的句子不串进来', () => {
    const scenes = buildScenes(10_000, [{ t_ms: 5000, score: 9 }]);
    const cues = parseSrt(srt);
    const texts = cuesForScenes(scenes, cues);
    expect(texts[0].text).toBe('第一句 第二句 续行');
    expect(texts[1].text).toBe('');
  });

  test('没有字幕文件时 loadTranscript 说 none，不抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdacc-sub-'));
    try {
      const video = join(dir, 'a.mp4');
      writeFileSync(video, 'x');
      expect(loadTranscript(video).source).toBe('none');
      writeFileSync(join(dir, 'a.srt'), srt, 'utf8');
      const loaded = loadTranscript(video);
      expect(loaded.source).toBe('srt');
      expect(loaded.cues.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('指标：ffprobe 归一化', () => {
  test('分数帧率真的除出来，码率缺失留 null', () => {
    const metrics = summarizeFfprobe({
      format: { duration: '12.5', size: '1000', bit_rate: '0' },
      streams: [
        { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    });
    expect(metrics).not.toBeNull();
    expect(metrics!.duration_ms).toBe(12_500);
    expect(metrics!.fps).toBe(29.97);
    expect(metrics!.vcodec).toBe('h264');
    expect(metrics!.acodec).toBe('aac');
    expect(metrics!.bitrate).toBeNull();
  });

  test('没有视频轨返回 null', () => {
    expect(summarizeFfprobe({ format: { duration: '1' }, streams: [{ codec_type: 'audio' }] })).toBeNull();
    expect(summarizeFfprobe(null)).toBeNull();
  });
});

describe('A2 逐镜描述：解析与提示词约束（不联网）', () => {
  test('提示词要求只写看得见的、不确定留空、忽略平台水印', () => {
    const prompt = buildDescribePrompt({ index: 3, startMs: 5200, endMs: 7000, subtitle: '你好' });
    expect(prompt).toContain('5.2s–7.0s');
    expect(prompt).toContain('你好');
    expect(prompt).toContain('不确定就留空');
    expect(prompt).toContain('bilibili');   // 明确要求忽略平台角标
    expect(prompt).toContain('不要推测剧情');
  });

  test('吃掉 ```json 围栏与前后解释文字', () => {
    const text = '好的，这是结果：\n```json\n{"shotSize":"中景","subject":"两个人"}\n```\n希望有帮助';
    const visual = parseShotDescription(text);
    expect(visual.shotSize).toBe('中景');
    expect(visual.subject).toBe('两个人');
    expect(visual.setting).toBe('');       // 缺失字段补空串，不是 undefined
  });

  test('非字符串字段归空，不把数字塞进描述', () => {
    const visual = parseShotDescription('{"shotSize":3,"subject":"猫"}');
    expect(visual.shotSize).toBe('');
    expect(visual.subject).toBe('猫');
  });

  test('全字段留空视为失败：不能假装「这一镜什么都没有」', () => {
    expect(() => parseShotDescription('{"shotSize":"","subject":""}')).toThrow();
  });

  test('截断（只有开括号）与完全不返回 JSON 分开报', () => {
    expect(() => parseShotDescription('{"shotSize": "全景", "')).toThrow(/截断/);
    expect(() => parseShotDescription('抱歉我不能描述这张图')).toThrow(/没有返回 JSON/);
  });
});

describe('外部描述文件（Agent/人工写好的语义描述）', () => {
  const write = (body: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'vdacc-visuals-'));
    const file = join(dir, 'visuals.json');
    writeFileSync(file, JSON.stringify(body), 'utf8');
    return file;
  };

  test('镜号键 / 数组 / scenes 包装三种形状都认', () => {
    const viaKeys = readVisualsFile(write({ 1: { shotSize: '中景', subject: '两个人' } }));
    expect(viaKeys.get(1)!.shotSize).toBe('中景');

    const viaArray = readVisualsFile(write([{ index: 2, subject: '猫' }]));
    expect(viaArray.get(2)!.subject).toBe('猫');

    const viaScenes = readVisualsFile(write({ scenes: [{ index: 3, visual: { subject: '舞台' } }] }));
    expect(viaScenes.get(3)!.subject).toBe('舞台');
  });

  test('未知字段被丢掉，全空的记录不当作「描述过」', () => {
    const map = readVisualsFile(write({
      1: { subject: '两个人', camera: '推镜头', confidence: 0.9 },
      2: { shotSize: '', subject: '   ' },
    }));
    expect(map.get(1)).toEqual({
      shotSize: '', subject: '两个人', action: '', setting: '', lighting: '', composition: '', onScreenText: '',
    });
    expect(map.has(2)).toBe(false);
  });

  test('镜号非法或文件坏了都如实报错，不静默', () => {
    const map = readVisualsFile(write({ '0': { subject: 'x' }, abc: { subject: 'y' } }));
    expect(map.size).toBe(0);
    expect(() => readVisualsFile(join(tmpdir(), 'definitely-missing-visuals.json'))).toThrow();
  });
});

describe('端到端：真跑 ffmpeg（没装就跳过）', () => {
  const hasFfmpeg = !!Bun.which(ffmpegBin());
  test.skipIf(!hasFfmpeg)('3 秒测试片：分镜/帧/指标/result.json 都对得上', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdacc-analyze-'));
    try {
      const clip = join(dir, 'clip.mp4');
      const made = Bun.spawn([
        ffmpegBin(), '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=3:size=160x120:rate=10',
        '-pix_fmt', 'yuv420p', clip,
      ], { stdout: 'ignore', stderr: 'pipe', windowsHide: true });
      expect(await made.exited).toBe(0);

      const out = join(dir, 'out');
      const result = await analyzeFile(clip, { outDir: out });
      expect(result.metrics.duration_ms).toBeGreaterThan(2500);
      expect(result.metrics.width).toBe(160);
      expect(result.metrics.height).toBe(120);
      // testsrc 是彩条+计时器，scdet 一般会切出若干段；至少要有 1 段
      expect(result.scenes.length).toBeGreaterThanOrEqual(1);
      expect(result.scenes[0].start_ms).toBe(0);
      expect(result.frames.length).toBeGreaterThanOrEqual(1);
      expect(existsSync(result.frames[0].path)).toBe(true);
      // 亮色测试图不该是纯黑：能算出来就必须大于 0
      expect(result.scenes.some((s) => (s.luma ?? 0) > 0)).toBe(true);
      expect(existsSync(join(out, 'result.json'))).toBe(true);
      expect(result.transcript.source).toBe('none');

      // 同一个成品分析第二次：帧文件已存在，ffmpeg 必须覆盖而不是卡在「要覆盖吗」，
      // 否则亮度全变 null、图片还是上一次的（2026-11-09 浏览器验收踩到的真 bug）
      const again = await analyzeFile(clip, { outDir: out });
      expect(again.frames.length).toBe(result.frames.length);
      expect(again.scenes.some((s) => (s.luma ?? 0) > 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
