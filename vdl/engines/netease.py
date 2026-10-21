# -*- coding: utf-8 -*-
"""网易云音乐引擎。

2026-10-21 实测（重要）：**不需要 eapi/weapi 加密**。
老的 `GET /api/song/enhance/player/url?ids=[id]&br=<br>` 带 `MUSIC_U` cookie
就能直接返回 `level=lossless` 的 FLAC；不带 cookie 对免费曲返回 320K mp3。
所以这个引擎只依赖标准库 + `vdl auth netease` 导出的 cookie。

元数据与歌词同样免签名：
- `/api/song/detail/?id=&ids=[id]`
- `/api/song/lyric?id=&lv=1&kv=1&tv=-1`

落盘后如果有 ffmpeg，就写 title/artist/album/date + 封面；歌词另存 `.lrc`。
"""

import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from .base import Engine
from ..core.download import stream_to_file
from ..core.env import ffmpeg_path
from ..core.errors import ErrorCode, VdlError
from ..core.models import DownloadResult, Format, Media, ProbeResult
from ..core.naming import safe_name
from ..core.paths import auth_file

API = 'https://music.163.com'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')

# br 是"请求的最高码率"，服务端按账号权限降级并返回 level
LEVELS = (
    (999000, 'lossless', '无损 FLAC'),
    (320000, 'exhigh', '极高 320K'),
)


def load_cookie(site='netease'):
    """从 storage_state 里拼 Cookie 头；没有就返回空串（免费曲仍可下 320K）。"""
    path = auth_file(site)
    if not path.exists():
        return ''
    try:
        state = json.loads(path.read_text(encoding='utf-8'))
    except Exception:                            # noqa: BLE001 - 坏文件按未登录处理
        return ''
    parts = [f"{c.get('name')}={c.get('value')}"
             for c in state.get('cookies', [])
             if 'music.163.com' in (c.get('domain') or '')]
    return '; '.join(parts)


