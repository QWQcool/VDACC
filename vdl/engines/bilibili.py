# -*- coding: utf-8 -*-
"""B站引擎 —— 用 yt-dlp 解析/下载，ffmpeg 合并 DASH。

为什么不自己写提取器：B站 的 WBI 签名、清晰度权限、番剧/分P 结构都被 yt-dlp
维护得很完整，重复实现只会更差。我们只做三件事：
1) 把 yt-dlp 的格式表折叠成「一个清晰度一行」（同一高度有多种编码，取最兼容的）；
2) 音视频成对合并，并把两条流的进度聚合成一个百分比；
3) 把结果翻译成统一契约（含 available/reason 与真实体积）。

登录态来自 `vdl auth bilibili` 导出的 cookies.txt；没有登录时 yt-dlp 通常只到 720P。
"""

import os
import pathlib
import re
import urllib.parse

from .base import Engine
from ..core.env import ffmpeg_path
from ..core.errors import ErrorCode, VdlError
from ..core.models import DownloadResult, Format, Media, ProbeResult
from ..core.naming import safe_name
from ..core.paths import cookies_file

# 清晰度归档按**宽度**：B站 有不少 2.35:1 的宽银幕（如 1920×816、4096×1740），
# 按高度归档会整体下移一档（实测把 4K 判成 2K、1080P 判成 720P）。
BUCKETS = ((3840, '4K'), (2560, '2K'), (1920, '1080P'), (1280, '720P'), (854, '480P'))
BV_RE = re.compile(r'^BV[0-9A-Za-z]{10}$')


