# -*- coding: utf-8 -*-
"""vdl serve —— 本地 Web 服务（P2）。

安全模型（本地工具同样要防 CSRF：任何网页都能向 127.0.0.1 发请求）：
- 只绑回环地址；
- /api/* 必须带启动时生成的 token；
- 带 Origin 的请求必须来自本服务自己的源；
- /api/reveal 只能打开输出目录内的路径，禁止任意文件/程序被"打开"。
"""

import json
import mimetypes
import os
import pathlib
import queue
import secrets
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import SCHEMA_VERSION, __version__
from .core import router
from .core.errors import ErrorCode, VdlError
from .core.models import ProbeResult
from .engines.base import pick_format

MAX_BODY = 1 << 20
WEB_DIR = pathlib.Path(__file__).resolve().parent / 'web'


# ---------------------------------------------------------------- 事件总线

class Hub:
    """SSE 订阅中心。慢客户端丢事件，不能拖住下载线程。"""

    def __init__(self):
        self._subs = set()
        self._lock = threading.Lock()

    def subscribe(self):
        q = queue.Queue(maxsize=256)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs.discard(q)

    def publish(self, event):
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            if q.full():
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
            try:
                q.put_nowait(event)
            except queue.Full:
                pass


# ---------------------------------------------------------------- 任务队列

class JobStore:
    """单 worker 串行下载。

    串行的理由：抖音对同一 IP 的并发请求不友好，而且 profile/凭据以后也可能有
    单例约束。UI 上多选是多个任务，但执行仍然排队。
    """

    def __init__(self, out_dir, hub, log=print):
        self.out_dir = pathlib.Path(out_dir)
        self.hub = hub
        self.log = log
        self.jobs = {}
        self.order = []
        self._q = queue.Queue()
        self._lock = threading.Lock()
        threading.Thread(target=self._worker, daemon=True, name='vdl-worker').start()

    # -- 对外

    def submit(self, url, format_id=None, force=False):
        jid = secrets.token_hex(4)
        job = {
            'id': jid, 'url': url, 'formatId': format_id or '', 'force': bool(force),
            'status': 'queued', 'percent': 0, 'bytes': 0, 'total': None,
            'speed': 0, 'eta': None, 'path': '', 'title': '', 'platform': '',
            'error': None, 'createdAt': time.time(), 'finishedAt': None,
        }
        with self._lock:
            self.jobs[jid] = job
            self.order.append(jid)
        self._q.put(jid)
        self._emit(job)
        return job

    def get(self, jid):
        return self.jobs.get(jid)

    def list(self, limit=50):
        with self._lock:
            ids = list(reversed(self.order))[:limit]
        return [self.jobs[i] for i in ids]

    # -- 内部

    def _emit(self, job):
        self.hub.publish({'type': 'job', 'job': dict(job)})

    def _worker(self):
        while True:
            jid = self._q.get()
            job = self.jobs.get(jid)
            if job:
                self._run(job)

    def _run(self, job):
        job['status'] = 'running'
        self._emit(job)
        try:
            log = lambda m: self.log(f'[{job["id"]}] {m}')      # noqa: E731
            engine = router.route(job['url'], log=log)
            probe = engine.probe(job['url'])
            job['title'] = probe.media.title
            job['platform'] = probe.platform

            fmt = pick_format(probe, job['formatId'] or None)
            if fmt is None:
                raise VdlError(ErrorCode.BAD_INPUT, '没有匹配的档位',
                               '先在页面上重新解析一次')
            job['formatId'] = fmt.id
            job['total'] = fmt.bytes or None
            self._emit(job)

            last = {'t': time.time(), 'b': 0}

            def on_progress(written, total):
                if total:
                    job['total'] = total
                job['bytes'] = written
                job['percent'] = round(written / total * 100, 1) if total else 0
                now = time.time()
                dt = now - last['t']
                if dt >= 0.5:
                    speed = (written - last['b']) / dt
                    job['speed'] = int(speed)
                    job['eta'] = int((total - written) / speed) if total and speed > 0 else None
                    last['t'] = now
                    last['b'] = written
                    self._emit(job)

            dl = engine.download(probe, fmt.id, self.out_dir,
                                 force=job['force'], progress=on_progress)
            job.update(status='done', path=dl.path, bytes=dl.bytes, percent=100,
                       speed=0, eta=0, formatId=dl.format_id,
                       finishedAt=time.time())
        except VdlError as e:
            job.update(status='failed', error=e.to_dict(), finishedAt=time.time())
        except Exception as e:                       # noqa: BLE001 - 必须如实上报
            job.update(status='failed', finishedAt=time.time(),
                       error={'code': 'internal', 'message': f'{type(e).__name__}: {e}'})
            self.log(traceback.format_exc())
        self._emit(job)