def _head_size(url):
    """HEAD 拿真实体积；CDN 不支持 HEAD 时返回 0（上层退回接口值）。"""
    try:
        req = urllib.request.Request(url, method='HEAD',
                                     headers={'User-Agent': UA, 'Referer': API + '/'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.headers.get('Content-Length') or ''
            return int(raw) if raw.isdigit() else 0
    except Exception:                            # noqa: BLE001
        return 0


def _get_json(url, cookie='', timeout=20):
    headers = {
        'User-Agent': UA,
        'Referer': API + '/',
        'Accept': 'application/json, text/plain, */*',
    }
    if cookie:
        headers['Cookie'] = cookie
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8', 'replace'))
    except urllib.error.HTTPError as e:
        raise VdlError(ErrorCode.HTTP_ERROR,
                       f'网易云接口 HTTP {e.code}',
                       '稍后重试；持续失败检查网络/代理') from None
    except urllib.error.URLError as e:
        raise VdlError(ErrorCode.NETWORK, f'网易云网络错误: {e.reason}') from None
    except ValueError:
        raise VdlError(ErrorCode.BAD_JSON, '网易云返回的不是 JSON',
                       '可能被风控拦截，稍后重试') from None


class NeteaseEngine(Engine):
    name = 'netease-api'
    platform = 'netease'
    HOSTS = ('music.163.com', 'y.music.163.com', '163cn.tv')

    def __init__(self, log=None):
        self.log = log or (lambda *_: None)
        self._song_cache = {}      # sid -> detail，probe 完给 download 复用

    # ------------------------------------------------------------ 路由

    def can_handle(self, url):
        raw = (url or '').strip()
        if raw.isdigit() and len(raw) <= 12:
            return True
        host = (urllib.parse.urlparse(raw).hostname or '').lower()
        return any(host == h or host.endswith('.' + h) for h in self.HOSTS)

    # ------------------------------------------------------------ 解析

    def _extract_id(self, url):
        raw = (url or '').strip()
        if raw.isdigit():
            return raw
        parsed = urllib.parse.urlparse(raw)
        qs = urllib.parse.parse_qs(parsed.query)
        if qs.get('id') and qs['id'][0].isdigit():
            return qs['id'][0]
        m = re.search(r'/song/(\d+)', parsed.path)
        if m:
            return m.group(1)
        if '163cn.tv' in (parsed.hostname or ''):
            # 短链：跟随跳转后再抠一次
            try:
                req = urllib.request.Request(raw, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    return self._extract_id(resp.geturl())
            except Exception:                    # noqa: BLE001
                return ''
        return ''

    def _detail(self, sid, cookie=''):
        data = _get_json(f'{API}/api/song/detail/?id={sid}&ids=%5B{sid}%5D', cookie)
        songs = data.get('songs') or []
        if not songs:
            raise VdlError(ErrorCode.FILTERED, f'查不到这首歌（id={sid}）',
                           '确认链接正确；曲目可能已下架')
        return songs[0]

    def _player_url(self, sid, br, cookie=''):
        q = urllib.parse.urlencode({'ids': f'[{sid}]', 'br': str(br)})
        data = _get_json(f'{API}/api/song/enhance/player/url?{q}', cookie)
        items = data.get('data') or []
        if not items:
            return None
        item = items[0]
        if int(item.get('code') or 0) != 200 or not item.get('url'):
            return None
        # 接口里的 size 与真实文件可能差 20%+（实测 18.99MB vs 23.12MB），
        # 所以以 CDN 的 Content-Length 为准；拿不到才退回接口值。
        real = _head_size(item['url'])
        if real:
            item['size'] = real
        return item

    def probe(self, url):
        sid = self._extract_id(url)
        if not sid:
            raise VdlError(ErrorCode.BAD_INPUT, f'识别不出歌曲 ID: {url}',
                           '支持 song?id=… / /song/<id> / 163cn.tv 短链')

        cookie = load_cookie()
        song = self._detail(sid, cookie)
        self._song_cache[sid] = song

        formats, warnings = [], []
        for br, level, label in LEVELS:
            item = self._player_url(sid, br, cookie)
            if not item:
                continue
            ext = (item.get('type') or 'mp3').lower()
            formats.append(Format(
                id=level,
                label=label,
                ext=ext,
                acodec=ext,
                bytes=int(item.get('size') or 0),
                bitrate=int(item.get('br') or 0),
                urls=[item['url']],
            ))

        if not formats:
            if not cookie:
                raise VdlError(ErrorCode.NEED_LOGIN, '这首需要登录/会员才能播放',
                               '先运行 `vdl auth netease` 扫码登录')
            raise VdlError(ErrorCode.FILTERED,
                           '接口没有返回可播放地址（无版权 / 需购买 / 地区限制）',
                           '换一首；数字专辑需要单独购买')

        formats[0].recommended = True
        if not cookie:
            warnings.append('未登录：最高 320K；运行 `vdl auth netease` 可解锁无损')

        album = song.get('album') or {}
        artists = song.get('artists') or []
        media = Media(
            id=str(sid),
            title=song.get('name') or f'netease_{sid}',
            author=' / '.join(a.get('name') or '' for a in artists).strip(' /'),
            duration_ms=int(song.get('duration') or 0),
            thumbnail=album.get('picUrl') or '',
            source_url=f'{API}/song?id={sid}',
            platform=self.platform,
        )
        return ProbeResult(ok=True, platform=self.platform, engine=self.name,
                           media=media, formats=formats, warnings=warnings)

    # ------------------------------------------------------------ 下载

    def download(self, probe, format_id, dest_dir, force=False, progress=None):
        fmt = next((f for f in probe.formats if f.id == format_id), None)
        if fmt is None:
            raise VdlError(ErrorCode.BAD_INPUT, f'没有这个档位: {format_id}',
                           '先跑 probe 看 formats[].id')
        if not fmt.urls:
            raise VdlError(ErrorCode.NO_STREAM, '该档位没有可用地址',
                           '重新 probe 一次（直链会过期）')

        out_dir = pathlib.Path(dest_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        label = safe_name(fmt.label, 14, fallback=fmt.id)
        dest = out_dir / f'{probe.media.id}_{safe_name(probe.media.title)}_{label}.{fmt.ext}'
        if dest.exists() and not force:
            return DownloadResult(ok=True, path=str(dest), bytes=dest.stat().st_size,
                                  format_id=fmt.id, skipped=True, media=probe.media)

        part = dest.with_name(f'{dest.stem}.part{dest.suffix}')
        try:
            written, _total = stream_to_file(
                fmt.urls[0], part,
                headers={'User-Agent': UA, 'Referer': API + '/'},
                progress=progress)
        except Exception as e:                   # noqa: BLE001
            if part.exists():
                part.unlink(missing_ok=True)
            raise VdlError(ErrorCode.DOWNLOAD_FAILED,
                           f'音频下载失败: {type(e).__name__}: {e}') from None
        if written < 100 * 1024:
            part.unlink(missing_ok=True)
            raise VdlError(ErrorCode.BAD_PAYLOAD, f'文件过小（{written} 字节）',
                           '多半拿到的是试听片段或错误页')

        warnings = self._write_metadata(part, dest, probe.media.id, fmt)
        return DownloadResult(ok=True, path=str(dest), bytes=dest.stat().st_size,
                              format_id=fmt.id, media=probe.media, warnings=warnings)

    # ------------------------------------------------------------ 元数据

    def _write_metadata(self, part, dest, sid, fmt):
        """用 ffmpeg 写标签/封面；没有 ffmpeg 就原样落盘并如实告警。"""
        warnings = []
        cookie = load_cookie()
        song = self._song_cache.get(sid) or {}
        if not song:
            try:
                song = self._detail(sid, cookie)
            except VdlError:
                song = {}

        ff = ffmpeg_path()
        if not ff:
            os.replace(part, dest)
            return ['未找到 ffmpeg：已下载音频，但没写标签/封面']

        flags = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
        raw_cover = dest.with_name('__vdl_cover.img')
        small_cover = dest.with_name('__vdl_cover.jpg')
        cover_path = ''

        pic = ((song.get('album') or {}).get('picUrl') or '')
        if pic:
            try:
                req = urllib.request.Request(pic, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    raw_cover.write_bytes(resp.read())
                # 原图常见 1920×1920 PNG（实测 5.25MB），直接内嵌会把文件撑大三成。
                # 统一缩到 800px JPEG，封面约 100KB。
                subprocess.run(
                    [ff, '-y', '-hide_banner', '-loglevel', 'error',
                     '-i', str(raw_cover), '-vf', "scale='min(800,iw)':-2",
                     '-q:v', '3', str(small_cover)],
                    check=True, capture_output=True, creationflags=flags)
                cover_path = str(small_cover)
            except Exception:                    # noqa: BLE001
                cover_path = str(raw_cover) if raw_cover.exists() else ''

        out = dest.with_name(f'{dest.stem}.mux{dest.suffix}')
        cmd = [ff, '-y', '-hide_banner', '-loglevel', 'error', '-i', str(part)]
        if cover_path:
            cmd += ['-i', cover_path]
        cmd += ['-map', '0:a']
        if cover_path:
            cmd += ['-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic']
        cmd += ['-c:a', 'copy']

        album = song.get('album') or {}
        artists = ' / '.join(a.get('name') or '' for a in (song.get('artists') or []))
        published = int(song.get('publishTime') or 0)
        year = ''
        if published > 10 ** 11:                 # 毫秒时间戳
            year = time.strftime('%Y', time.localtime(published / 1000))
        elif published > 10 ** 8:                # 秒时间戳
            year = time.strftime('%Y', time.localtime(published))
        tags = {
            'title': song.get('name') or '',
            'artist': artists,
            'album': album.get('name') or '',
            'date': year,
            'comment': 'downloaded by vdl',
        }
        for key, value in tags.items():
            if value:
                cmd += ['-metadata', f'{key}={value}']
        if dest.suffix.lower() == '.mp3':
            cmd += ['-id3v2_version', '3']
        cmd += [str(out)]

        try:
            subprocess.run(cmd, check=True, capture_output=True, creationflags=flags)
            os.replace(out, dest)
            part.unlink(missing_ok=True)
        except Exception as e:                   # noqa: BLE001
            if out.exists():
                out.unlink(missing_ok=True)
            os.replace(part, dest)
            warnings.append(f'写入标签失败（{type(e).__name__}），已保留音频')
        finally:
            for temp in (raw_cover, small_cover):
                if temp.exists():
                    temp.unlink(missing_ok=True)

        # 歌词单独落 .lrc：ID3 的 USLT 各播放器支持不一，文件更通用
        try:
            lyric = _get_json(f'{API}/api/song/lyric?id={sid}&lv=1&kv=1&tv=-1', cookie)
            text = ((lyric.get('lrc') or {}).get('lyric') or '').strip()
            if text:
                dest.with_suffix('.lrc').write_text(text + '\n', encoding='utf-8')
        except Exception:                        # noqa: BLE001
            warnings.append('歌词获取失败，未生成 .lrc')

        return warnings
