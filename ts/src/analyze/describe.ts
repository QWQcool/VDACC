/**
 * A2：逐镜语义描述（只描述**这一帧能看到的**，不推断剧情）。
 *
 * 为什么要限制得这么死：
 * - 模型很爱补全——看到两个人就编一段对话，看到夜景就编时间地点；
 *   这些编出来的字段会被下游当成事实写进风格卡，比缺失难查得多。
 * - 所以提示词要求「不确定就留空」，解析端也接受空字段，
 *   并且**不伪造 confidence**：模型没有可靠置信度，我们就不报这个字段。
 */
import { VlmError, askWithImage } from './vlm';

export interface ShotVisual {
  /** 景别：特写 / 近景 / 中景 / 全景 / 远景 / 空镜 */
  shotSize: string;
  /** 画面主体（人/物，能数清就数清） */
  subject: string;
  /** 主体在做什么（静态画面就写姿态） */
  action: string;
  /** 场景与环境 */
  setting: string;
  /** 光线与主色调 */
  lighting: string;
  /** 构图与镜头感（对称/三分/俯拍/手持…） */
  composition: string;
  /** 画面内可见文字（字幕、招牌、水印都算；没有就空串） */
  onScreenText: string;
}

export const VISUAL_FIELDS: Array<keyof ShotVisual> = [
  'shotSize', 'subject', 'action', 'setting', 'lighting', 'composition', 'onScreenText',
];

export const EMPTY_VISUAL: ShotVisual = {
  shotSize: '', subject: '', action: '', setting: '', lighting: '', composition: '', onScreenText: '',
};

export interface ShotContext {
  index: number;
  startMs: number;
  endMs: number;
  /** 该镜台词（来自字幕）；没有就空串 */
  subtitle: string;
}

export function buildDescribePrompt(ctx: ShotContext): string {
  const from = (ctx.startMs / 1000).toFixed(1);
  const to = (ctx.endMs / 1000).toFixed(1);
  const lines = [
    '你是一个镜头记录员。给你一张视频截图，只记录画面里**看得见**的东西，不要推测剧情、人物关系、台词或画外信息。',
    '',
    `这一镜是 ${from}s–${to}s${ctx.subtitle ? `，该镜台词：「${ctx.subtitle}」` : ''}。`,
    '',
    '只输出一行 JSON（不要 markdown 代码块、不要解释），字段如下，全部是字符串：',
    '{',
    '  "shotSize": "景别，只能取：特写/近景/中景/全景/远景/空镜",',
    '  "subject": "画面主体，人/物分别是什么；能数清就写数量",',
    '  "action": "主体正在做什么；静态画面写姿态",',
    '  "setting": "场景与环境（室内/室外、具体场所）",',
    '  "lighting": "光线与主色调（如：暖黄侧光、冷蓝夜景）",',
    '  "composition": "构图与镜头感（对称/三分/俯拍/手持/浅景深）",',
    '  "onScreenText": "画面内的字幕/招牌/包装文字；忽略平台角标水印（bilibili/抖音/douyin/快手等）；没有就空字符串"',
    '}',
    '',
    '规则：',
    '- **不确定就留空字符串**，不要猜、不要编；',
    '- 不要描述你在这一帧里看不到的东西（比如人物身份、剧情前因后果）；',
    '- 台词只作为上下文参考，不要把台词内容写进 subject/action。',
  ];
  return lines.join('\n');
}

/**
 * 解析模型输出。
 *
 * 三种常见脏输出都要吃下：```json 围栏、前后夹解释文字、字段值不是字符串。
 * 解析不出来就抛 `bad_json` —— 让调用方记一条「这一镜没描述」，而不是塞半份假数据。
 */
export function parseShotDescription(text: string): ShotVisual {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0) throw new VlmError('bad_json', `模型没有返回 JSON：${raw.slice(0, 120)}`);
  if (end <= start) {
    // 只有开括号没有闭括号 = 被 token 上限截断，和「不肯按格式答」是两回事
    throw new VlmError('bad_json', `模型输出被截断（没有闭合的 }）：${raw.slice(0, 120)}`);
  }
  let json: any;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new VlmError('bad_json', `模型返回的 JSON 解析失败：${raw.slice(0, 120)}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new VlmError('bad_json', '模型返回的不是对象');
  }
  const out = { ...EMPTY_VISUAL };
  for (const key of VISUAL_FIELDS) {
    const value = json[key];
    out[key] = typeof value === 'string' ? value.trim() : '';
  }
  // 全空等于没描述：宁可报错，也别让下游以为「这一镜什么都没有」
  if (VISUAL_FIELDS.every((key) => !out[key])) {
    throw new VlmError('bad_json', '模型把所有字段都留空了');
  }
  return out;
}

export async function describeShot(
  framePath: string, ctx: ShotContext,
): Promise<{ visual: ShotVisual; model: string; tokens: number }> {
  // 1200 是「推理 + 一行 JSON」的实测预算；模型把预算全烧在推理上时会自动加倍重试
  const reply = await askWithImage(framePath, buildDescribePrompt(ctx), { maxTokens: 1200 });
  return { visual: parseShotDescription(reply.text), model: reply.model, tokens: reply.tokens };
}