# ---------------------------------------------------------------- HTTP

class Config:
    def __init__(self, host, port, token, out_dir, hub, jobs):
        self.host = host
        self.port = port
        self.token = token
        self.out_dir = pathlib.Path(out_dir)
        self.hub = hub
        self.jobs = jobs


def make_handler(cfg):
    class Handler(BaseHTTPRequestHandler):
        server_version = f'vdl/{__version__}'
        protocol_version = 'HTTP/1.0'          # 每个响应即关，SSE 语义最省事

        # -- 基础

        def log_message(self, fmt, *args):
            pass                                # 默认访问日志太吵

        def _send(self, code, body=b'', ctype='application/json; charset=utf-8'):
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _json(self, payload, code=200):
            self._send(code, json.dumps(payload, ensure_ascii=False).encode('utf-8'))

        def _err(self, code, message, next_action='', status=400):
            self._json({'ok': False,
                        'error': {'code': code, 'message': message,
                                  'next_action': next_action}}, status)

        def _read_json(self):
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                return None
            if length <= 0 or length > MAX_BODY:
                return None
            try:
                return json.loads(self.rfile.read(length).decode('utf-8'))
            except Exception:
                return None

        def _authorized(self):
            token = self.headers.get('X-VDL-Token') or ''
            if not token:
                qs = parse_qs(urlparse(self.path).query)
                token = (qs.get('token') or [''])[0]
            return secrets.compare_digest(token, cfg.token)

        def _origin_ok(self):
            origin = self.headers.get('Origin')
            if not origin:
                return True                      # curl / 同源导航
            return origin in (f'http://127.0.0.1:{cfg.port}',
                              f'http://localhost:{cfg.port}')

        # -- GET

        def do_GET(self):
            path = urlparse(self.path).path
            if path.startswith('/api/'):
                if not self._authorized():
                    return self._err('unauthorized', '缺少或错误的 token',
                                     '用启动时打印的带 token 的地址打开', 401)
                return self._api_get(path)
            return self._static(path)

        def _api_get(self, path):
            if path == '/api/health':
                return self._json({
                    'ok': True, 'version': __version__, 'schema': SCHEMA_VERSION,
                    'outDir': str(cfg.out_dir), 'jobs': len(cfg.jobs.jobs),
                })
            if path == '/api/jobs':
                return self._json({'ok': True, 'jobs': cfg.jobs.list()})
            if path.startswith('/api/jobs/'):
                job = cfg.jobs.get(path.rsplit('/', 1)[-1])
                if not job:
                    return self._err('not_found', '任务不存在', status=404)
                return self._json({'ok': True, 'job': job})
            if path == '/api/events':
                return self._sse()
            return self._err('not_found', f'没有这个接口: {path}', status=404)

        def _sse(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'close')
            self.end_headers()
            q = cfg.hub.subscribe()
            try:
                self.wfile.write(b'event: hello\ndata: {"ok":true}\n\n')
                self.wfile.flush()
                while True:
                    try:
                        ev = q.get(timeout=15)
                        body = json.dumps(ev, ensure_ascii=False)
                        self.wfile.write(f'data: {body}\n\n'.encode('utf-8'))
                    except queue.Empty:
                        self.wfile.write(b': ping\n\n')
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                cfg.hub.unsubscribe(q)

        # -- POST

        def do_POST(self):
            if not self._origin_ok():
                return self._err('bad_origin', '拒绝来自其他站点的请求', status=403)
            if not self._authorized():
                return self._err('unauthorized', '缺少或错误的 token',
                                 '用启动时打印的带 token 的地址打开', 401)
            path = urlparse(self.path).path
            payload = self._read_json() or {}

            if path == '/api/probe':
                url = (payload.get('url') or '').strip()
                if not url:
                    return self._err('bad_input', '缺少 url', '把链接粘贴完整')
                return self._json(router.probe(url).to_dict())

            if path == '/api/jobs':
                url = (payload.get('url') or '').strip()
                if not url:
                    return self._err('bad_input', '缺少 url')
                job = cfg.jobs.submit(url, payload.get('formatId'),
                                      bool(payload.get('force')))
                return self._json({'ok': True, 'job': job}, 202)

            if path == '/api/reveal':
                return self._reveal(payload.get('path') or '')

            return self._err('not_found', f'没有这个接口: {path}', status=404)

        def _reveal(self, raw):
            try:
                target = pathlib.Path(raw).resolve()
                root = cfg.out_dir.resolve()
                if target != root and root not in target.parents:
                    raise VdlError(ErrorCode.BAD_INPUT, '路径不在输出目录内',
                                   '只允许打开下载目录里的文件')
                if not target.exists():
                    raise VdlError(ErrorCode.BAD_INPUT, '文件不存在')
                if os.name == 'nt':
                    subprocess.Popen(['explorer', '/select,', str(target)])
                elif sys.platform == 'darwin':
                    subprocess.Popen(['open', '-R', str(target)])
                else:
                    subprocess.Popen(['xdg-open', str(target.parent)])
            except VdlError as e:
                return self._err(e.code, e.message, e.next_action)
            except Exception as e:                   # noqa: BLE001
                return self._err('internal', f'{type(e).__name__}: {e}')
            return self._json({'ok': True})

        # -- 静态

        def _static(self, path):
            if path in ('', '/'):
                path = '/index.html'
            base = WEB_DIR.resolve()
            target = (base / path.lstrip('/')).resolve()
            if base not in target.parents and target != base:
                return self._send(404, b'not found', 'text/plain; charset=utf-8')
            if not target.is_file():
                return self._send(404, b'not found', 'text/plain; charset=utf-8')
            ctype = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
            if ctype.startswith('text/') or ctype in ('application/javascript',
                                                      'application/json'):
                ctype += '; charset=utf-8'
            self._send(200, target.read_bytes(), ctype)

    return Handler


# ---------------------------------------------------------------- 启动

def serve(port=8765, out_dir='下载', token=None, open_browser=True, host='127.0.0.1'):
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    hub = Hub()
    jobs = JobStore(out, hub, log=lambda m: print(m, flush=True))
    cfg = Config(host, port, token or secrets.token_urlsafe(16), out, hub, jobs)

    try:
        httpd = ThreadingHTTPServer((host, cfg.port), make_handler(cfg))
    except OSError as e:
        print(f'端口 {cfg.port} 起不来：{e}')
        print('换一个端口：python -m vdl serve --port 8766')
        return 2

    cfg.port = httpd.server_address[1]
    url = f'http://{host}:{cfg.port}/?token={cfg.token}'
    print(f'vdl {__version__} 已启动')
    print(f'  地址: {url}')
    print(f'  输出: {cfg.out_dir.resolve()}')
    print('  Ctrl+C 停止')
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
    finally:
        httpd.server_close()
    return 0
