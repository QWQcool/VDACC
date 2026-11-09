/**
 * A1：本地视频 → 分镜 + 帧 + 台词 + 客观指标。
 *
 * 这一版**刻意不接任何模型**（没有 VLM、没有 H3）：`docs/style-transfer-plan.md`
 * 的 A2–A5 依赖 H3 通道才能验收，通道不在就先做确定性这一层——
 * 分镜/帧/台词/指标本身就可独立使用，也不会给下载器引入模型依赖。
 *
 * 产物落在 `下载/_analysis/<文件名>/`（已被 .gitignore 覆盖）：
 *   result.json        本轮全部结果（契约见下）
 *   frame-001.jpg…     抽出来的帧（给人看，也给将来的 VLM 用）
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { VdlError } from '../core/errors';
import { exec, ffmpeg, ffprobeBin } from './proc';
import { buildScenes, parseScdet, type Scene } from './scenes';
import { lumaOfGray, planFrames } from './frames';
import { cuesForScenes, loadTranscript, type Transcript } from './transcript';
import { summarizeFfprobe, type VideoMetrics } from './metrics';
import { describeShot, EMPTY_VISUAL, VISUAL_FIELDS, type ShotVisual } from './describe';
import { apiKey, VlmError } from './vlm';

export interface AnalyzeOptions {
  /** 产物目录；默认 `下载/_analysis/<文件名>` */
  outDir?: string;
  /** 覆盖帧预算（调试/省钱用） */
  maxFrames?: number;
  /** scdet 阈值 0-100，越大切得越少 */
  threshold?: number;
  /** 只出分镜，不抽帧（省时间与磁盘） */
  scenesOnly?: boolean;
  /** A2：对每一帧调视觉模型做语义描述（花 API 额度，默认关闭） */
  describe?: boolean;
  /** 只描述前 N 镜（试跑/省钱用） */
  maxDescribe?: number;
  /**
   * 外部提供的语义描述（JSON 文件）。格式三选一：
   *   `{ "1": {shotSize…}, "2": … }` / `[{ "index": 1, … }]` / `{ "scenes": [{ "index": 1, "visual": {…} }] }`
   * 用途：让 Agent（或人）逐帧看完再写进来，不花 API 额度，也不破坏 `result.json` 的契约。
   */
  visuals?: string;
}

export interface AnalyzedScene extends Scene {
  /** 该镜台词（字幕重叠最多的几条，没有字幕就是空串） */
  text: string;
  /** A2 语义描述；没跑或这一镜失败时为 undefined（不写空对象冒充） */
  visual?: ShotVisual;
}

export interface DescribeInfo {
  /** 实际使用的模型 id；没跑（或描述来自文件）为 null */
  model: string | null;
  /** 成功描述的镜头数 */
  shots: number;
  /** 失败镜头数（逐条原因进 warnings） */
  failed: number;
  tokens: number;
  /** 描述来源：model=调用视觉模型，file=外部 JSON（Agent/人工），mixed=两者都有 */
  source?: 'model' | 'file' | 'mixed';
  /** 整体没跑起来的原因（没有 key / 模型不认图…） */
  reason?: string;
}

export interface AnalysisResult {
  schema: 1;
  ok: true;
  source: { path: string; bytes: number };
  outDir: string;
  metrics: VideoMetrics;
  scenes: AnalyzedScene[];
  frames: Array<{ scene: number; t_ms: number; path: string }>;
  transcript: { source: Transcript['source']; cues: number; file?: string };
  /** A2 的汇总；没请求 `describe` 时不存在这个键（不用空对象冒充「跑过了」） */
  describe?: DescribeInfo;
  warnings: string[];
}

