/**
 * 本地语音识别（可选能力）的适配层。
 *
 * 不下载模型、也不假设机器上装了 whisper.cpp：
 * - 探测逻辑（找 bin / 找 ggml 模型）：用注入的 which/exists 测；
 * - 转写流程：用注入的 ffmpeg/exec 造假产物，验证「抽音轨 → 跑工具 → 读 .srt → 清 wav」；
 * - 失败路径：没装工具、工具没产出 srt，都要给出**可执行**的错误而不是空结果。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAsrArgs, findAsr, guessModel, transcribe } from '../src/analyze/asr';

const SRT = [
  '1',
  '00:00:00,500 --> 00:00:02,000',
  '第一句',
  '',
  '2',
  '00:00:02,100 --> 00:00:04,000',
  '第二句',
  '',
].join('\n');

describe('找工具与模型', () => {
  test('优先 ggml-*.bin', () => {
    const guess = guessModel('/x', () => ['readme.txt', 'other.bin', 'ggml-small.bin']);
    expect(guess.endsWith('ggml-small.bin')).toBe(true);
    expect(guessModel('/x', () => ['readme.txt'])).toBe('');
  });

  test('环境变量给全了就用它；文件不存在则视为没有', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdacc-asr-'));
    try {
      const bin = join(dir, 'whisper-cli.exe');
      const model = join(dir, 'ggml-tiny.bin');
      writeFileSync(bin, 'x');
      writeFileSync(model, 'x');
      const env = { VDACC_WHISPER_BIN: bin, VDACC_WHISPER_MODEL: model } as NodeJS.ProcessEnv;
      expect(findAsr(env)).toEqual({ bin, model });

      const missing = { VDACC_WHISPER_BIN: join(dir, 'nope.exe'), VDACC_WHISPER_MODEL: model } as NodeJS.ProcessEnv;
      expect(findAsr(missing)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('没设环境变量时按 PATH 找，找不到就是 null（不猜）', () => {
    const none = {
      which: () => null,
      exists: () => false,
    } as any;
    expect(findAsr({} as NodeJS.ProcessEnv, none)).toBeNull();
  });

  test('bin 在 PATH 里、模型在同目录 models/ 下也能配上', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdacc-asr-'));
    try {
      const bin = join(dir, 'main.exe');
      writeFileSync(bin, 'x');
      writeFileSync(join(dir, 'ggml-base.bin'), 'x');
      const deps = { which: () => bin, exists: (p: string) => existsSync(p) } as any;
      const cfg = findAsr({} as NodeJS.ProcessEnv, deps);
      expect(cfg?.bin).toBe(bin);
      expect(cfg?.model.endsWith('ggml-base.bin')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('参数与转写', () => {
  const cfg = { bin: 'whisper-cli', model: 'ggml-tiny.bin' };

  test('whisper.cpp 的参数形状（-osrt 才会产出 .srt）', () => {
    const args = buildAsrArgs(cfg, 'a.wav', 'out/asr', 'zh');
    expect(args).toContain('-osrt');
    expect(args[args.indexOf('-m') + 1]).toBe('ggml-tiny.bin');
    expect(args[args.indexOf('-f') + 1]).toBe('a.wav');
    expect(args[args.indexOf('-l') + 1]).toBe('zh');
    expect(args[args.indexOf('-of') + 1]).toBe('out/asr');
    // 不给语言就是 auto，而不是瞎猜 zh
    expect(buildAsrArgs(cfg, 'a.wav', 'p')!.includes('auto')).toBe(true);
  });

  test('抽音轨 → 跑工具 → 解析 srt → 删掉中间 wav', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdacc-asr-'));
    try {
      const calls: string[][] = [];
      const deps = {
        ffmpeg: async (_args: string[]) => ({ code: 0, stdout: '', stderr: '' }),
        exec: async (_bin: string, args: string[]) => {
          calls.push(args);
          const prefix = args[args.indexOf('-of') + 1];
          writeFileSync(`${prefix}.srt`, SRT, 'utf8');
          return { code: 0, stdout: '', stderr: '' };
        },
        which: () => null,
        exists: (p: string) => existsSync(p),
      } as any;

      const out = await transcribe('movie.mp4', dir, { config: cfg, language: 'zh' }, deps);
      expect(out.cues.length).toBe(2);
      expect(out.cues[0].text).toBe('第一句');
      expect(out.cues[1].start_ms).toBe(2100);
      expect(out.engine).toBe('whisper.cpp');
      expect(existsSync(join(dir, 'asr-16k.wav'))).toBe(false);   // 中间产物必须清掉
      expect(calls.length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('工具没产出 srt 时明确失败（不返回空台词冒充成功）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdacc-asr-'));
    try {
      const deps = {
        ffmpeg: async () => ({ code: 0, stdout: '', stderr: '' }),
        exec: async () => ({ code: 0, stdout: '', stderr: 'model load failed' }),
        which: () => null,
        exists: () => false,
      } as any;
      await expect(transcribe('m.mp4', dir, { config: cfg }, deps)).rejects.toThrow(/语音识别失败/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('没装工具时报 asr_unavailable 并给安装指引', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdacc-asr-'));
    try {
      const deps = { which: () => null, exists: () => false } as any;
      await expect(transcribe('m.mp4', dir, {}, deps)).rejects.toThrow(/whisper\.cpp/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
