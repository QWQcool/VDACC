# -*- coding: utf-8 -*-
"""通用流式下载：边下边写 + 进度回调。

和 dy_http 的下载器分开，是因为 dy_http 带着抖音的 Referer / 多镜像重试逻辑；
这里只处理"给我一个直链，把它落成文件"。
"""

import time
import urllib.request


def stream_to_file(url, part, headers=None, progress=None, timeout=120,
                   chunk=256 * 1024):
    """下载到 part，返回 (written, total)。total 未知时为 0。"""
    req = urllib.request.Request(url, headers=headers or {})
    written = 0
    last = 0.0
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(part, 'wb') as f:
        raw_len = resp.headers.get('Content-Length') or ''
        total = int(raw_len) if raw_len.isdigit() else 0
        while True:
            buf = resp.read(chunk)
            if not buf:
                break
            f.write(buf)
            written += len(buf)
            if progress and time.monotonic() - last >= 0.2:
                last = time.monotonic()
                try:
                    progress(written, total)
                except Exception:
                    pass
    if progress:
        try:
            progress(written, total or written)
        except Exception:
            pass
    return written, total