/** 一帧要两张产物：JPEG（人看）+ 16×16 灰度（算亮度），一次 ffmpeg 出两个输出。 */
async function shot(video: string, tMs: number, jpg: string): Promise<Buffer> {
  const seconds = (tMs / 1000).toFixed(3);
  const res = await ffmpeg([
    // `-y` 不能省：同一成品分析第二次时帧文件已存在，ffmpeg 会在 stdin 上问「覆盖吗」，
    // 而我们是把它当子进程跑的、没人回答 → 退出码非 0、stdout 空 → 亮度全部变 null，
    // 图片还留着上一次的（看起来正常，其实是旧的）。2026-11-09 浏览器验收踩到。
    '-y',
    '-ss', seconds, '-i', video, '-frames:v', '1', '-q:v', '3', jpg,
    '-ss', seconds, '-i', video, '-frames:v', '1',
    '-vf', 'scale=16:16', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
  ], 60_000);
  if (res.code === -2) throw new VdlError('ffmpeg_missing', '找不到 ffmpeg，无法抽帧');
  // 灰度取不到就返回空 Buffer（亮度留 null），但不能因为「算不出亮度」让整次分析失败
  return res.code === 0 ? res.stdout : Buffer.alloc(0);
}

/**
 * 外部描述文件 → 每镜 visual。
 *
 * 为什么要有这条路：逐帧看画面的工作不一定要花 API 额度——Agent 自己能读图，
 * 人也能填。但结果必须落回**同一个契约**（`scenes[].visual`），否则界面与下游
 * 又要多一套读取逻辑。三种常见形状都吃，字段按 `VISUAL_FIELDS` 收窄，
 * 认不出的键不会混进结果。
 */
export function readVisualsFile(file: string): Map<number, ShotVisual> {
  let json: any;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new VdlError('bad_input', `读不了描述文件 ${file}：${(err as Error).message}`);
  }

  const normalize = (raw: any): ShotVisual | null => {
    if (!raw || typeof raw !== 'object') return null;
    const out = { ...EMPTY_VISUAL };
    let filled = false;
    for (const key of VISUAL_FIELDS) {
      const value = raw[key];
      if (typeof value === 'string' && value.trim()) {
        out[key] = value.trim();
        filled = true;
      }
    }
    return filled ? out : null;
  };

  const map = new Map<number, ShotVisual>();
  const put = (index: any, value: any) => {
    const at = Number(index);
    if (!Number.isInteger(at) || at <= 0) return;
    const visual = normalize(value && typeof value === 'object' && 'visual' in value ? value.visual : value);
    if (visual) map.set(at, visual);
  };

  if (Array.isArray(json)) {
    for (const item of json) put(item?.index, item);
  } else if (Array.isArray(json?.scenes)) {
    for (const item of json.scenes) put(item?.index, item?.visual);
  } else if (json && typeof json === 'object') {
    for (const [key, value] of Object.entries(json)) put(key, value);
  }
  return map;
}

/**
 * 逐帧调视觉模型。
 *
 * 串行而不是并发：一帧 2–5 秒，串行能给出稳定顺序与可预测的花费；
 * 并发既可能撞上未公开的限流，也会让 `result.json` 里的镜序变得不可复现。
 * 单镜失败只记一笔，不推翻整次分析——描述是附加信息，不是主产物。
 */
