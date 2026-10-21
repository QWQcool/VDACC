# -*- coding: utf-8 -*-
"""命令行入口 —— agent 和人类共用。

约定：
- `--json` 时 **stdout 只有 JSON**，进度/日志一律走 stderr；
- 任何情况下都不进入交互式 input()（agent 会被挂死，见 Plan.md 的 P0 教训）；
- 失败也返回 0/1 与结构化 error，不靠人读日志。
"""

import argparse
import importlib.util
import json
import pathlib
import shutil
import sys

import dy_http

from . import __version__
from .core import router
from .core.errors import ErrorCode, VdlError
from .core.models import DownloadResult, ProbeResult
from .engines.base import pick_format

DEFAULT_OUT = '下载'


# ---------------------------------------------------------------- 输出

def _emit_json(obj):
    """强制 UTF-8：Windows 管道默认 gbk，标题里的 emoji 会直接炸。"""
    raw = (json.dumps(obj, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def _log_to(stream):
    def _log(msg=''):
        print(msg, file=stream, flush=True)
    return _log


def _human_error(err):
    err = err or {}
    print(f"失败 [{err.get('code', 'unknown')}] {err.get('message', '')}")
    if err.get('next_action'):
        print(f"  下一步: {err['next_action']}")


def _human_probe(result):
    if not result.ok:
        return _human_error(result.error)
    m = result.media
    dur = f'{m.duration_ms / 1000:.1f}s' if m.duration_ms else '未知时长'
    print(m.title)
    print(f'  {m.author or "未知作者"} · {dur} · {result.platform} / {result.engine}')
    print(f'  {"档位":<22}{"清晰度":<10}{"编码":<7}{"帧率":<6}{"体积":>11}  标记')
    for f in result.formats:
        size = f'{f.bytes / 1048576:.2f} MB' if f.bytes else '未知'
        fps = str(f.fps) if f.fps else '-'
        mark = '推荐' if f.recommended else ('带水印' if f.watermark else '')
        print(f'  {f.id:<22}{f.label:<10}{f.vcodec:<7}{fps:<6}{size:>11}  {mark}')


# ---------------------------------------------------------------- 子命令

def cmd_probe(args):
    result = router.probe(args.url, log=_log_to(sys.stderr))
    if args.json:
        _emit_json(result.to_dict())
    else:
        _human_probe(result)
    return 0 if result.ok else 1


def cmd_get(args):
    log = _log_to(sys.stderr) if args.json else _log_to(sys.stdout)
    try:
        engine = router.route(args.url, log=log)
        result = engine.probe(args.url)
    except VdlError as e:
        if args.json:
            _emit_json(ProbeResult(ok=False, error=e.to_dict()).to_dict())
        else:
            _human_error(e.to_dict())
        return 1

    fmt = pick_format(result, args.format)
    if fmt is None:
        err = VdlError(
            ErrorCode.BAD_INPUT,
            f'没有匹配的档位: {args.format or "(默认)"}',
            '先跑 `vdl probe <url>` 看 formats[].id').to_dict()
        if args.json:
            _emit_json(ProbeResult(ok=False, platform=result.platform,
                                   engine=result.engine, media=result.media,
                                   formats=result.formats, error=err).to_dict())
        else:
            _human_error(err)
        return 1

    try:
        dl = engine.download(result, fmt.id, args.out, force=args.force)
    except VdlError as e:
        if args.json:
            _emit_json(DownloadResult(ok=False, format_id=fmt.id, error=e.to_dict()).to_dict())
        else:
            _human_error(e.to_dict())
        return 1

    if args.json:
        _emit_json(dl.to_dict())
    else:
        tag = '已存在，跳过' if dl.skipped else f'{dl.bytes / 1048576:.2f} MB'
        print(f'完成 {dl.path}  ({tag}, {dl.format_id})')
    return 0


def cmd_doctor(args):
    checks = []

    def add(name, ok, value='', required=False, hint=''):
        checks.append({'name': name, 'ok': bool(ok), 'value': value,
                       'required': required, 'hint': hint})

    py = '{}.{}.{}'.format(*sys.version_info[:3])
    add('python', sys.version_info >= (3, 9), py, True, '需要 3.9+')

    root = pathlib.Path(__file__).resolve().parent.parent
    local_ffmpeg = root / 'venv' / 'Scripts' / 'ffmpeg.exe'
    ffmpeg = str(local_ffmpeg) if local_ffmpeg.exists() else (shutil.which('ffmpeg') or '')
    add('ffmpeg', bool(ffmpeg), ffmpeg or '未找到', False,
        'B站/合并音轨需要：放进 venv\\Scripts 或加进 PATH')
    local_ffprobe = root / 'venv' / 'Scripts' / 'ffprobe.exe'
    ffprobe = str(local_ffprobe) if local_ffprobe.exists() else (shutil.which('ffprobe') or '')
    add('ffprobe', bool(ffprobe), ffprobe or '未找到', False, '与 ffmpeg 同目录')

    add('playwright', importlib.util.find_spec('playwright') is not None,
        '已安装' if importlib.util.find_spec('playwright') else '未安装', False,
        '只有 vdl auth / 浏览器兜底需要')
    add('yt_dlp', importlib.util.find_spec('yt_dlp') is not None,
        '已安装' if importlib.util.find_spec('yt_dlp') else '未安装', False,
        'B站引擎（P5）需要')

    auth_dir = pathlib.Path.home() / 'AppData' / 'Local' / 'vdl' / 'auth'
    if not auth_dir.exists():
        auth_dir = pathlib.Path.home() / '.config' / 'vdl' / 'auth'
    auths = sorted(p.stem for p in auth_dir.glob('*.json')) if auth_dir.exists() else []
    add('auth', True, ', '.join(auths) if auths else '未登录任何站点', False,
        'B站/网易云高画质需要 `vdl auth <site>`')

    out_dir = pathlib.Path(args.out)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        probe_file = out_dir / '.vdl-write-test'
        probe_file.write_text('ok', encoding='utf-8')
        probe_file.unlink()
        writable, out_value = True, str(out_dir.resolve())
    except Exception as e:                       # noqa: BLE001 - 要如实汇报任何失败
        writable, out_value = False, f'{out_dir} ({type(e).__name__}: {e})'
    add('out_dir', writable, out_value, True, '输出目录必须可写')

    failed_required = [c for c in checks if c['required'] and not c['ok']]
    payload = {
        'schema': 1,
        'ok': not failed_required,
        'version': __version__,
        'checks': checks,
        'warnings': [c['name'] for c in checks if not c['required'] and not c['ok']],
    }
    if args.json:
        _emit_json(payload)
    else:
        print(f'vdl {__version__} 环境检查')
        for c in checks:
            mark = 'OK  ' if c['ok'] else ('FAIL' if c['required'] else 'WARN')
            print(f'  [{mark}] {c["name"]:<12}{c["value"]}')
            if not c['ok'] and c['hint']:
                print(f'         → {c["hint"]}')
    return 0 if payload['ok'] else 1


# ---------------------------------------------------------------- 入口

def build_parser():
    ap = argparse.ArgumentParser(prog='vdl', description='VDACC 媒体下载 core')
    ap.add_argument('--version', action='version', version=f'vdl {__version__}')
    sub = ap.add_subparsers(dest='command', required=True)

    p = sub.add_parser('probe', help='只解析不下载，输出档位')
    p.add_argument('url')
    p.add_argument('--json', action='store_true', help='输出结构化 JSON（stdout）')
    p.set_defaults(func=cmd_probe)

    g = sub.add_parser('get', help='解析并下载')
    g.add_argument('url')
    g.add_argument('--format', default=None, help='档位 id；默认选推荐档')
    g.add_argument('-o', '--out', default=DEFAULT_OUT, help=f'输出目录（默认 {DEFAULT_OUT}）')
    g.add_argument('--force', action='store_true', help='已存在也重下')
    g.add_argument('--json', action='store_true', help='输出结构化 JSON（stdout）')
    g.set_defaults(func=cmd_get)

    d = sub.add_parser('doctor', help='检查运行环境')
    d.add_argument('-o', '--out', default=DEFAULT_OUT, help='顺带检查输出目录')
    d.add_argument('--json', action='store_true')
    d.set_defaults(func=cmd_doctor)
    return ap


def main(argv=None):
    dy_http.setup_console()
    args = build_parser().parse_args(argv)
    return args.func(args)
