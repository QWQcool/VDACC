# -*- coding: utf-8 -*-
"""视频旁边的附加文件：封面、字幕。

原则：**附属文件失败不影响视频**。用户要的是视频，封面/字幕拿不到就静默跳过，
并在返回值里留空，让调用方决定要不要提示。
"""

import pathlib
import urllib.parse
import urllib.request

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')


def _referer_of(source_url):
    parsed = urllib.parse.urlparse(source_url or '')
    return f'{parsed.scheme}://{parsed.netloc}/' if parsed.netloc else ''


def save_cover(url, video_path, source_url=''):
    """把封面存成与视频同名的图片，返回路径；失败返回空串。"""
    if not url:
        return ''
    try:
        headers = {'User-Agent': UA}
        ref = _referer_of(source_url)
        if ref:
            headers['Referer'] = ref
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
            ctype = (resp.headers.get('Content-Type') or '').lower()
    except Exception:                            # noqa: BLE001
        return ''
    if not data:
        return ''
    if 'png' in ctype:
        ext = '.png'
    elif 'webp' in ctype:
        ext = '.webp'
    else:
        ext = '.jpg'
    target = pathlib.Path(video_path).with_suffix(ext)
    try:
        target.write_bytes(data)
    except OSError:
        return ''
    return str(target)