async function describeFrames(
  frames: AnalysisResult['frames'],
  scenes: AnalyzedScene[],
  warnings: string[],
  maxDescribe?: number,
): Promise<DescribeInfo> {
  if (!apiKey()) {
    warnings.push('没有配 DEEPSEEK_API_KEY：跳过语义描述（其余结果不受影响）');
    return { model: null, shots: 0, failed: 0, tokens: 0, reason: 'no_api_key' };
  }

  const targets = maxDescribe && maxDescribe > 0 ? frames.slice(0, maxDescribe) : frames;
  let model: string | null = null;
  let shots = 0;
  let failed = 0;
  let tokens = 0;
  const errors: string[] = [];

  for (const frame of targets) {
    const scene = scenes.find((s) => s.index === frame.scene);
    if (!scene) continue;
    try {
      const out = await describeShot(frame.path, {
        index: scene.index,
        startMs: scene.start_ms,
        endMs: scene.end_ms,
        subtitle: scene.text,
      });
      scene.visual = out.visual;
      model = out.model;
      tokens += out.tokens;
      shots += 1;
    } catch (err) {
      failed += 1;
      const code = err instanceof VlmError ? err.code : 'vlm_error';
      const message = (err as Error).message;
      // 整批不可用（没 key / 401 / 402 欠费）：后面的不用再试，省时间也省日志
      if (shots === 0 && ['no_api_key', 'http_401', 'http_402'].includes(code)) {
        warnings.push(`语义描述整体不可用（${message}），其余结果不受影响`);
        return { model: null, shots: 0, failed, tokens, reason: code };
      }
      if (errors.length < 3) errors.push(`镜 ${scene.index}: ${message}`);
    }
  }

  if (failed) warnings.push(`${failed}/${targets.length} 镜没描述成功：${errors.join('；')}`);
  return {
    model, shots, failed, tokens, source: 'model',
    ...(shots === 0 ? { reason: 'all_failed' } : {}),
  };
}

