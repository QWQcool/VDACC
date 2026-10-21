# -*- coding: utf-8 -*-
"""引擎接口。

新增一个站点 = 实现这三个方法 + 在 router 里登记，别的地方不用改。
"""

from abc import ABC, abstractmethod


class Engine(ABC):
    name = ''          # 引擎标识，会出现在 JSON 的 engine 字段
    platform = ''      # 平台标识，会出现在 JSON 的 platform 字段

    @abstractmethod
    def can_handle(self, url):
        """能否处理这个输入（链接 / 短链 / 裸 ID）。"""

    @abstractmethod
    def probe(self, url):
        """解析出 Media + formats，失败抛 VdlError。"""

    @abstractmethod
    def download(self, probe, format_id, dest_dir, force=False, progress=None,
                 should_cancel=None):
        """按档位下载到 dest_dir，返回 DownloadResult。

        progress(written, total) 可选：给 Web UI 的 SSE 用，CLI 可传 None。
        should_cancel() 返回 True 时应尽快中断，并保留 .part 以便续传。
        """


def pick_format(probe, format_id=None):
    """选档位：指定 id 优先；否则推荐档 → 第一个非水印 → 第一个。"""
    formats = [f for f in probe.formats if f.available]
    if not formats:
        return None
    if format_id:
        for f in formats:
            if f.id == format_id:
                return f
        return None
    for f in formats:
        if f.recommended:
            return f
    for f in formats:
        if not f.watermark:
            return f
    return formats[0]
