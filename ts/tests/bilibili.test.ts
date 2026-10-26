import { describe, expect, test } from 'bun:test';

import {
  aggregateProgress, chooseFormat, countDanmaku, parseContentRangeTotal, srtTime, toSrt,
} from '../src/engines/bilibili_api';

describe('选档：缺档位不静默换档', () => {
  const formats = [{ id: 'bili-1920', recommended: true }, { id: 'bili-854' }];

  test('指定档位命中就用它', () => {
    expect(chooseFormat(formats, 'bili-854').id).toBe('bili-854');
  });

  test('指定了不存在的档位要报错，并列出可用档位', () => {
    let err: any = null;
    try { chooseFormat(formats, 'bili-4k'); } catch (e) { err = e; }
    expect(err?.code).toBe('no_stream');
    expect(String(err?.message)).toContain('bili-4k');
    expect(String(err?.nextAction)).toContain('bili-1920');
  });

  test('不指定时取推荐档，空列表报错', () => {
    expect(chooseFormat(formats, null).id).toBe('bili-1920');
    expect(chooseFormat(formats, '').id).toBe('bili-1920');
    let err: any = null;
    try { chooseFormat([], null); } catch (e) { err = e; }
    expect(err?.code).toBe('no_stream');
  });
});

// 只测纯函数：真实流的字节数依赖 CDN 与登录态，放进手工验收（见 commit 记录）。
describe('B站 进度折算', () => {
  test('content-range 取总字节', () => {
    expect(parseContentRangeTotal('bytes 0-0/21154992')).toBe(21154992);
    expect(parseContentRangeTotal('bytes 0-0/*')).toBe(0);
    expect(parseContentRangeTotal('')).toBe(0);
    expect(parseContentRangeTotal(null)).toBe(0);
    expect(parseContentRangeTotal('garbage')).toBe(0);
  });

  test('探到真实总量时，分母恒定', () => {
    expect(aggregateProgress(0, 0, 30, 20)).toEqual([0, 30]);
    expect(aggregateProgress(0, 20, 30, 20)).toEqual([20, 30]);
    // 切到音轨后 base 累加，分母不动
    expect(aggregateProgress(20, 5, 30, 10)).toEqual([25, 30]);
  });

  test('探不到时退回「已完成 + 当前流」', () => {
    expect(aggregateProgress(0, 5, 0, 20)).toEqual([5, 20]);
    expect(aggregateProgress(20, 5, 0, 10)).toEqual([25, 30]);
    expect(aggregateProgress(20, 5, 0, 0)).toEqual([25, 0]);
  });

  test('弹幕条数只看 <d 标签', () => {
    expect(countDanmaku('<i><d p="1,2">a</d><d p="3">b</d></i>')).toBe(2);
    expect(countDanmaku('<?xml version="1.0"?><i></i>')).toBe(0);
    expect(countDanmaku('')).toBe(0);
  });

  test('SRT 时间戳格式', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(1.5)).toBe('00:00:01,500');
    expect(srtTime(3725.25)).toBe('01:02:05,250');
    expect(srtTime(0.9996)).toBe('00:00:01,000');
    expect(srtTime(-1)).toBe('00:00:00,000');
  });

  test('字幕 JSON 转 SRT', () => {
    const srt = toSrt([
      { from: 1.5, to: 3, content: '你好' },
      { from: 3, to: 4.25, content: '第二行\r\n换行' },
    ]);
    expect(srt).toBe(
      '1\n00:00:01,500 --> 00:00:03,000\n你好\n\n' +
      '2\n00:00:03,000 --> 00:00:04,250\n第二行\n换行\n',
    );
    expect(toSrt([])).toBe('');
  });

  test('两段流拼起来的进度单调、只在最后到 100%', () => {
    const planned = 30;
    const steps: Array<[number, number]> = [];
    for (const w of [0, 7.5, 15, 20]) steps.push(aggregateProgress(0, w, planned, 20));
    for (const w of [0, 5, 10]) steps.push(aggregateProgress(20, w, planned, 10));

    const pcts = steps.map(([w, t]) => (t ? w / t : 0));
    for (let i = 1; i < pcts.length; i += 1) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    }
    expect(pcts[pcts.length - 1]).toBe(1);
    expect(pcts.filter((p) => p >= 0.999).length).toBe(1);
  });
});
