# -*- coding: utf-8 -*-
"""B站引擎 —— yt-dlp 解析/下载 + ffmpeg 合并 DASH。

只保留 B站 特有的三件事：URL 归一（裸 BV 号）、平台名、登录态提示。
其余（档位折叠、合并、进度聚合）都在 `_ytdlp.YtdlpBase` 里，和 generic 共用。
"""

import re
import urllib.parse

from ._ytdlp import YtdlpBase
from ..core.paths import cookies_file

BV_RE = re.compile(r'^BV[0-9A-Za-z]{10}$')


class BilibiliEngine(YtdlpBase):
    name = 'bilibili-ytdlp'
    platform = 'bilibili'
    cookie_site = 'bilibili'
    format_prefix = 'bili-'
    HOSTS = ('bilibili.com', 'b23.tv')

    def can_handle(self, url):
        raw = (url or '').strip()
        if BV_RE.match(raw):
            return True
        host = (urllib.parse.urlparse(raw).hostname or '').lower()
        return any(host == h or host.endswith('.' + h) for h in self.HOSTS)

    @staticmethod
    def _normalize(url):
        """裸 BV 号要补成完整 URL，yt-dlp 不认裸 ID。"""
        raw = (url or '').strip()
        if BV_RE.match(raw):
            return f'https://www.bilibili.com/video/{raw}'
        return raw

    def probe(self, url):
        return super().probe(self._normalize(url))

    def _platform_of(self, info):
        return 'bilibili'

    def _extra_warnings(self, formats):
        if not cookies_file('bilibili').exists():
            return ['未登录：B站通常最高 720P；运行 `vdl auth bilibili` 可解锁高清晰度']
        if formats and formats[0].height < 1080:
            return [f'当前登录态最高 {formats[0].height}P，可能是大会员专享清晰度']
        return []
