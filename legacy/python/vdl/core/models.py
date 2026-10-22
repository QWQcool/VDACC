# -*- coding: utf-8 -*-
"""对外数据模型。

两条铁律：
1. 未知就是 None，不要填 0 —— UI 上显示"未知"比编一个假数字好。
2. 带签名的 CDN 直链不进 JSON（会过期、也会泄露短时 token），只留在内存里给下载用。
"""

from dataclasses import dataclass, field

from .. import SCHEMA_VERSION


@dataclass
class Format:
    id: str
    label: str
    width: int = 0
    height: int = 0
    ext: str = 'mp4'
    vcodec: str = ''
    acodec: str = ''
    fps: int = 0
    bytes: int = 0
    bitrate: int = 0
    watermark: bool = False
    recommended: bool = False
    available: bool = True
    reason: str = ''
    # 字幕列表：只给 lang/name，真实地址留在 extra（会过期）
    subtitles: list = field(default_factory=list)
    # 内部字段：真实可下载地址（可能多条 CDN 镜像），不序列化
    urls: list = field(default_factory=list, repr=False)
    # 内部字段：引擎私有信息（如 B站 的 video_id/audio_id），不序列化
    extra: dict = field(default_factory=dict, repr=False)

    def to_dict(self):
        return {
            'id': self.id,
            'label': self.label,
            'width': self.width,
            'height': self.height,
            'ext': self.ext,
            'vcodec': self.vcodec,
            'acodec': self.acodec,
            'fps': self.fps,
            'bytes': self.bytes or None,
            'bitrate': self.bitrate or None,
            'watermark': self.watermark,
            'recommended': self.recommended,
            'available': self.available,
            'reason': self.reason or None,
            'subtitles': self.subtitles,
        }


@dataclass
class Part:
    """多P / 合集里的一个分P。"""
    index: int
    title: str = ''
    duration_ms: int = 0
    url: str = ''
    selected: bool = False

    def to_dict(self):
        return {
            'index': self.index,
            'title': self.title,
            'duration_ms': self.duration_ms or None,
            'url': self.url,
            'selected': self.selected,
        }


@dataclass
class Media:
    id: str
    title: str
    author: str = ''
    duration_ms: int = 0
    thumbnail: str = ''
    source_url: str = ''
    platform: str = ''
    parts: list = field(default_factory=list)      # 多P/合集；单视频为空

    def to_dict(self):
        return {
            'id': self.id,
            'title': self.title,
            'author': self.author,
            'duration_ms': self.duration_ms or None,
            'thumbnail': self.thumbnail,
            'source_url': self.source_url,
            'platform': self.platform,
            'parts': [p.to_dict() for p in self.parts],
        }


@dataclass
class ProbeResult:
    ok: bool
    platform: str = ''
    engine: str = ''
    media: object = None
    formats: list = field(default_factory=list)
    error: dict = None
    warnings: list = field(default_factory=list)

    def to_dict(self):
        return {
            'schema': SCHEMA_VERSION,
            'ok': self.ok,
            'platform': self.platform,
            'engine': self.engine,
            'media': self.media.to_dict() if self.media else None,
            'formats': [f.to_dict() for f in self.formats],
            'warnings': self.warnings,
            'error': self.error,
        }


@dataclass
class DownloadResult:
    ok: bool
    path: str = ''
    bytes: int = 0
    format_id: str = ''
    skipped: bool = False
    media: object = None
    error: dict = None
    warnings: list = field(default_factory=list)

    def to_dict(self):
        return {
            'schema': SCHEMA_VERSION,
            'ok': self.ok,
            'path': self.path,
            'bytes': self.bytes or None,
            'format_id': self.format_id,
            'skipped': self.skipped,
            'media': self.media.to_dict() if self.media else None,
            'warnings': self.warnings,
            'error': self.error,
        }
