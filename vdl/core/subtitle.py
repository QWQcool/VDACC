# -*- coding: utf-8 -*-
"""字幕格式转换。

B站 的字幕接口返回 `{"body":[{"from":0.0,"to":2.4,"content":"..."}]}`，
这里转成通用 SRT。纯函数，方便单测。
"""


def _ts(seconds):
    total = int(round(float(seconds or 0) * 1000))
    hours, total = divmod(total, 3600000)
    minutes, total = divmod(total, 60000)
    secs, millis = divmod(total, 1000)
    return f'{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}'


def to_srt(items):
    lines = []
    for index, item in enumerate(items or [], 1):
        text = str((item or {}).get('content') or '').strip()
        if not text:
            continue
        lines.append(f'{index}\n{_ts(item.get("from"))} --> {_ts(item.get("to"))}\n'
                     f'{text}\n')
    return '\n'.join(lines)
