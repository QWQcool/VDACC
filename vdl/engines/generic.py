# -*- coding: utf-8 -*-
"""通用兜底引擎：任何 http(s) 链接都交给 yt-dlp 试一次。

定位：它覆盖 yt-dlp 支持的 1700+ 站点，避免我们为每个站点写引擎。
边界：只做 yt-dlp 能做的（无 DRM、无登录墙绕过）；失败时把 yt-dlp 的
原始报错带回给调用方，不假装「不支持」。
"""

import urllib.parse

from ._ytdlp import YtdlpBase


class GenericYtdlpEngine(YtdlpBase):
    name = 'ytdlp-generic'
    platform = 'generic'
    cookie_site = ''            # 未知域名，不带任何站点的 cookie
    format_prefix = 'gen-'

    def can_handle(self, url):
        parsed = urllib.parse.urlparse((url or '').strip())
        return parsed.scheme in ('http', 'https') and bool(parsed.netloc)
