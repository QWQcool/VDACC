# -*- coding: utf-8 -*-
"""外部程序查找。顺序：仓库 venv → PATH。

为什么优先 venv：用户选的是「便携版 ffmpeg 放进 venv\\Scripts」，
这样不污染系统 PATH，换机也只需要重建 venv。
"""

import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _local(name):
    exe = 'ffmpeg.exe' if name == 'ffmpeg' else 'ffprobe.exe'
    if sys.platform != 'win32':
        exe = name
    candidate = ROOT / 'venv' / 'Scripts' / exe
    return str(candidate) if candidate.exists() else ''


def ffmpeg_path():
    return _local('ffmpeg') or (shutil.which('ffmpeg') or '')


def ffprobe_path():
    return _local('ffprobe') or (shutil.which('ffprobe') or '')
