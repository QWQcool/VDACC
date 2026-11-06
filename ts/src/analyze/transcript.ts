/**
 * 台词：**字幕优先**，没有字幕就如实说「没有」，不猜、不跑语音识别。
 *
 * 为什么这一版不接 Whisper：端上/本机都没有装它，加一个模型依赖会让
 * 「只想看分镜」的用户也要先下几十 MB 权重。字幕（B站我们要下载 .srt 的能力已有）
 * 能覆盖绝大多数场景；没有字幕时输出 `source: 'none'`，下游要接 Whisper 时
 * 只需要替换 `loadTranscript`，`cuesForScenes` 不用动。
 */
import { existsSync, readFileSync } from 'node:fs';

export interface Cue {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface Transcript {
  source: 'srt' | 'lrc' | 'none';
  cues: Cue[];
  /** 字幕文件路径（source !== 'none' 时才有） */
  file?: string;
}

function clockToMs(text: string): number {
  // SRT: 00:00:01,500 ；LRC: [00:01.50]
  const m = /(\d+):(\d{2})(?::(\d{2}))?[,.](\d{1,3})/.exec(text);
  if (!m) return 0;
  const h = m[3] === undefined ? 0 : Number(m[1]);
  const min = m[3] === undefined ? Number(m[1]) : Number(m[2]);
  const sec = m[3] === undefined ? Number(m[2]) : Number(m[3]);
  const ms = Number((m[4] + '00').slice(0, 3));
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/** 解析 SRT：块之间用空行分隔，时间行 `00:00:01,500 --> 00:00:03,200`。 */
export function parseSrt(text: string): Cue[] {
  const out: Cue[] = [];
  for (const block of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->').map((s) => s.trim());
    const body = lines.slice(at + 1).join(' ').trim();
    if (!body) continue;
    out.push({ start_ms: clockToMs(from), end_ms: clockToMs(to), text: body });
  }
  return out;
}

/** 解析 LRC（网易云/酷狗歌词）：时间标签在行首，一行可有多个标签。 */
export function parseLrc(text: string): Cue[] {
  const out: Cue[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const body = line.replace(/\[[^\]]+\]/g, '').trim();
    if (!body) continue;
    for (const tag of tags) {
      const ms = Number((tag[3] || '0').padEnd(3, '0').slice(0, 3));
      out.push({
        start_ms: ((Number(tag[1]) * 60) + Number(tag[2])) * 1000 + ms,
        end_ms: 0,
        text: body,
      });
    }
  }
  out.sort((a, b) => a.start_ms - b.start_ms);
  return out;
}

/** 找同名 `.srt` / `.lrc`（下载器就落在视频旁边）。找不到返回 none，不抛错。 */
export function loadTranscript(videoPath: string): Transcript {
  const stem = videoPath.replace(/\.[^.\\/]+$/, '');
  const srt = `${stem}.srt`;
  if (existsSync(srt)) {
    try {
      return { source: 'srt', cues: parseSrt(readFileSync(srt, 'utf8')), file: srt };
    } catch { /* 读不了就当没有 */ }
  }
  const lrc = `${stem}.lrc`;
  if (existsSync(lrc)) {
    try {
      return { source: 'lrc', cues: parseLrc(readFileSync(lrc, 'utf8')), file: lrc };
    } catch { /* 同上 */ }
  }
  return { source: 'none', cues: [] };
}

/**
 * 每镜的台词 = 与该段时间重叠最多的 3 条，**按时间顺序**拼起来。
 *
 * 为什么先按重叠排序再按时间还原：一镜里可能压着 5 条字幕，全拼会淹掉镜头本身；
 * 但拼出来的句子必须按发生顺序读得通，否则是「第二句先说、第一句后说」的乱序。
 */
export function cuesForScenes(
  scenes: Array<{ index: number; start_ms: number; end_ms: number }>,
  cues: Cue[],
): Array<{ index: number; text: string }> {
  if (!cues.length) return scenes.map((s) => ({ index: s.index, text: '' }));
  const sorted = cues.slice().sort((a, b) => a.start_ms - b.start_ms);
  return scenes.map((scene) => {
    const picked: Array<{ overlap: number; at: number; text: string }> = [];
    for (const cue of sorted) {
      if (cue.start_ms >= scene.end_ms) break;
      const end = cue.end_ms || cue.start_ms + 3000;
      const overlap = Math.min(end, scene.end_ms) - Math.max(cue.start_ms, scene.start_ms);
      if (overlap > 0) picked.push({ overlap, at: cue.start_ms, text: cue.text });
    }
    return {
      index: scene.index,
      text: picked
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, 3)
        .sort((a, b) => a.at - b.at)
        .map((p) => p.text)
        .join(' '),
    };
  });
}