export async function analyzeFile(file: string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const target = resolve(file);
  if (!existsSync(target)) throw new VdlError('not_found', `找不到文件：${file}`);
  const stat = statSync(target);
  if (!stat.isFile()) throw new VdlError('bad_input', `不是文件：${file}`);

  const warnings: string[] = [];

  // 1) ffprobe：拿片长/分辨率/编码。分析的一切时间轴都以它为准。
  const probe = await exec(ffprobeBin(), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', target,
  ], 60_000);
  if (probe.code === -2) {
    throw new VdlError('ffmpeg_missing', '找不到 ffprobe（与 ffmpeg 同目录，或用 VDL_FFPROBE 指定）');
  }
  if (probe.code !== 0) {
    throw new VdlError('ffprobe_failed', `ffprobe 读不了这个文件：${probe.stderr.trim().slice(0, 300)}`);
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(probe.stdout.toString('utf8'));
  } catch {
    throw new VdlError('ffprobe_failed', 'ffprobe 返回的不是 JSON');
  }
  const metrics = summarizeFfprobe(parsed);
  if (!metrics || !metrics.duration_ms) {
    throw new VdlError('bad_input', '这个文件没有视频轨或没有时长，没法分镜');
  }

  // 2) scdet：切点。阈值调高会少切，但不影响后面抽帧的确定性。
  const threshold = Math.min(100, Math.max(1, Number(options.threshold ?? 10)));
  const detect = await ffmpeg([
    '-i', target, '-vf', `scdet=threshold=${threshold},metadata=print:file=-`,
    '-f', 'null', '-',
  ], 30 * 60_000);
  if (detect.code === -2) throw new VdlError('ffmpeg_missing', '找不到 ffmpeg，无法分镜');
  if (detect.code !== 0) {
    // 分镜失败不等于文件坏了：仍然可以均匀抽帧，但必须说出来
    warnings.push(`场景检测没跑成功（ffmpeg code=${detect.code}），本次按均匀采样出帧`);
  }
  const cuts = detect.code === 0 ? parseScdet(detect.stdout.toString('utf8')) : [];
  const scenes = buildScenes(metrics.duration_ms, cuts);
  if (!cuts.length && detect.code === 0) {
    warnings.push('没有检测到镜头切换（可能是单镜头视频，或阈值偏高）');
  }

  // 3) 台词：优先用下载时同名的 .srt/.lrc，没有就如实说没有
  const transcript = loadTranscript(target);
  if (transcript.source === 'none') {
    warnings.push('没有找到同名 .srt/.lrc：本次不提供台词（不猜、不调语音识别）');
  }
  const texts = cuesForScenes(scenes, transcript.cues);

  // 4) 抽帧（可选）
  const outDir = resolve(options.outDir
    || join('下载', '_analysis', basename(target).replace(/\.[^.]+$/, '')));
  mkdirSync(outDir, { recursive: true });

  const frames: AnalysisResult['frames'] = [];
  if (!options.scenesOnly) {
    const picks = planFrames(scenes, metrics.duration_ms, options.maxFrames);
    for (const [i, pick] of picks.entries()) {
      const name = `frame-${String(i + 1).padStart(3, '0')}.jpg`;
      const jpg = join(outDir, name);
      const gray = await shot(target, pick.t_ms, jpg);
      frames.push({ scene: pick.scene, t_ms: pick.t_ms, path: jpg });
      const scene = scenes.find((s) => s.index === pick.scene);
      if (scene) scene.luma = lumaOfGray(gray);
    }
  }

  const analyzedScenes: AnalyzedScene[] = scenes.map((s) => ({
    ...s,
    text: texts.find((t) => t.index === s.index)?.text || '',
  }));

  // 5) A2 语义描述：要么逐帧问视觉模型（花额度），要么读外部描述文件（Agent/人工）
  let describeInfo: DescribeInfo | undefined = options.describe
    ? await describeFrames(frames, analyzedScenes, warnings, options.maxDescribe)
    : undefined;

  /*
   * 描述文件的两条来源：
   * - `--visuals` 显式指定（Agent/人工写好的）；
   * - 没指定、也没要求调模型时，读上一次留下的 `<outDir>/visuals.json`。
   *   没有这一条，界面里点一次「分析」就会把之前合并好的描述冲掉（重新分析=重写 result.json）。
   */
  const snapshot = join(outDir, 'visuals.json');
  const visualsPath = options.visuals
    || (!options.describe && existsSync(snapshot) ? snapshot : '');

  if (visualsPath) {
    const fromFile = readVisualsFile(visualsPath);
    let applied = 0;
    for (const scene of analyzedScenes) {
      const visual = fromFile.get(scene.index);
      if (!visual) continue;
      scene.visual = visual;
      applied += 1;
    }
    if (!applied) {
      warnings.push(`描述文件里没有能对上分镜的记录：${visualsPath}`);
    } else {
      const unknown = [...fromFile.keys()].filter((i) => !analyzedScenes.some((s) => s.index === i));
      if (unknown.length) warnings.push(`描述文件里有 ${unknown.length} 个镜号不在本次分镜里（已忽略）`);
      if (applied < analyzedScenes.length) {
        warnings.push(`描述文件覆盖 ${applied}/${analyzedScenes.length} 镜，其余没有语义描述`);
      }
      const fromModel = describeInfo?.shots || 0;
      describeInfo = {
        model: describeInfo?.model || null,
        shots: 0, // 下面按最终画面数重算
        failed: describeInfo?.failed || 0,
        tokens: describeInfo?.tokens || 0,
        source: fromModel ? 'mixed' : 'file',
      };
      // 留一份快照：下次在界面里点「分析」是重新跑一遍，没有它描述会被冲掉
      const dump: Record<string, ShotVisual> = {};
      for (const scene of analyzedScenes) if (scene.visual) dump[String(scene.index)] = scene.visual;
      writeFileSync(snapshot, `${JSON.stringify(dump, null, 2)}\n`, 'utf8');
    }
  }
  if (describeInfo) describeInfo.shots = analyzedScenes.filter((s) => s.visual).length;

  const result: AnalysisResult = {
    schema: 1,
    ok: true,
    source: { path: target, bytes: stat.size },
    outDir,
    metrics,
    scenes: analyzedScenes,
    frames,
    transcript: {
      source: transcript.source,
      cues: transcript.cues.length,
      ...(transcript.file ? { file: transcript.file } : {}),
    },
    ...(describeInfo ? { describe: describeInfo } : {}),
    warnings,
  };

  writeFileSync(join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