class BilibiliEngine(Engine):
    name = 'bilibili-ytdlp'
    platform = 'bilibili'
    HOSTS = ('bilibili.com', 'b23.tv')

    def __init__(self, log=None):
        self.log = log or (lambda *_: None)

    # ------------------------------------------------------------ 路由

    def can_handle(self, url):
        raw = (url or '').strip()
        if BV_RE.match(raw):
            return True
        host = (urllib.parse.urlparse(raw).hostname or '').lower()
        return any(host == h or host.endswith('.' + h) for h in self.HOSTS)

    # ------------------------------------------------------------ yt-dlp

    def _ydl(self, **overrides):
        try:
            import yt_dlp
        except ImportError:
            raise VdlError(ErrorCode.ENGINE_UNAVAILABLE,
                           '缺少 yt-dlp（B站引擎依赖它）',
                           '在仓库 venv 里执行：pip install yt-dlp') from None

        jar = cookies_file('bilibili')
        opts = {
            'quiet': True,
            'no_warnings': True,
            'noprogress': True,
            'noplaylist': True,
            'socket_timeout': 20,
            'retries': 2,
            'cookiefile': str(jar) if jar.exists() else None,
        }
        ff = ffmpeg_path()
        if ff:
            opts['ffmpeg_location'] = os.path.dirname(ff)
        opts.update(overrides)
        return yt_dlp.YoutubeDL(opts)

    @staticmethod
    def _wrap(exc):
        msg = str(getattr(exc, 'msg', '') or exc)
        low = msg.lower()
        if 'login' in low or '大会员' in msg or 'premium' in low or 'vip' in low:
            return VdlError(ErrorCode.NEED_LOGIN, msg,
                            '运行 `vdl auth bilibili` 重新登录后重试')
        return VdlError(ErrorCode.DOWNLOAD_FAILED, msg,
                        '确认链接可播放；必要时换 --engine 或在浏览器里试')

    # ------------------------------------------------------------ 解析

    @staticmethod
    def _bucket(width):
        for limit, label in BUCKETS:
            if width >= limit:
                return limit, label
        return 0, '标清'

    @staticmethod
    def _score(fmt):
        """同高度优先 H.264（兼容性最好），再比码率。"""
        codec = (fmt.get('vcodec') or '').lower()
        if codec.startswith('avc'):
            pref = 2
        elif codec.startswith(('hev', 'hvc')):
            pref = 1
        else:
            pref = 0
        return pref, (fmt.get('tbr') or 0)

    def probe(self, url):
        try:
            with self._ydl() as ydl:
                info = ydl.extract_info(url, download=False)
        except VdlError:
            raise
        except Exception as e:                   # noqa: BLE001
            raise self._wrap(e) from None

        if info and info.get('entries'):
            info = next((x for x in info['entries'] if x), None)
        if not info:
            raise VdlError(ErrorCode.NO_STREAM, 'yt-dlp 没有解析出内容',
                           '确认链接是单个视频而不是空列表')

        formats = info.get('formats') or []
        videos = [f for f in formats
                  if (f.get('vcodec') or 'none') != 'none' and f.get('height')]
        audios = [f for f in formats
                  if (f.get('acodec') or 'none') != 'none'
                  and (f.get('vcodec') or 'none') == 'none']
        best_audio = max(audios, key=lambda a: (a.get('abr') or a.get('tbr') or 0),
                         default=None)

        groups = {}
        for f in videos:
            limit, _label = self._bucket(int(f.get('width') or 0))
            groups.setdefault(limit, []).append(f)

        out = []
        for limit in sorted(groups, reverse=True):
            best = max(groups[limit], key=self._score)
            total = int(best.get('filesize') or best.get('filesize_approx') or 0)
            if best_audio:
                total += int(best_audio.get('filesize')
                             or best_audio.get('filesize_approx') or 0)
            label = dict(BUCKETS).get(limit) or f'{best.get("height")}P'
            out.append(Format(
                id=f'bili-{limit or "sd"}',
                label=label,
                width=int(best.get('width') or 0),
                height=int(best.get('height') or 0),
                ext='mp4',
                vcodec=(best.get('vcodec') or '').split('.')[0],
                acodec=(best_audio.get('acodec') or '').split('.')[0] if best_audio else '',
                fps=int(best.get('fps') or 0),
                bytes=total,
                bitrate=int(((best.get('tbr') or 0)
                             + (best_audio.get('abr') or 0) if best_audio else 0) * 1000),
                extra={'video_id': best.get('format_id'),
                       'audio_id': best_audio.get('format_id') if best_audio else None},
            ))

        if not out:
            raise VdlError(ErrorCode.NO_STREAM, '没有解析到视频轨',
                           '可能是直播/番剧受限内容；先在浏览器里确认能播放')

        out[0].recommended = True
        warnings = []
        if not cookies_file('bilibili').exists():
            warnings.append('未登录：B站通常最高 720P；运行 `vdl auth bilibili` 可解锁高清晰度')
        elif out[0].height < 1080:
            warnings.append(f'当前登录态最高 {out[0].height}P，可能是大会员专享清晰度')

        media = Media(
            id=str(info.get('id') or ''),
            title=info.get('title') or 'B站视频',
            author=info.get('uploader') or '',
            duration_ms=int((info.get('duration') or 0) * 1000),
            thumbnail=info.get('thumbnail') or '',
            source_url=info.get('webpage_url') or url,
            platform=self.platform,
        )
        return ProbeResult(ok=True, platform=self.platform, engine=self.name,
                           media=media, formats=out, warnings=warnings)

    # ------------------------------------------------------------ 下载

    def download(self, probe, format_id, dest_dir, force=False, progress=None):
        fmt = next((f for f in probe.formats if f.id == format_id), None)
        if fmt is None or not fmt.extra.get('video_id'):
            raise VdlError(ErrorCode.BAD_INPUT, f'没有这个档位: {format_id}',
                           '先跑 probe 看 formats[].id')

        out_dir = pathlib.Path(dest_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        label = safe_name(fmt.label, 12, fallback=fmt.id)
        dest = out_dir / f'{probe.media.id}_{safe_name(probe.media.title)}_{label}.mp4'
        if dest.exists() and not force:
            return DownloadResult(ok=True, path=str(dest), bytes=dest.stat().st_size,
                                  format_id=fmt.id, skipped=True, media=probe.media)

        total = fmt.bytes or 0
        seen = {}

        def hook(ev):
            # 两条流（视频+音频）分别回调，这里按文件名累计，避免百分比来回跳
            if ev.get('status') != 'downloading':
                return
            name = ev.get('filename') or 'stream'
            seen[name] = int(ev.get('downloaded_bytes') or 0)
            if progress:
                try:
                    progress(sum(seen.values()), total or 0)
                except Exception:
                    pass

        spec = f"{fmt.extra['video_id']}+{fmt.extra['audio_id']}" \
            if fmt.extra.get('audio_id') else f"{fmt.extra['video_id']}"
        opts = {
            'format': spec,
            'outtmpl': str(dest.with_suffix('')) + '.%(ext)s',
            'merge_output_format': 'mp4',
            'progress_hooks': [hook],
            'overwrites': bool(force),
        }
        try:
            with self._ydl(**opts) as ydl:
                info = ydl.extract_info(probe.media.source_url, download=True)
        except VdlError:
            raise
        except Exception as e:                   # noqa: BLE001
            raise self._wrap(e) from None

        path = dest
        for item in (info or {}).get('requested_downloads') or []:
            if item.get('filepath'):
                path = pathlib.Path(item['filepath'])
                break
        if not path.exists():                    # 合并后扩展名可能变，兜底找同名
            hits = list(out_dir.glob(f'{dest.stem}.*'))
            path = hits[0] if hits else dest
        if not path.exists():
            raise VdlError(ErrorCode.DOWNLOAD_FAILED, '下载完成但找不到落地文件',
                           '检查输出目录权限')

        return DownloadResult(ok=True, path=str(path), bytes=path.stat().st_size,
                              format_id=fmt.id, media=probe.media)
