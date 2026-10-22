# -*- coding: utf-8 -*-
"""文件命名 —— 两个引擎共用同一套规则，避免同一个视频出现两种文件名。"""

import re

# Windows 非法字符 + 控制字符；另外把 # 也换掉（某些播放器/脚本会截断）
_BAD = re.compile(r'[\\/:*?"<>|\r\n\t#\x00-\x1f]')


def safe_name(text, limit=55, fallback='media'):
    s = _BAD.sub('_', text or '')
    s = re.sub(r'\s+', ' ', s).strip()
    s = s.strip('._ ')
    return s[:limit] or fallback
