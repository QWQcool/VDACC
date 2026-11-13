import { describe, expect, test } from 'bun:test';

import { parseDanmakuXml, toAss } from '../src/core/danmaku';

const xml = `<?xml version="1.0" encoding="UTF-8"?><i>
<d p="1.5,1,25,16777215,1700000000,0,abc,123">第一条 &amp; 含实体</d>
<d p="1.5,5,25,16711680,1700000001,0,abc,124">顶部红字</d>
<d p="1.6,4,25,255,1700000002,0,abc,125">底部蓝字</d>
<d p="2.0,7,25,16777215,1700000003,0,abc,126">高级弹幕要被跳过</d>
<d p="2.1,8,25,16777215,1700000004,0,abc,127">代码弹幕也要跳过</d>
<d p="3,&quot;1&quot;,&quot;25&quot;,&quot;16777215&quot;,1700000005,0,abc,128">多行
会被压平</d>
</i>`;

describe('弹幕 XML 解析', () => {
  test('字段与实体还原，按时间升序', () => {
    const items = parseDanmakuXml(xml);
    expect(items.length).toBe(6);
    expect(items[0]).toEqual({
      timeMs: 1500, mode: 1, size: 25, color: 16777215, text: '第一条 & 含实体',
    });
    expect(items.at(-1)!.timeMs).toBe(3000);
    // 换行会把 ASS 的一条事件拆成多条，必须压平
    expect(items.at(-1)!.text).toBe('多行 会被压平');
  });

  test('空文本与坏时间被丢掉', () => {
    const items = parseDanmakuXml('<i><d p="1,1,25,16777215">   </d><d p="x,1,25,1">坏时间</d><d p="2,1,25,1">好</d></i>');
    expect(items.map((i) => i.text)).toEqual(['好']);
  });
});

describe('ASS 生成', () => {
  const items = parseDanmakuXml(xml);
  const { ass, stats } = toAss(items);

  test('统计：高级/代码弹幕被跳过，其余渲染', () => {
    expect(stats.total).toBe(6);
    expect(stats.rendered).toBe(4);
    expect(stats.skipped).toBe(2);
  });

  test('头部字段齐全（播放器靠 PlayRes 与 ScriptType 认）', () => {
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('ScriptType: v4.00+');
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('PlayResY: 1080');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
  });

  test('滚动用 \\move，顶部 \\an8，底部 \\an2', () => {
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(events.length).toBe(4);
    expect(events[0]).toContain('\\move(1920,');
    expect(events[1]).toContain('\\an8\\pos');
    expect(events[2]).toContain('\\an2\\pos');
  });

  test('颜色按 BGR 写：红 0xFF0000 → &H0000FF&', () => {
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    // 第二条是顶部红字
    expect(events[1]).toContain('\\c&H0000FF&');
    // 第三条是底部蓝字（255 = 0x0000FF → BGR 为 FF0000）
    expect(events[2]).toContain('\\c&HFF0000&');
  });

  test('大括号被转义，观众不会看到"少一段字"', () => {
    const out = toAss([{ timeMs: 0, mode: 1, size: 25, color: 0xffffff, text: '技巧{测试}完了' }]);
    expect(out.ass).toContain('技巧\\{测试\\}完了');
  });

  test('同一时刻的多条滚动弹幕分到不同轨道', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      timeMs: 1000, mode: 1, size: 25, color: 0xffffff, text: `第 ${i + 1} 条`,
    }));
    const ys = toAss(many).ass.split('\n')
      .filter((l) => l.startsWith('Dialogue:'))
      .map((l) => Number(/\\move\(1920,(\d+),/.exec(l)?.[1] || -1));
    expect(new Set(ys).size).toBe(4);
    expect(ys.every((y) => y >= 0)).toBe(true);
  });

  test('时间格式是 ASS 的 H:MM:SS.cc', () => {
    const out = toAss([{ timeMs: 3723450, mode: 1, size: 25, color: 0xffffff, text: 'x' }]);
    expect(out.ass).toContain('Dialogue: 0,1:02:03.45,');
  });
});
