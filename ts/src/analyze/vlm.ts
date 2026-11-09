/**
 * 视觉模型客户端（DeepSeek，OpenAI 兼容 `/chat/completions`）。
 *
 * 三条硬约束（`docs/style-transfer-plan.md` §7）：
 * 1. **API key 只从 `DEEPSEEK_API_KEY` 读**，不落盘、不打印、不进日志；
 * 2. **不新增依赖**，直接 `fetch`；
 * 3. 失败要能说清是哪一类（没 key / 429 限流 / 模型不认图 / 返回不是 JSON），
 *    不要把「没配 key」伪装成「分析失败」。
 *
 * 另外：模型 id 不写死。DeepSeek 的可用模型与多模态能力会变，
 * 这里先问 `/models`，挑第一个 `input_modalities` 里含 `image` 的。
 */
import { readFileSync } from 'node:fs';

const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

export class VlmError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function apiKey(): string {
  return (process.env.DEEPSEEK_API_KEY || '').trim();
}

let modelCache: { id: string; at: number } | null = null;

/** 挑一个能读图的模型；拿不到列表就退回 `deepseek-chat`（它目前也接受图）。 */
export async function pickVisionModel(force = false): Promise<string> {
  if (!force && modelCache && Date.now() - modelCache.at < 60 * 60_000) return modelCache.id;
  const key = apiKey();
  if (!key) throw new VlmError('no_api_key', '没有配 DEEPSEEK_API_KEY，跳过语义描述');
  try {
    const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new VlmError(`http_${res.status}`, `取模型列表失败 HTTP ${res.status}`);
    const json = await res.json() as any;
    const models: any[] = Array.isArray(json?.data) ? json.data : [];
    const vision = models.find((m) => (m?.input_modalities || []).includes('image'));
    const id = String(vision?.id || 'deepseek-chat');
    modelCache = { id, at: Date.now() };
    return id;
  } catch (err) {
    if (err instanceof VlmError) throw err;
    // 网络抖动不该让整次分析失败：退回一个已知可用的名字，让真正那次调用去决定
    return 'deepseek-chat';
  }
}

function base64(path: string): string {
  const raw = readFileSync(path);
  // 单帧一般 100–200KB；超过 3MB 多半是抽帧参数被人改坏了，明确拒绝而不是慢慢上传
  if (raw.length > 3 * 1024 * 1024) {
    throw new VlmError('image_too_large', `帧文件 ${Math.round(raw.length / 1024)}KB 太大（上限 3MB）`);
  }
  return raw.toString('base64');
}

export interface VlmReply {
  text: string;
  model: string;
  tokens: number;
}

/**
 * 一张图 + 一段指令 → 文本。
 *
 * 429 与 5xx 重试 2 次（退避 1s / 3s）；4xx 直接抛，因为重试改不了结果。
 * 超时 90 秒——一帧的描述不该更久，卡住就是网络问题，别让整批任务挂死。
 */
export async function askWithImage(
  imagePath: string, prompt: string, opts: { maxTokens?: number } = {},
): Promise<VlmReply> {
  const key = apiKey();
  if (!key) throw new VlmError('no_api_key', '没有配 DEEPSEEK_API_KEY，跳过语义描述');
  const model = await pickVisionModel();
  const payload: Record<string, any> = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64(imagePath)}` } },
      ],
    }],
    max_tokens: Math.min(4000, Math.max(400, opts.maxTokens ?? 1200)),
    // 这一档模型默认 `high`：一帧要 5–6 秒、推理 token 比答案还多。
    // `low` 实测足够（字段一样齐，取值略粗），想更细可设 VDACC_VLM_EFFORT=high。
    reasoning_effort: process.env.VDACC_VLM_EFFORT || 'low',
  };

  let lastError: unknown = null;
  let budget = payload.max_tokens;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastError = new VlmError(`http_${res.status}`, `视觉模型 HTTP ${res.status}`);
      } else if (!res.ok) {
        // 401/402/400 这类重试无意义：把平台的话原样带出去（不含 key）
        throw new VlmError(`http_${res.status}`, `视觉模型 HTTP ${res.status}: ${text.slice(0, 200)}`);
      } else {
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          throw new VlmError('bad_response', '视觉模型返回的不是 JSON');
        }
        const choice = json?.choices?.[0];
        const content = String(choice?.message?.content || '');
        const tokens = Number(json?.usage?.total_tokens || 0);
        // 被截断（无论有没有吐出一半）都不能用：JSON 少个 } 就是解析不出来。
        // 先加预算重试，不要急着判「模型不会答」。
        if (choice?.finish_reason === 'length' && budget < 4000) {
          const had = content.trim() ? '有半截正文' : '正文为空';
          budget = Math.min(4000, budget * 2);
          payload.max_tokens = budget;
          lastError = new VlmError('truncated', `输出被截断（${had}），已把预算提到 ${budget} 重试`);
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        if (!content.trim()) {
          // 这一档是**推理模型**：预算里同时含 reasoning 与答案。
          // 预算太小会把 500 token 全烧在推理上（实测 finish_reason=length、content 空），
          // 所以明确加预算重试一次，而不是把它当成「模型不会答」。
          if (choice?.finish_reason === 'length' && budget < 4000) {
            budget = Math.min(4000, budget * 2);
            payload.max_tokens = budget;
            lastError = new VlmError('empty_content',
              `模型把 ${budget / 2} token 全花在推理上，已提高到 ${budget} 重试`);
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          throw new VlmError('empty_content',
            `模型没有返回正文（finish_reason=${choice?.finish_reason || '未知'}，推理用了 `
            + `${json?.usage?.completion_tokens_details?.reasoning_tokens || 0} token）`);
        }
        return {
          text: content,
          model: String(json?.model || model),
          tokens,
        };
      }
    } catch (err) {
      if (err instanceof VlmError && !/^http_(429|5\d\d)$/.test(err.code)) throw err;
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, attempt === 0 ? 1000 : 3000));
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new VlmError('vlm_unavailable', `视觉模型连续失败：${message}`);
}
