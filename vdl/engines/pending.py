# -*- coding: utf-8 -*-
"""占位引擎：站点已规划但还没接。

存在的意义是「诚实」——用户贴 B站 链接时，应该得到
`not_implemented + 下一步`，而不是 `unsupported_url` 或一句"下载失败"。
"""

from urllib.parse import urlparse

from .base import Engine
from ..core.errors import ErrorCode, VdlError


class PendingEngine(Engine):
    def __init__(self, platform, name, hosts, message, next_action):
        self.platform = platform
        self.name = name
        self.hosts = tuple(hosts)
        self.message = message
        self.next_action = next_action

    def can_handle(self, url):
        host = (urlparse(url).hostname or '').lower()
        return any(host == h or host.endswith('.' + h) for h in self.hosts)

    def probe(self, url):
        raise VdlError(ErrorCode.NOT_IMPLEMENTED, self.message, self.next_action)

    def download(self, probe, format_id, dest_dir, force=False, progress=None,
                 should_cancel=None):
        raise VdlError(ErrorCode.NOT_IMPLEMENTED, self.message, self.next_action)
