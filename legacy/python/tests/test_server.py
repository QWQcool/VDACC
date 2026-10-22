# -*- coding: utf-8 -*-
"""服务端安全边界测试：进程内起服务，只用标准库。

这三条（token / Origin / 路径越界）是 AGENTS.md 里的硬约束，
以后改 server.py 时如果谁把校验删了，这里会立刻红。
"""

import json
import pathlib
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from vdl.server import Hub, JobStore, make_server

TOKEN = 'test-token'


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='vdl-test-')
        cls.httpd, cls.cfg = make_server(port=0, out_dir=cls.tmp, token=TOKEN,
                                         log=lambda *_: None, persist=False)
        cls.base = f'http://127.0.0.1:{cls.cfg.port}'
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # -- helpers

    def _call(self, path, method='GET', body=None, token=TOKEN, origin=None):
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data:
            req.add_header('Content-Type', 'application/json')
        if token:
            req.add_header('X-VDL-Token', token)
        if origin:
            req.add_header('Origin', origin)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    # -- 鉴权

    def test_health_requires_token(self):
        status, _ = self._call('/api/health', token=None)
        self.assertEqual(status, 401)

    def test_health_ok_with_token(self):
        status, body = self._call('/api/health')
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['ok'])

    def test_token_via_query(self):
        status, _ = self._call(f'/api/health?token={TOKEN}', token=None)
        self.assertEqual(status, 200)

    # -- Origin

    def test_foreign_origin_rejected(self):
        status, _ = self._call('/api/probe', method='POST',
                               body={'url': 'x'}, origin='http://evil.example')
        self.assertEqual(status, 403)

    def test_same_origin_allowed(self):
        status, _ = self._call('/api/probe', method='POST',
                               body={'url': ''}, origin=self.base)
        self.assertEqual(status, 400)           # 到业务校验了，说明 Origin 放行

    # -- 路径越界

    def test_reveal_outside_output_dir(self):
        outside = str(pathlib.Path.home())
        status, body = self._call('/api/reveal', method='POST', body={'path': outside})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)['error']['code'], 'bad_input')

    # -- 静态与输入

    def test_index_served(self):
        status, body = self._call('/')
        self.assertEqual(status, 200)
        self.assertIn(b'<!doctype html>', body.lower())

    def test_probe_missing_url(self):
        status, body = self._call('/api/probe', method='POST', body={})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)['error']['code'], 'bad_input')

    def test_unknown_api(self):
        status, _ = self._call('/api/nope')
        self.assertEqual(status, 404)

    # -- 文件回传

    def test_file_download(self):
        target = pathlib.Path(self.tmp) / 'demo.bin'
        target.write_bytes(b'hello')
        self.cfg.jobs.jobs['job-ok'] = {'id': 'job-ok', 'status': 'done',
                                        'path': str(target)}
        status, body = self._call('/api/files/job-ok')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'hello')

    def test_file_requires_done_job(self):
        status, _ = self._call('/api/files/missing')
        self.assertEqual(status, 404)


class JobPersistenceTest(unittest.TestCase):
    """重启后历史不能丢；上次没跑完的必须标成中断，而不是假装还在跑。"""

    def test_interrupted_marked_on_load(self):
        tmp = pathlib.Path(tempfile.mkdtemp(prefix='vdl-jobs-'))
        try:
            store_file = tmp / 'jobs.json'
            store_file.write_text(json.dumps({'jobs': [
                {'id': 'a', 'status': 'running', 'url': 'x'},
                {'id': 'b', 'status': 'done', 'url': 'y', 'bytes': 1},
            ]}, ensure_ascii=False), encoding='utf-8')

            jobs = JobStore(tmp, Hub(), log=lambda *_: None,
                            store_path=store_file, start_worker=False)
            self.assertEqual(jobs.get('a')['status'], 'failed')
            self.assertEqual(jobs.get('a')['error']['code'], 'interrupted')
            self.assertEqual(jobs.get('b')['status'], 'done')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_persist_writes_history(self):
        tmp = pathlib.Path(tempfile.mkdtemp(prefix='vdl-jobs-'))
        try:
            store_file = tmp / 'jobs.json'
            jobs = JobStore(tmp, Hub(), log=lambda *_: None,
                            store_path=store_file, start_worker=False)
            jobs.jobs['x'] = {'id': 'x', 'status': 'done'}
            jobs.order.append('x')
            jobs._persist()
            saved = json.loads(store_file.read_text(encoding='utf-8'))
            self.assertEqual(saved['jobs'][0]['id'], 'x')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
