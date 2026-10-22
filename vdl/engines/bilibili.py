# -*- coding: utf-8 -*-
"""B站引擎 —— yt-dlp 解析/下载 + 分P 列表。

B站 特有的三件事：
1. 裸 BV 号要补成完整 URL；
2. 多P/合集要给出 `parts[]`（用公开的 pagelist 接口，1 次请求）；
3. 未登录时高清晰度不可用，要给提示。

其余（档位折叠、合并、进度、字幕落盘）都在 `_ytdlp.YtdlpBase`。
"""

import json
import re
import urllib.parse
import urllib.request

from ._ytdlp import UA, YtdlpBase
from ..core.models import Part
from ..core.paths import cookies_file

BV_RE = re.compile(r'^BV[0-9A-Za-z]{10}$')
PAGELIST = 'https://api.bilibili.com/x/player/pagelist?bvid='


class BilibiliEngine(YtdlpBase):
    name = 'bilibili-ytdlp'
    platform = 'bilibili'
    cookie_site = 'bilibili'
    format_prefix = 'bili-'
    HOSTS = ('bilibili.com', 'b23.tv')

    # ------------------------------------------------------------ 路由

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

    @staticmethod
    def _parse(url):
        """从链接里取 (bvid, 分P页码)；短链取不到 bvid 时返回空串。"""
        match = re.search(r'(BV[0-9A-Za-z]{10})', url or '')
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url or '').query)
        raw_page = (query.get('p') or ['1'])[0]
        page = int(raw_page) if str(raw_page).isdigit() else 1
        return (match.group(1) if match else ''), max(1, page)

    def _pagelist(self, bvid):
        try:
            req = urllib.request.Request(
                PAGELIST + bvid,
                headers={'User-Agent': UA, 'Referer': 'https://www.bilibili.com/'})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode('utf-8', 'replace'))
        except Exception:                        # noqa: BLE001 - 分P拿不到不影响主流程
            return []
        return self._parts_from(data, bvid)

    @staticmethod
    def _parts_from(data, bvid):
        """从 pagelist 响应构造 Part 列表（纯函数，便于单测）。"""
        if not isinstance(data, dict) or data.get('code') != 0:
            return []
        out = []
        for item in data.get('data') or []:
            try:
                page = int(item.get('page') or 0)
            except (TypeError, ValueError):
                continue
            if page <= 0:
                continue
            out.append(Part(
                index=page,
                title=item.get('part') or f'P{page}',
                duration_ms=int(float(item.get('duration') or 0) * 1000),
                url=f'https://www.bilibili.com/video/{bvid}?p={page}',
            ))
        return out

    # ------------------------------------------------------------ 解析

    def probe(self, url):
        raw = self._normalize(url)
        bvid, page = self._parse(raw)
        target = (f'https://www.bilibili.com/video/{bvid}?p={page}'
                  if bvid and page > 1 else raw)

        result = super().probe(target)

        if not bvid and BV_RE.match(result.media.id or ''):
            bvid = result.media.id
        parts = self._pagelist(bvid) if bvid else []
        if len(parts) > 1:                       # 单P 不塞噪音
            for part in parts:
                part.selected = (part.index == page)
            result.media.parts = parts
        return result

    def _platform_of(self, info):
        return 'bilibili'

    def _extra_warnings(self, formats):
        if not cookies_file('bilibili').exists():
            return ['未登录：B站通常最高 720P；运行 `vdl auth bilibili` 可解锁高清晰度']
        if formats and formats[0].height < 1080:
            return [f'当前登录态最高 {formats[0].height}P，可能是大会员专享清晰度']
        return []
