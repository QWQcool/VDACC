"""常驻 yt-dlp helper：stdin/stdout 按行 JSON。

TS 侧只拉起一次，之后每次 probe 复用同一个 YoutubeDL 实例，
从而避开 yt-dlp.exe 每次启动解包 ~2.5s 的开销。
"""

import json
import os
import pathlib
import sys

import yt_dlp

COOKIE = pathlib.Path(os.environ.get('LOCALAPPDATA', '')) / 'vdl' / 'auth' / 'bilibili.cookies.txt'

OPTS = {
    'quiet': True,
    'no_warnings': True,
    'noplaylist': True,
    'socket_timeout': 20,
    'retries': 2,
    'continuedl': True,
}
if COOKIE.exists():
    OPTS['cookiefile'] = str(COOKIE)

KEEP = ('id', 'title', 'uploader', 'duration', 'thumbnail', 'webpage_url', 'formats')


def reply(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main():
    ydl = yt_dlp.YoutubeDL(OPTS)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            url = req.get('url') or ''
            info = ydl.extract_info(url, download=False)
            if info.get('entries'):
                info = next((x for x in info['entries'] if x), info)
            reply({'id': req.get('id'), 'ok': True,
                   'info': {k: info.get(k) for k in KEEP}})
        except Exception as e:                   # noqa: BLE001
            reply({'id': (req or {}).get('id') if isinstance(req, dict) else None,
                   'ok': False, 'error': f'{type(e).__name__}: {e}'})
    return 0


if __name__ == '__main__':
    sys.exit(main())
