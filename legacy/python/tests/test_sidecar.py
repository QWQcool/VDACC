# -*- coding: utf-8 -*-
"""封面 / 字幕落盘的端到端测试（用本地 HTTP 桩，不联网）。

字幕的真实样本不好找（B站 多数视频没有 CC），所以这里直接验证
「取 JSON → 转 SRT → 写同名文件」这条链路，把未验证的缺口补上。
"""

import http.server
import json
import pathlib
import shutil
import tempfile
import threading
import unittest

from vdl.core.models import Format
from vdl.core.sidecar import save_cover
from vdl.engines._ytdlp import YtdlpBase

JPEG = b'\xff\xd8\xff\xe0' + b'0' * 128
SUBS = {'body': [{'from': 0, 'to': 1.5, 'content': '你好'},
                 {'from': 2, 'to': 3, 'content': 'world'}]}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/sub.json':
            body = json.dumps(SUBS, ensure_ascii=False).encode('utf-8')
            ctype = 'application/json'
        elif self.path == '/cover.jpg':
            body, ctype = JPEG, 'image/jpeg'
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):               # 测试里不要刷屏
        pass


class SidecarTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.tmp = pathlib.Path(tempfile.mkdtemp(prefix='vdl-side-'))

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def url(self, path):
        return f'http://127.0.0.1:{self.port}{path}'

    def test_cover_saved_next_to_video(self):
        video = self.tmp / 'v.mp4'
        video.write_bytes(b'video')
        out = save_cover(self.url('/cover.jpg'), str(video))
        self.assertTrue(out.endswith('.jpg'))
        self.assertTrue(pathlib.Path(out).read_bytes().startswith(b'\xff\xd8'))

    def test_cover_failure_is_silent(self):
        video = self.tmp / 'x.mp4'
        video.write_bytes(b'video')
        self.assertEqual(save_cover('', str(video)), '')
        self.assertEqual(save_cover(self.url('/missing.jpg'), str(video)), '')

    def test_subs_converted_to_srt(self):
        video = self.tmp / 's.mp4'
        video.write_bytes(b'video')
        fmt = Format(id='x', label='1080P',
                     extra={'subtitles': [{'lang': 'zh-CN', 'url': self.url('/sub.json')}]})
        YtdlpBase._save_subs(fmt, video)

        srt = video.with_suffix('.srt')
        self.assertTrue(srt.exists())
        text = srt.read_text(encoding='utf-8')
        self.assertIn('00:00:00,000 --> 00:00:01,500', text)
        self.assertIn('你好', text)

    def test_no_subtitles_no_file(self):
        video = self.tmp / 'n.mp4'
        video.write_bytes(b'video')
        YtdlpBase._save_subs(Format(id='y', label='720P'), video)
        self.assertFalse(video.with_suffix('.srt').exists())


if __name__ == '__main__':
    unittest.main()
