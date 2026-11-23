/**
 * 本地语音识别（可选能力）：没有字幕的视频也能出台词。
 *
 * 为什么是「适配器」而不是内建模型：
 * - 模型动辄几十到几百 MB，塞进 exe 会让 110 MB 再翻一倍；
 * - 各家机器上跑得动的东西不一样（whisper.cpp / whisper-cli / 自编译版本）。
 *
 * 所以这里只做三件事：**找到工具 → 抽出 16k 单声道 wav → 跑它并读回 .srt**。
 * 找不到就如实说「没装」，不猜、不静默降级（上游会把它记进 warnings）。
 *
 * 约定（可用环境变量覆盖）：
 *   VDACC_WHISPER_BIN    whisper.cpp 的可执行文件（默认在 PATH 里找 whisper-cli/whisper/main）
 *   VDACC_WHISPER_MODEL  ggml 模型（默认取可执行文件同目录、或 models/ 下的 ggml-*.bin）
 */
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { VdlError } from '../core/errors';
import { exec as realExec, ffmpeg as realFfmpeg } from './proc';
import { parseSrt, type Cue } from './transcript';

export interface AsrConfig {
  bin: string;
  model: string;
}

export interface AsrResult {
  cues: Cue[];
  engine: string;
  model: string;
  srt: string;
}

export interface AsrDeps {
  exec: typeof realExec;
  ffmpeg: typeof realFfmpeg;
  which: (name: string) => string | null;
  exists: (path: string) => boolean;
}

export interface AsrOptions {
  /** 语言代码，默认 `auto`（whisper.cpp 自己判） */
  language?: string;
  timeoutMs?: number;
  /** 显式指定工具组合（测试或调用方自己探测过时用） */
  config?: AsrConfig;
}

const DEFAULTS: AsrDeps = {
  exec: realExec,
  ffmpeg: realFfmpeg,
  which: (name) => Bun.which(name),
  exists: (path) => existsSync(path),
};

/** 在目录里找 ggml 模型：优先 `ggml-*.bin`，其次任意 `.bin`。 */
export function guessModel(dir: string, list: (d: string) => string[] = (d) => {
  try { return readdirSync(d); } catch { return []; }
}): string {
  const files = list(dir).filter((f) => f.toLowerCase().endsWith('.bin'));
  if (!files.length) return '';
  const ggml = files.filter((f) => /^ggml-.*\.bin$/i.test(f));
  return join(dir, (ggml[0] || files[0]));
}

/** 找到可用组合；任何一个缺了都返回 null（上游据此给出「没装」的提示）。 */
export function findAsr(env: NodeJS.ProcessEnv = process.env, deps: AsrDeps = DEFAULTS): AsrConfig | null {
  const envBin = (env.VDACC_WHISPER_BIN || '').trim();
  const bin = envBin || deps.which('whisper-cli') || deps.which('whisper') || deps.which('main') || '';
  if (!bin || !deps.exists(bin)) return null;

  const envModel = (env.VDACC_WHISPER_MODEL || '').trim();
  const candidates = envModel
    ? [envModel]
    : [guessModel(dirname(bin)), guessModel(join(dirname(bin), 'models'))].filter(Boolean);
  const model = candidates.find((p) => deps.exists(p)) || '';
  return model ? { bin, model } : null;
}

/** whisper.cpp 的参数。`-osrt` 让它把结果写成 `<of>.srt`，我们只读这一种。 */
export function buildAsrArgs(cfg: AsrConfig, wav: string, outPrefix: string, language = 'auto'): string[] {
  return [
    '-m', cfg.model,
    '-f', wav,
    '-l', language || 'auto',
    '-osrt',
    '-of', outPrefix,
  ];
}

/**
 * 跑一次转写。抽音轨用 ffmpeg（16k/单声道/pcm_s16le 是 whisper 唯一接受的形状），
 * 跑完把中间 wav 删掉——16k 单声道一分钟也有一两 MB，不该留在产物目录里。
 */
export async function transcribe(
  video: string,
  outDir: string,
  opts: AsrOptions = {},
  provided: Partial<AsrDeps> = {},
): Promise<AsrResult> {
  const deps: AsrDeps = { ...DEFAULTS, ...provided };
  const cfg = opts.config || findAsr(process.env, deps);
  if (!cfg) {
    throw new VdlError('asr_unavailable',
      '没有找到 whisper.cpp（需要可执行文件 + ggml 模型）',
      '设置 VDACC_WHISPER_BIN / VDACC_WHISPER_MODEL，或把 whisper-cli 放进 PATH');
  }

  const wav = join(outDir, 'asr-16k.wav');
  const prefix = join(outDir, 'asr');
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  try {
    const cut = await deps.ffmpeg(['-y', '-i', video, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], timeout);
    if (cut.code !== 0) {
      throw new VdlError('asr_audio_failed', `抽音轨失败：${cut.stderr.trim().slice(-200) || `退出码 ${cut.code}`}`);
    }
    const run = await deps.exec(cfg.bin, buildAsrArgs(cfg, wav, prefix, opts.language), timeout);
    const srt = `${prefix}.srt`;
    if (run.code !== 0 || !deps.exists(srt)) {
      throw new VdlError('asr_failed',
        `语音识别失败：${run.stderr.trim().slice(-200) || `退出码 ${run.code}`}`,
        '确认模型文件与可执行文件匹配（whisper.cpp 的模型格式是 ggml-*.bin）');
    }
    const cues = parseSrt(readFileSync(srt, 'utf8'));
    return { cues, engine: 'whisper.cpp', model: cfg.model, srt };
  } finally {
    try { unlinkSync(wav); } catch { /* 没生成就算了 */ }
  }
}
