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
import os
import pathlib
import shutil
import sys
import time

import dy_http

from . import __version__
from .core import router
from .core.config import load as load_config
from .core.config import save as save_config
from .core.errors import ErrorCode, VdlError
from .core.models import DownloadResult, ProbeResult
from .core.paths import auth_dir, data_dir
from .engines.base import pick_format

DEFAULT_OUT = '下载'


def _resolve_out(value):
    """命令行显式给了就用；否则用配置；再否则用默认。"""
    return value or load_config().get('outDir') or DEFAULT_OUT


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

    audio = all((not f.vcodec) and f.acodec for f in result.formats)
    if audio:
        print(f'  {"档位":<12}{"格式":<8}{"码率":<12}{"体积":>11}  标记')
        for f in result.formats:
            size = f'{f.bytes / 1048576:.2f} MB' if f.bytes else '未知'
            kbps = f'{f.bitrate // 1000} kbps' if f.bitrate else '-'
            mark = '推荐' if f.recommended else ''
            print(f'  {f.id:<12}{f.ext.upper():<8}{kbps:<12}{size:>11}  {mark}')
    else:
        print(f'  {"档位":<22}{"清晰度":<10}{"编码":<7}{"帧率":<6}{"体积":>11}  标记')
        for f in result.formats:
            size = f'{f.bytes / 1048576:.2f} MB' if f.bytes else '未知'
            fps = str(f.fps) if f.fps else '-'
            mark = '推荐' if f.recommended else ('带水印' if f.watermark else '')
            print(f'  {f.id:<22}{f.label:<10}{f.vcodec:<7}{fps:<6}{size:>11}  {mark}')

    for w in result.warnings:
        print(f'  ! {w}')


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
        dl = engine.download(result, fmt.id, _resolve_out(args.out),
                             force=args.force, with_subs=args.subs)
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


def cmd_auth(args):
    from .auth import clear, login, status

    if args.status:
        rows = status()
        if args.json:
            _emit_json({'ok': True, 'sites': rows})
        else:
            print('站点登录状态')
            for r in rows:
                state = '已登录' if r['loggedIn'] else '未登录'
                ts = (time.strftime('%Y-%m-%d %H:%M', time.localtime(r['updatedAt']))
                      if r['updatedAt'] else '-')
                print(f'  {r["label"]:<8}{state:<6}cookie {r["cookies"]:>2}  {ts}')
            print(f'\n凭据目录: {auth_dir()}')
        return 0

    if not args.site:
        print('用法: vdl auth <bilibili|netease>   |   vdl auth --status')
        return 2
    if args.clear:
        return clear(args.site)
    return login(args.site, timeout=args.timeout)


def cmd_serve(args):
    try:
        from .server import serve
    except ImportError:
        # Skill 包里刻意不带 server.py 与前端资源
        print('这个安装包只含 CLI（Skill 版），没有 Web 界面')
        print('需要界面请用完整仓库：python -m vdl serve')
        return 2

    return serve(port=args.port, out_dir=_resolve_out(args.out), token=args.token,
                 open_browser=not args.no_open, lan=args.lan,
                 allowed_origins=args.allow_origin)


def cmd_config(args):
    if args.set:
        key, _, value = args.set.partition('=')
        if not key:
            print(r'用法: vdl config --set outDir=D:\下载')
            return 2
        save_config({key: value})
        print(f'{key} = {value}')

    data = load_config()
    if args.json:
        _emit_json({'ok': True, 'config': data})
    else:
        for key, value in data.items():
            print(f'{key:<10}{value or "(默认)"}')
    return 0


def _fix_deps():
    """只装 pip 依赖。ffmpeg 是二进制，交给用户/包管理器，不自动下载。"""
    import subprocess

    missing = [pkg for mod, pkg in (('yt_dlp', 'yt-dlp'), ('playwright', 'playwright'))
               if importlib.util.find_spec(mod) is None]
    if not missing:
        print('可选依赖已齐全，无需修复')
        return True
    print('安装: ' + ' '.join(missing))
    try:
        subprocess.run([sys.executable, '-m', 'pip', 'install', *missing], check=True)
    except Exception as e:                       # noqa: BLE001
        print(f'安装失败（{type(e).__name__}: {e}），请手动执行：'
              f'pip install {" ".join(missing)}')
        return False
    return True


def _live_check(log=None):
    """对三个真实样本各 probe 一次，判断是「引擎坏了」还是「网络问题」。"""
    targets = (
        ('douyin', 'https://www.douyin.com/video/6961737553342991651'),
        ('netease', 'https://music.163.com/song?id=28606052'),
        ('bilibili', 'BV1j5nj68E48'),
    )
    results = []
    for site, url in targets:
        started = time.monotonic()
        try:
            res = router.probe(url, log=log)
            results.append({'site': site, 'ok': bool(res.ok),
                            'ms': int((time.monotonic() - started) * 1000),
                            'error': (res.error or {}).get('code')})
        except Exception as e:                   # noqa: BLE001
            results.append({'site': site, 'ok': False,
                            'ms': int((time.monotonic() - started) * 1000),
                            'error': f'{type(e).__name__}: {e}'})
    return results


