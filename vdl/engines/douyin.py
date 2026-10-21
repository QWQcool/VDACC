# -*- coding: utf-8 -*-
"""抖音引擎 —— 把 dy_http 的抓取结果翻译成统一契约。

分档位以 `bit_rate[].gear_name` 为准（同一个 gear 的多条 URL 只是 CDN 镜像，
UI 上不该出现三行一模一样的 1080P）。
"""

import re
from urllib.parse import urlparse

import dy_http

from .base import Engine
from ..core.errors import ErrorCode, VdlError
from ..core.models import DownloadResult, Format, Media, ProbeResult
from ..core.naming import safe_name

# dy_http 的错误码 → 契约错误码。能区分就区分：agent 要靠这个决定重试还是换路。
_CODE_MAP = {
    'bad_input': ErrorCode.BAD_INPUT,
    'blocked': ErrorCode.SIGN_REJECTED,
    'http_403': ErrorCode.SIGN_REJECTED,
    'no_ttwid': ErrorCode.SIGN_REJECTED,
    'no_uifid': ErrorCode.SIGN_REJECTED,
    'filtered': ErrorCode.FILTERED,
    'no_detail': ErrorCode.NO_STREAM,
    'wrong_video': ErrorCode.WRONG_VIDEO,
    'bad_json': ErrorCode.BAD_JSON,
    'network': ErrorCode.NETWORK,
    'truncated': ErrorCode.TRUNCATED,
    'bad_payload': ErrorCode.BAD_PAYLOAD,
    'download_failed': ErrorCode.DOWNLOAD_FAILED,
}

_RES_RE = re.compile(r'(\d{3,4})')


def _wrap(exc):
    code = _CODE_MAP.get(getattr(exc, 'code', '') or '')
    if code is None and str(getattr(exc, 'code', '')).startswith('http_'):
        code = ErrorCode.HTTP_ERROR
    return VdlError(code or ErrorCode.DOWNLOAD_FAILED, str(exc))


class DouyinEngine(Engine):
    name = 'douyin-http'
    platform = 'douyin'
    HOSTS = ('douyin.com', 'iesdouyin.com')

    def __init__(self, log=None):
        self.log = log or (lambda *_: None)
        self.client = dy_http.DouyinHttp(log=self.log)

    # ------------------------------------------------------------ 路由

    def can_handle(self, url):
        host = (urlparse(url).hostname or '').lower()
        if any(host == h or host.endswith('.' + h) for h in self.HOSTS):
            return True
        # 裸视频 ID（B站 BV 号含字母，不会被误判）
        return bool(dy_http.BARE_ID_RE.match((url or '').strip()))

    # ------------------------------------------------------------ 解析

    def probe(self, url):
        try:
            info = self.client.fetch(url)
        except dy_http.HttpEngineError as e:
            raise _wrap(e) from None

        formats = self._build_formats(info)
        if not formats:
            raise VdlError(
                ErrorCode.NO_STREAM,
                '没有解析到任何可下载档位',
                '视频可能已删除/私密，或接口字段变了；可加 --engine browser 对比')

        media = Media(
            id=info.vid,
            title=info.title,
            author=info.author,
            duration_ms=info.duration_ms,
            thumbnail=info.thumbnail,
            source_url=info.source_url,
            platform=self.platform,
        )
        return ProbeResult(ok=True, platform=self.platform, engine=self.name,
                           media=media, formats=formats)

    @staticmethod
    def _pretty_label(cand):
        m = _RES_RE.search(cand.label or '')
        base = f'{m.group(1)}P' if m else (cand.label or '未知')
        if cand.watermark and '带水印' not in (cand.label or ''):
            base += '（带水印）'
        return base

    def _build_formats(self, info):
        """一个分辨率一行：同 gear 的多条 URL 是 CDN 镜像，同分辨率的低码率档直接折叠。

        折叠的理由：`normal_540_0` 与 `lower_540_0` 在 UI 上都是"540P"，并排两行
        只会让人以为可以选，实际没有意义。candidates 已按码率降序，取先到的那个即可。
        """
        has_clean = any(not c.watermark for c in info.candidates)

        gears, order = {}, []
        for c in info.candidates:
            if c.watermark and has_clean:
                continue                      # 有干净档就不要水印档
            if c.label not in gears:
                gears[c.label] = {'first': c, 'urls': []}
                order.append(c.label)
            gears[c.label]['urls'].append(c.url)

        out, used_res = [], set()
        for label in order:
            group = gears[label]
            c = group['first']
            res = (c.width, c.height) if c.width and c.height else (label, c.rate)
            if res in used_res:
                continue
            used_res.add(res)
            out.append(Format(
                id=label or f'fmt-{len(out) + 1}',
                label=self._pretty_label(c),
                width=c.width,
                height=c.height,
                ext='mp4',
                vcodec=c.codec or 'h264',
                acodec='aac',
                fps=c.fps,
                bytes=c.bytes,
                bitrate=c.rate if c.rate > 0 else 0,
                watermark=c.watermark,
                urls=list(group['urls']),
            ))

        if out:
            out[0].recommended = True
        return out

    # ------------------------------------------------------------ 下载

    def download(self, probe, format_id, dest_dir, force=False, progress=None,
                 should_cancel=None):
        import pathlib

        fmt = next((f for f in probe.formats if f.id == format_id), None)
        if fmt is None:
            raise VdlError(ErrorCode.BAD_INPUT, f'没有这个档位: {format_id}',
                           '先跑 probe 看 formats[].id')
        if not fmt.urls:
            raise VdlError(ErrorCode.NO_STREAM, '该档位没有可用地址',
                           '重新 probe 一次（直链会过期）')

        # 档位写进文件名：UI 支持多选同时下载，不区分就会互相覆盖。
        # 形如 6961737553342991651_标题_1080P.mp4（与设计稿一致）。
        label_part = safe_name(fmt.label, 16, fallback=fmt.id)
        out_dir = pathlib.Path(dest_dir)
        name = f'{probe.media.id}_{safe_name(probe.media.title)}_{label_part}.{fmt.ext}'
        dest = out_dir / name
        if not force:
            # 用 vid + 档位做幂等键：标题改了也认得出是同一份
            existing = list(out_dir.glob(
                f'{probe.media.id}_*_{label_part}.{fmt.ext}')) if out_dir.exists() else []
            if existing:
                return DownloadResult(ok=True, path=str(existing[0]),
                                      bytes=existing[0].stat().st_size,
                                      format_id=fmt.id, skipped=True,
                                      media=probe.media)

        tmp = dy_http.Media(
            vid=probe.media.id,
            title=probe.media.title,
            author=probe.media.author,
            duration_ms=probe.media.duration_ms,
            candidates=[
                dy_http.Candidate(fmt.bitrate, fmt.id, u, fmt.width, fmt.height,
                                  fmt.bytes, fmt.fps, fmt.vcodec, fmt.watermark)
                for u in fmt.urls
            ],
        )
        try:
            _label, size = self.client.download(tmp, dest, max_try=len(fmt.urls),
                                                force=force, progress=progress,
                                                should_cancel=should_cancel)
        except dy_http.HttpEngineError as e:
            raise _wrap(e) from None
        return DownloadResult(ok=True, path=str(dest), bytes=size,
                              format_id=fmt.id, media=probe.media)
