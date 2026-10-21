# -*- coding: utf-8 -*-
"""基于 yt-dlp 的引擎基类。

B站 和「未知站点兜底」共用这套逻辑，差别只在：
- cookie 用哪个站点；
- 平台名怎么取；
- 有没有额外的提示（比如未登录只能 720P）。

要改「一个清晰度一行 / 音视频成对合并 / 两条流进度聚合」，改这里一处即可。
"""

import os
import pathlib
import urllib.parse

from .base import Engine
from ..core.env import ffmpeg_path
from ..core.errors import ErrorCode, VdlError
from ..core.models import DownloadResult, Format, Media, ProbeResult
from ..core.naming import safe_name
from ..core.paths import cookies_file

# 按**宽度**归档：B站 有不少 2.35:1 宽银幕（1920×816、4096×1740），
# 按高度会整体下移一档（实测把 4K 判成 2K、1080P 判成 720P）。
BUCKETS = ((3840, '4K'), (2560, '2K'), (1920, '1080P'), (1280, '720P'), (854, '480P'))


class YtdlpBase(Engine):
    cookie_site = ''          # '' = 不带 cookie
    format_prefix = 'y-'      # 档位 id 前缀，各站点保持稳定（bili-... / gen-...）

    def __init__(self, log=None):
        self.log = log or (lambda *_: None)

    # ------------------------------------------------------------ yt-dlp

    def _ydl(self, **overrides):
        try:
            import yt_dlp
        except ImportError:
            raise VdlError(ErrorCode.ENGINE_UNAVAILABLE,
                           '缺少 yt-dlp（该引擎依赖它）',
                           '在仓库 venv 里执行：pip install yt-dlp') from None

        opts = {
            'quiet': True,
            'no_warnings': True,
            'noprogress': True,
            'noplaylist': True,
            'socket_timeout': 20,
            'retries': 2,
        }
        if self.cookie_site:
            jar = cookies_file(self.cookie_site)
            if jar.exists():
                opts['cookiefile'] = str(jar)
        ff = ffmpeg_path()
        if ff:
            opts['ffmpeg_location'] = os.path.dirname(ff)
        opts.update(overrides)
        return yt_dlp.YoutubeDL(opts)

    @staticmethod
    def _wrap(exc):
        msg = str(getattr(exc, 'msg', '') or exc).replace('ERROR: ', '').strip()
        low = msg.lower()
        if 'unsupported url' in low:
            return VdlError(ErrorCode.UNSUPPORTED_URL, msg,
                            '这个站点 yt-dlp 也不支持，可以试着把完整页面链接贴过来')
        if 'login' in low or '大会员' in msg or 'premium' in low or 'vip' in low:
            return VdlError(ErrorCode.NEED_LOGIN, msg,
                            '运行 `vdl auth <site>` 重新登录后重试')
        if 'http error 404' in low:
            return VdlError(ErrorCode.HTTP_ERROR, msg,
                            '页面不存在或需要登录；确认链接没写错')
        return VdlError(ErrorCode.DOWNLOAD_FAILED, msg,
                        '确认链接可播放；必要时在浏览器里试')

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

    # ------------------------------------------------------------ 解析

    def _platform_of(self, info):
        key = (info.get('extractor_key') or info.get('extractor') or '').lower()
        return key or 'generic'

    def _extra_warnings(self, formats):
        return []

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
                  if (f.get('vcodec') or 'none') != 'none' and f.get('width')]
        audios = [f for f in formats
                  if (f.get('acodec') or 'none') != 'none'
                  and (f.get('vcodec') or 'none') == 'none']
        best_audio = max(audios, key=lambda a: (a.get('abr') or a.get('tbr') or 0),
                         default=None)

        out = []
        groups = {}
        for f in videos:
            limit, _label = self._bucket(int(f.get('width') or 0))
            groups.setdefault(limit, []).append(f)

        for limit in sorted(groups, reverse=True):
            best = max(groups[limit], key=self._score)
            total = int(best.get('filesize') or best.get('filesize_approx') or 0)
            if best_audio:
                total += int(best_audio.get('filesize')
                             or best_audio.get('filesize_approx') or 0)
            label = dict(BUCKETS).get(limit) or f'{best.get("height")}P'
            out.append(Format(
                id=f'{self.format_prefix}{limit or "sd"}',
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

        # 纯音频站点（播客/音乐）：没有视频轨就直接给一条音频档
        if not out and best_audio:
            ext = (best_audio.get('ext') or 'm4a').lower()
            out.append(Format(
                id='audio',
                label='音频',
                ext=ext,
                acodec=(best_audio.get('acodec') or '').split('.')[0],
                bytes=int(best_audio.get('filesize')
                          or best_audio.get('filesize_approx') or 0),
                bitrate=int((best_audio.get('abr') or best_audio.get('tbr') or 0) * 1000),
                extra={'video_id': None, 'audio_id': best_audio.get('format_id')},
            ))

        if not out:
            raise VdlError(ErrorCode.NO_STREAM, '没有解析到可下载的音视频轨',
                           '可能是直播/受限内容；先在浏览器里确认能播放')

        out[0].recommended = True
        media = Media(
            id=str(info.get('id') or ''),
            title=info.get('title') or '未命名',
            author=info.get('uploader') or info.get('channel') or '',
            duration_ms=int((info.get('duration') or 0) * 1000),
            thumbnail=info.get('thumbnail') or '',
            source_url=info.get('webpage_url') or url,
            platform=self._platform_of(info),
        )
        return ProbeResult(ok=True, platform=media.platform, engine=self.name,
                           media=media, formats=out,
                           warnings=self._extra_warnings(out))

    # ------------------------------------------------------------ 下载

    def download(self, probe, format_id, dest_dir, force=False, progress=None):
        fmt = next((f for f in probe.formats if f.id == format_id), None)
        if fmt is None or not (fmt.extra.get('video_id') or fmt.extra.get('audio_id')):
            raise VdlError(ErrorCode.BAD_INPUT, f'没有这个档位: {format_id}',
                           '先跑 probe 看 formats[].id')

        out_dir = pathlib.Path(dest_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        label = safe_name(fmt.label, 12, fallback=fmt.id)
        dest = out_dir / f'{probe.media.id}_{safe_name(probe.media.title)}_{label}.{fmt.ext}'
        if dest.exists() and not force:
            return DownloadResult(ok=True, path=str(dest), bytes=dest.stat().st_size,
                                  format_id=fmt.id, skipped=True, media=probe.media)

        total = fmt.bytes or 0
        seen = {}

        def hook(ev):
            # 视频/音频两条流分别回调；按文件名累计，避免百分比来回跳
            if ev.get('status') != 'downloading':
                return
            seen[ev.get('filename') or 'stream'] = int(ev.get('downloaded_bytes') or 0)
            if progress:
                try:
                    progress(sum(seen.values()), total or 0)
                except Exception:
                    pass

        vid, aid = fmt.extra.get('video_id'), fmt.extra.get('audio_id')
        spec = f'{vid}+{aid}' if vid and aid else (vid or aid)
        opts = {
            'format': spec,
            'outtmpl': str(dest.with_suffix('')) + '.%(ext)s',
            'progress_hooks': [hook],
            'overwrites': bool(force),
        }
        if vid and aid:
            opts['merge_output_format'] = 'mp4'

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
            hits = [p for p in out_dir.glob(f'{dest.stem}.*') if p.is_file()]
            path = hits[0] if hits else dest
        if not path.exists():
            raise VdlError(ErrorCode.DOWNLOAD_FAILED, '下载完成但找不到落地文件',
                           '检查输出目录权限')

        return DownloadResult(ok=True, path=str(path), bytes=path.stat().st_size,
                              format_id=fmt.id, media=probe.media)