def _write_bundle(payload):
    """诊断包：只含状态与错误，不含 cookie / 完整路径。"""
    import zipfile

    stamp = time.strftime('%Y%m%d-%H%M%S')
    target = pathlib.Path.cwd() / f'vdl-diagnose-{stamp}.zip'
    jobs = []
    job_file = data_dir() / 'jobs.json'
    if job_file.exists():
        try:
            raw = json.loads(job_file.read_text(encoding='utf-8'))
            for job in (raw.get('jobs') or [])[-20:]:
                jobs.append({k: job.get(k) for k in
                             ('id', 'status', 'formatId', 'percent', 'error')})
        except Exception:                        # noqa: BLE001
            pass
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('doctor.json', json.dumps(payload, ensure_ascii=False, indent=2))
        zf.writestr('config.json', json.dumps(load_config(), ensure_ascii=False, indent=2))
        zf.writestr('jobs.json', json.dumps(jobs, ensure_ascii=False, indent=2))
    return target


def cmd_doctor(args):
    if getattr(args, 'fix', False):
        _fix_deps()
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

    auths = sorted(p.stem for p in auth_dir().glob('*.json'))
    add('auth', True, ', '.join(auths) if auths else '未登录任何站点', False,
        'B站/网易云高画质需要 `vdl auth <site>`')
    add('interpreter', True, sys.executable, False,
        'auth/浏览器兜底需要装在带 playwright 的解释器里')

    # doctor 是只读检查，不能顺手创建目录（R1 技术债 #7）
    out_dir = pathlib.Path(_resolve_out(args.out))
    try:
        if out_dir.exists():
            probe_file = out_dir / '.vdl-write-test'
            probe_file.write_text('ok', encoding='utf-8')
            probe_file.unlink()
            writable, out_value = True, str(out_dir.resolve())
        else:
            parent = next((p for p in out_dir.parents if p.exists()), None)
            writable = bool(parent and os.access(parent, os.W_OK))
            out_value = f'{out_dir}（不存在，首次下载时创建）'
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

    if getattr(args, 'live', False):
        payload['live'] = _live_check()
        if not all(item['ok'] for item in payload['live']):
            payload['warnings'].append('live')

    if getattr(args, 'bundle', False):
        payload['bundle'] = str(_write_bundle(payload))

    if args.json:
        _emit_json(payload)
    else:
        print(f'vdl {__version__} 环境检查')
        for c in checks:
            mark = 'OK  ' if c['ok'] else ('FAIL' if c['required'] else 'WARN')
            print(f'  [{mark}] {c["name"]:<12}{c["value"]}')
            if not c['ok'] and c['hint']:
                print(f'         → {c["hint"]}')
        for item in payload.get('live', []):
            mark = 'OK  ' if item['ok'] else 'FAIL'
            detail = item['error'] or ''
            print(f'  [{mark}] live:{item["site"]:<8}{item["ms"]}ms  {detail}')
        if payload.get('bundle'):
            print(f'  诊断包: {payload["bundle"]}')

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
    g.add_argument('-o', '--out', default=None,
                   help=f'输出目录（默认配置里的 outDir，再默认 {DEFAULT_OUT}）')
    g.add_argument('--force', action='store_true', help='已存在也重下')
    g.add_argument('--subs', action='store_true', help='同时下载字幕（B站，中文优先）')
    g.add_argument('--json', action='store_true', help='输出结构化 JSON（stdout）')
    g.set_defaults(func=cmd_get)

    a = sub.add_parser('auth', help='扫码登录并导出 cookie')
    a.add_argument('site', nargs='?', help='bilibili | netease')
    a.add_argument('--status', action='store_true', help='只看登录状态')
    a.add_argument('--clear', action='store_true', help='清除该站点凭据')
    a.add_argument('--timeout', type=int, default=300, help='等待扫码的秒数')
    a.add_argument('--json', action='store_true')
    a.set_defaults(func=cmd_auth)

    c = sub.add_parser('config', help='查看/修改配置')
    c.add_argument('--set', default='', help=r'key=value，例如 outDir=D:\下载')
    c.add_argument('--json', action='store_true')
    c.set_defaults(func=cmd_config)

    s = sub.add_parser('serve', help='启动本地 Web 界面')
    s.add_argument('--port', type=int, default=8765, help='默认 8765，被占用就换一个')
    s.add_argument('-o', '--out', default=None, help='输出目录')
    s.add_argument('--token', default=None, help='固定 token（默认随机生成）')
    s.add_argument('--no-open', action='store_true', help='不自动打开浏览器')
    s.add_argument('--lan', action='store_true', help='允许局域网访问（手机/其它设备）')
    s.add_argument('--allow-origin', action='append', default=[],
                   help='额外允许的 Origin（infOS 等宿主），可重复')
    s.add_argument('--concurrency', type=int, default=1, choices=(1, 2, 3, 4),
                   help='同时下载数，默认 1（对平台更友好）')
    s.set_defaults(func=cmd_serve)

    d = sub.add_parser('doctor', help='检查运行环境')
    d.add_argument('-o', '--out', default=None, help='顺带检查输出目录')
    d.add_argument('--fix', action='store_true', help='自动安装缺失的 pip 依赖')
    d.add_argument('--live', action='store_true', help='对三个站点各解析一次（联网）')
    d.add_argument('--bundle', action='store_true', help='生成脱敏诊断包 zip')
    d.add_argument('--json', action='store_true')
    d.set_defaults(func=cmd_doctor)
    return ap


def main(argv=None):
    dy_http.setup_console()
    args = build_parser().parse_args(argv)
    return args.func(args)
