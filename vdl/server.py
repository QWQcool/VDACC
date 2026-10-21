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
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import SCHEMA_VERSION, __version__
from .core import router
from .core.config import load as load_config
from .core.errors import ErrorCode, VdlError
from .core.models import ProbeResult
from .core.paths import data_dir
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

    def __init__(self, out_dir, hub, log=print, store_path=None, start_worker=True):
        self.out_dir = pathlib.Path(out_dir)
        self.hub = hub
        self.log = log
        self.store_path = pathlib.Path(store_path) if store_path else None
        self.jobs = {}
        self.order = []
        self._q = queue.Queue()
        self._lock = threading.Lock()
        if self.store_path:
            self.store_path.parent.mkdir(parents=True, exist_ok=True)
        self._load()
        if start_worker:
            threading.Thread(target=self._worker, daemon=True,
                             name='vdl-worker').start()

    # -- 持久化

    def _load(self):
        """恢复历史；上次没跑完的任务标成 interrupted，不要假装它还在跑。"""
        if not self.store_path or not self.store_path.exists():
            return
        try:
            data = json.loads(self.store_path.read_text(encoding='utf-8'))
        except Exception:                        # noqa: BLE001 - 坏文件就当没历史
            return
        for job in (data.get('jobs') or [])[-100:]:
            if not isinstance(job, dict) or not job.get('id'):
                continue
            if job.get('status') in ('queued', 'running'):
                job['status'] = 'failed'
                job['error'] = {'code': 'interrupted',
                                'message': '上次会话中断，未完成'}
                job['finishedAt'] = time.time()
            self.jobs[job['id']] = job
            self.order.append(job['id'])

    def _persist(self):
        if not self.store_path:
            return
        try:
            payload = {'jobs': [self.jobs[i] for i in self.order[-100:]]}
            tmp = self.store_path.with_suffix('.tmp')
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
            os.replace(tmp, self.store_path)
        except Exception as e:                   # noqa: BLE001 - 不能因为存档失败影响下载
            self.log(f'任务历史保存失败: {type(e).__name__}: {e}')

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
        self._persist()
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
                # 预估体积可能偏小（B站 filesize_approx），到 100% 前留 0.1 的余量
                job['percent'] = min(99.9, round(written / total * 100, 1)) if total else 0
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
        self._persist()


# ---------------------------------------------------------------- HTTP

class Config:
    def __init__(self, host, port, token, out_dir, hub, jobs, allowed_origins=None):
        self.host = host
        self.port = port
        self.token = token
        self.out_dir = pathlib.Path(out_dir)
        self.hub = hub
        self.jobs = jobs
        self.allowed_origins = tuple(allowed_origins or ())


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
            own = (f'http://127.0.0.1:{cfg.port}', f'http://localhost:{cfg.port}')
            return origin in own or origin in cfg.allowed_origins

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
                    'theme': load_config().get('theme', 'light'),
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
            if path.startswith('/api/files/'):
                return self._file(path.rsplit('/', 1)[-1])
            return self._err('not_found', f'没有这个接口: {path}', status=404)

        def _file(self, job_id):
            """完成任务的原文件回传（手机/宿主取文件用），只允许输出目录内。"""
            job = cfg.jobs.get(job_id)
            if not job or job.get('status') != 'done' or not job.get('path'):
                return self._err('not_found', '任务不存在或未完成', status=404)
            target = pathlib.Path(job['path']).resolve()
            root = cfg.out_dir.resolve()
            if target != root and root not in target.parents:
                return self._err('bad_input', '路径不在输出目录内', status=403)
            if not target.exists():
                return self._err('bad_input', '文件已被移动或删除', status=404)

            ctype = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
            size = target.stat().st_size
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(size))
            self.send_header('Content-Disposition',
                             "attachment; filename*=UTF-8''" +
                             urllib.parse.quote(target.name))
            self.end_headers()
            try:
                with open(target, 'rb') as fh:
                    while True:
                        chunk = fh.read(256 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

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
                force = bool(payload.get('force'))
                ids = payload.get('formatIds')
                if isinstance(ids, list) and ids:
                    jobs = [cfg.jobs.submit(url, fid, force)
                            for fid in ids if isinstance(fid, str) and fid]
                    if not jobs:
                        return self._err('bad_input', 'formatIds 里没有有效档位')
                    return self._json({'ok': True, 'jobs': jobs, 'job': jobs[0]}, 202)
                job = cfg.jobs.submit(url, payload.get('formatId'), force)
                return self._json({'ok': True, 'job': job, 'jobs': [job]}, 202)

            if path == '/api/preview':
                # 返回带签名的直链给同源页面播放。只在本机、且已过 token 校验；
                # 直链有时效，所以每次预览都重新 probe，不缓存。
                url = (payload.get('url') or '').strip()
                if not url:
                    return self._err('bad_input', '缺少 url')
                res = router.probe(url)
                if not res.ok:
                    return self._json(res.to_dict())
                fmt = pick_format(res, payload.get('formatId'))
                if not fmt or not fmt.urls:
                    return self._err('no_stream', '这个档位没有可预览地址',
                                     '重新解析一次再试')
                return self._json({'ok': True, 'url': fmt.urls[0],
                                   'formatId': fmt.id, 'ext': fmt.ext})

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

def _lan_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith('127.'))


def make_server(host='127.0.0.1', port=8765, out_dir=None, token=None, log=None,
                persist=True, allowed_origins=None):
    """构造但不启动。测试用 port=0 拿随机端口、persist=False 隔离历史。"""
    out = pathlib.Path(out_dir or load_config().get('outDir') or '下载')
    out.mkdir(parents=True, exist_ok=True)
    hub = Hub()
    store = (data_dir() / 'jobs.json') if persist else None
    jobs = JobStore(out, hub, log=log or (lambda m: print(m, flush=True)),
                    store_path=store)
    origins = list(load_config().get('allowedOrigins') or []) + list(allowed_origins or [])
    cfg = Config(host, port, token or secrets.token_urlsafe(16), out, hub, jobs,
                 allowed_origins=origins)
    httpd = ThreadingHTTPServer((host, cfg.port), make_handler(cfg))
    cfg.port = httpd.server_address[1]
    return httpd, cfg


def serve(port=8765, out_dir=None, token=None, open_browser=True, host='127.0.0.1',
          lan=False, allowed_origins=None):
    if lan:
        host = '0.0.0.0'
    try:
        httpd, cfg = make_server(host=host, port=port, out_dir=out_dir, token=token,
                                 allowed_origins=allowed_origins)
    except OSError as e:
        print(f'端口 {port} 起不来：{e}')
        print('换一个端口：python -m vdl serve --port 8766')
        return 2

    local = f'http://127.0.0.1:{cfg.port}/?token={cfg.token}'
    print(f'vdl {__version__} 已启动')
    print(f'  本机: {local}')
    if lan:
        for ip in _lan_ips():
            print(f'  局域网: http://{ip}:{cfg.port}/?token={cfg.token}')
        print('  ! 局域网内拿到链接的任意设备都能访问，公共 WiFi 下别开')
    print(f'  输出: {cfg.out_dir.resolve()}')
    print('  Ctrl+C 停止')
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(local)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
    finally:
        httpd.server_close()
    return 0
