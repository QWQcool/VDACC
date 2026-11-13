/**
 * 弹幕 XML → ASS 字幕。
 *
 * 为什么要有这一步：B站 的弹幕接口给的是 `<d p="...">文本</d>` 的 XML，只有专门的播放器
 * 才认；而 ASS 几乎所有播放器都能挂（VLC / PotPlayer / mpv / 甚至电视盒子）。
 * 落地文件仍然保留原始 XML——想做统计或换渲染器的人需要原文，ASS 只是"能直接看"的那份。
 *
 * 取舍说明：
 * - 只渲染滚动（1/2/3）、顶部（5）、底部（4）；**高级弹幕（7）与代码弹幕（8）跳过**，
 *   它们要执行脚本/精确定位，用 ASS 硬凑只会得到一堆错位文字。
 * - 轨道按"上一条的尾巴离开屏幕"估算回收时间，不做像素级碰撞检测：真实观感够用，
 *   而且不会因为一条超长弹幕把整屏轨道锁死。
 */

export interface DanmakuItem {
  timeMs: number;
  mode: number;
  size: number;
  /** 十进制 RGB（B站 口径，例如 16777215 = 白）。 */
  color: number;
  text: string;
}

export interface DanmakuStats {
  /** XML 里解析出的条数（含被跳过的）。 */
  total: number;
  /** 真正写进 ASS 的条数。 */
  rendered: number;
  /** 高级/代码弹幕等无法用 ASS 表达的条数。 */
  skipped: number;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/** B站 XML 里只有这几类实体；`&#39;` 这种数字实体也要还原。 */
function unescapeXml(input: string): string {
  return input.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

/** 解析 `<d p="时间,模式,字号,颜色,...">文本</d>`，按时间升序。 */
export function parseDanmakuXml(xml: string): DanmakuItem[] {
  const out: DanmakuItem[] = [];
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(xml || ''))) {
    const parts = hit[1].split(',');
    const timeMs = Math.round(Number(parts[0]) * 1000);
    if (!Number.isFinite(timeMs) || timeMs < 0) continue;
    // 换行会把 ASS 的一条事件拆成多行（后续内容被当成新事件），统一压成空格
    const text = unescapeXml(hit[2] || '').replace(/[\r\n]+/g, ' ').trim();
    if (!text) continue;
    out.push({
      timeMs,
      mode: Number(parts[1] || 1) || 1,
      size: Number(parts[2] || 25) || 25,
      color: Number(parts[3] || 0xffffff) || 0xffffff,
      text,
    });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/** B站 的十进制 RGB → ASS 的 `&HBBGGRR&`（注意是 BGR 而不是 RGB）。 */
function assColor(rgb: number): string {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return `&H${((b << 16) | (g << 8) | r).toString(16).padStart(6, '0').toUpperCase()}&`;
}

/** `H:MM:SS.cc`，小时不补零（ASS 的惯例）。 */
function assTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const cs = Math.floor((total % 1000) / 10);
  const sec = Math.floor(total / 1000) % 60;
  const min = Math.floor(total / 60000) % 60;
  const hour = Math.floor(total / 3600000);
  return `${hour}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** 文本宽度粗估：CJK 按 1 个字号宽、ASCII 按 0.55——只用来算滚动起点与轨道回收，不参与排版。 */
function estimateWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) units += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  return Math.ceil(units * fontSize);
}

/** ASS 文本里的 `{` `}` 是标签语法，必须转义，否则观众会看到"少了一段字"。 */
function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

export interface AssOptions {
  width?: number;
  height?: number;
  font?: string;
  /** 滚动弹幕的存活时间（毫秒）。 */
  scrollMs?: number;
  /** 顶部/底部弹幕的停留时间（毫秒）。 */
  staticMs?: number;
}

const ASS_HEADER = (width: number, height: number, font: string, fontSize: number) => `[Script Info]
; 由 VDACC 从 B站 弹幕 XML 生成
Title: VDACC Danmaku
ScriptType: v4.00+
WrapStyle: 2
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Danmaku,${font},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,7,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

/**
 * 生成 ASS。默认 1920×1080（播放器会按窗口缩放），字号以 B站 的 25 号为基准放大到 54。
 *
 * 轨道分配：滚动弹幕按"上一条约 55% 行程后本轨道可再用"回收（前一条已经走出一大截，
 * 后面那条追不上），顶部/底部按到达时间顺序占轨道。
 */
export function toAss(
  items: DanmakuItem[],
  opts: AssOptions = {},
): { ass: string; stats: DanmakuStats } {
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const font = opts.font ?? 'Microsoft YaHei';
  const scrollMs = opts.scrollMs ?? 8000;
  const staticMs = opts.staticMs ?? 4500;
  const baseSize = 25;
  const baseFontSize = 54;
  const lineHeight = Math.round(baseFontSize * 1.28);
  const marginTop = 18;
  const marginBottom = 60;
  const laneCount = Math.max(1, Math.floor((height - marginTop - marginBottom) / lineHeight));
  const scrollFreeAt = new Array<number>(laneCount).fill(0);
  const topFreeAt = new Array<number>(laneCount).fill(0);
  const bottomFreeAt = new Array<number>(laneCount).fill(0);

  const events: string[] = [];
  let skipped = 0;
  let rendered = 0;

  const pickLane = (state: number[], at: number): number => {
    let best = 0;
    for (let i = 0; i < state.length; i += 1) {
      if (state[i] <= at) return i;
      if (state[i] < state[best]) best = i;
    }
    return best;
  };

  for (const item of items) {
    const mode = item.mode;
    // 7 = 高级弹幕、8 = 代码弹幕：要执行脚本才能还原位置，ASS 里没有等价物
    if (mode === 7 || mode === 8) { skipped += 1; continue; }
    if (mode !== 1 && mode !== 2 && mode !== 3 && mode !== 4 && mode !== 5) { skipped += 1; continue; }

    const fontSize = Math.max(24, Math.round(baseFontSize * (item.size / baseSize)));
    const scale = fontSize / baseFontSize;
    const text = escapeText(item.text);
    const color = assColor(item.color);

    if (mode === 4 || mode === 5) {
      // 4 = 底部（\an2），5 = 顶部（\an8）：停留式，不移动
      const pool = mode === 5 ? topFreeAt : bottomFreeAt;
      const lane = pickLane(pool, item.timeMs);
      pool[lane] = item.timeMs + staticMs;
      const y = mode === 5
        ? marginTop + lane * lineHeight
        : height - marginBottom - lane * lineHeight;
      const align = mode === 5 ? 8 : 2;
      const tags = `{\\an${align}\\pos(${Math.round(width / 2)},${Math.round(y)})`
        + `${scale !== 1 ? `\\fs${fontSize}` : ''}\\c${color}}`;
      events.push(`Dialogue: 0,${assTime(item.timeMs)},${assTime(item.timeMs + staticMs)},Danmaku,,0,0,0,,${tags}${text}`);
      rendered += 1;
      continue;
    }

    // 1/2/3 = 右→左滚动。ASS 的 move 以"对齐点"为锚，样式用 \an7（左上），y 就是行顶
    const lane = pickLane(scrollFreeAt, item.timeMs);
    // 一条弹幕走完整个屏宽所需时间 = 存活时间；轨道在新弹幕进入约 55% 行程后即可复用
    const revisit = item.timeMs + Math.round(scrollMs * 0.55);
    scrollFreeAt[lane] = revisit;
    const y = marginTop + lane * lineHeight;
    const textWidth = estimateWidth(item.text, fontSize);
    const tags = `{\\an7\\move(${width},${Math.round(y)},${-textWidth},${Math.round(y)})`
      + `${scale !== 1 ? `\\fs${fontSize}` : ''}\\c${color}}`;
    events.push(`Dialogue: 0,${assTime(item.timeMs)},${assTime(item.timeMs + scrollMs)},Danmaku,,0,0,0,,${tags}${text}`);
    rendered += 1;
  }

  const ass = ASS_HEADER(width, height, font, baseFontSize) + events.join('\n') + (events.length ? '\n' : '');
  return { ass, stats: { total: items.length, rendered, skipped } };
}
