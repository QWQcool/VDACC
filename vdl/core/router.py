# -*- coding: utf-8 -*-
"""域名 → 引擎 的路由。

顺序有意义：抖音必须排在通用兜底之前（以后加 L2 嗅探时尤其要注意）。
"""

from .errors import ErrorCode, VdlError
from .models import ProbeResult


def build_engines(log=None):
    from ..engines.bilibili import BilibiliEngine
    from ..engines.douyin import DouyinEngine
    from ..engines.netease import NeteaseEngine

    # 顺序有意义：抖音的裸 ID 规则比 B站 的 BV 号更宽，必须排在前面
    return [
        DouyinEngine(log=log),
        NeteaseEngine(log=log),
        BilibiliEngine(log=log),
    ]


def route(url, log=None):
    for engine in build_engines(log=log):
        if engine.can_handle(url):
            return engine
    raise VdlError(
        ErrorCode.UNSUPPORTED_URL,
        f'没有能处理这个输入的引擎: {url}',
        '当前只支持抖音（链接/短链/视频 ID）')


def probe(url, log=None):
    """解析，并把失败折叠成统一的错误信封（不抛异常）。"""
    try:
        engine = route(url, log=log)
    except VdlError as e:
        return ProbeResult(ok=False, error=e.to_dict())

    try:
        return engine.probe(url)
    except VdlError as e:
        return ProbeResult(ok=False, platform=engine.platform,
                           engine=engine.name, error=e.to_dict())
