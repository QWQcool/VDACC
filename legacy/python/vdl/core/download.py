# -*- coding: utf-8 -*-
"""通用流式下载：续传、重试、限速、可取消。

行为约定：
- 先写 `<name>.part`，成功后再由调用方原子改名；
- `.part` 已存在就从它的长度续传（服务端不支持 Range 时自动从头开始）；
- 只对「重试有意义」的错误重试（网络、超时、5xx），4xx 直接失败；
- `should_cancel()` 返回 True 时抛 `DownloadCancelled`，`.part` 保留以便续传。
"""

import pathlib
import socket
import time
import urllib.error
import urllib.request


class DownloadCancelled(Exception):
    """用户取消；与失败区分开，任务状态用 cancelled。"""


class _Retryable(Exception):
    pass


def _retryable(exc):
    if isinstance(exc, (urllib.error.URLError, socket.timeout, TimeoutError,
                        ConnectionError, _Retryable)):
        return True
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code >= 500 or exc.code in (408, 429)
    return False


def _stream_once(url, part, headers, progress, timeout, chunk, limit_bps,
                 should_cancel):
    resume = part.stat().st_size if part.exists() else 0
    req_headers = dict(headers or {})
    if resume:
        req_headers['Range'] = f'bytes={resume}-'

    req = urllib.request.Request(url, headers=req_headers)
    written = resume
    started = time.monotonic()

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        # 服务端不认 Range 会回 200 + 全量，此时必须从头写
        if resume and resp.status != 206:
            resume, written = 0, 0
        mode = 'ab' if resume else 'wb'

        total = 0
        content_range = resp.headers.get('Content-Range') or ''
        if '/' in content_range:
            raw_total = content_range.rsplit('/', 1)[-1].strip()
            total = int(raw_total) if raw_total.isdigit() else 0
        if not total:
            raw_len = resp.headers.get('Content-Length') or ''
            if raw_len.isdigit():
                total = int(raw_len) + resume

        last = 0.0
        with open(part, mode) as f:
            while True:
                if should_cancel and should_cancel():
                    raise DownloadCancelled()
                buf = resp.read(chunk)
                if not buf:
                    break
                f.write(buf)
                written += len(buf)

                if limit_bps and limit_bps > 0:
                    expected = (written - resume) / limit_bps
                    actual = time.monotonic() - started
                    if expected > actual:
                        time.sleep(min(expected - actual, 1.0))

                if progress and time.monotonic() - last >= 0.2:
                    last = time.monotonic()
                    try:
                        progress(written, total)
                    except Exception:
                        pass

    if progress:
        try:
            progress(written, total or written)
        except Exception:
            pass
    return written, total


def stream_to_file(url, part, headers=None, progress=None, timeout=120,
                   chunk=256 * 1024, retries=2, limit_bps=0, should_cancel=None):
    """下载到 part，返回 (written, total)。total 未知时为 0。"""
    part = pathlib.Path(part)
    attempt = 0
    while True:
        try:
            return _stream_once(url, part, headers, progress, timeout, chunk,
                                limit_bps, should_cancel)
        except DownloadCancelled:
            raise
        except Exception as exc:                 # noqa: BLE001 - 分类后决定是否重试
            if attempt >= retries or not _retryable(exc):
                raise
            attempt += 1
            time.sleep(min(2 ** attempt, 8))
