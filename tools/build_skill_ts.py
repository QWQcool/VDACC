#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""组装 TS 版 Skill：Bun 编译出单文件 vdl.exe + SKILL.md。

    python tools/build_skill_ts.py --zip

需要 Bun：优先环境变量 BUN，其次 PATH、WinGet shim，最后临时下载副本。
产物在 dist/video-acquire-ts/，不入库。
"""

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import zipfile

# Windows runner 的重定向标准输出可能是 cp1252，中文日志会在编译前直接崩溃。
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist' / 'video-acquire-ts'
SKILL = ROOT / 'ts' / 'skill'
ENTRY = ROOT / 'ts' / 'src' / 'skill_cli.ts'


def find_bun():
    """必须是真正的可执行文件。

    npm 的 `bun` 命令在 Windows 上是个无扩展名的 shell 脚本（还有一个 bun.cmd 包装），
    `shutil.which('bun')` 会先命中它，CreateProcess 直接报 WinError 193
    「不是有效的 Win32 应用程序」。所以按 .exe 优先级找，并显式跳过脚本。
    """
    env = os.environ.get('BUN')
    if env and pathlib.Path(env).exists() and pathlib.Path(env).suffix.lower() in ('.exe', ''):
        if pathlib.Path(env).suffix.lower() == '.exe':
            return env

    candidates = []
    if os.name == 'nt':
        found = shutil.which('bun.exe')
        if found:
            candidates.append(found)
        local = os.environ.get('LOCALAPPDATA')
        if local:
            candidates.append(str(pathlib.Path(local) / 'Microsoft' / 'WinGet' / 'Links' / 'bun.exe'))
        appdata = os.environ.get('APPDATA')
        if appdata:
            candidates.append(str(pathlib.Path(appdata) / 'npm' / 'node_modules' / '@oven' /
                                   'bun-windows-x64' / 'bin' / 'bun.exe'))
        candidates.append(str(pathlib.Path(os.environ.get('TEMP', '')) / 'vdacc-ts' / 'bun' /
                              'bun-windows-x64' / 'bun.exe'))
    else:
        found = shutil.which('bun')
        if found:
            return found

    for candidate in candidates:
        path = pathlib.Path(candidate)
        if path.is_file() and path.suffix.lower() == '.exe':
            return str(path)
    raise SystemExit('找不到可执行的 bun.exe：设置 BUN 环境变量，或安装 Bun 后重开终端')


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest():
    """产物清单 + 校验和：解压后先核对 SHA256，再谈「能不能跑」。"""
    version = 'unknown'
    try:
        version = json.loads((ROOT / 'ts' / 'package.json').read_text(encoding='utf-8'))['version']
    except Exception:
        pass

    files = []
    for file in sorted(DIST.rglob('*')):
        if not file.is_file():
            continue
        rel = file.relative_to(DIST).as_posix()
        files.append({
            'path': rel,
            'bytes': file.stat().st_size,
            'sha256': sha256_of(file),
        })

    manifest = {
        'name': 'video-acquire-ts',
        'version': version,
        'built_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'files': files,
        'total_bytes': sum(item['bytes'] for item in files),
    }
    (DIST / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    with open(DIST / 'SHA256SUMS', 'w', encoding='utf-8', newline='\n') as fh:
        for item in files:
            fh.write(f"{item['sha256']}  {item['path']}\n")
    print(f'清单: {len(files)} 个文件，合计 {manifest["total_bytes"]/1024/1024:.1f} MB')
    return manifest


def build():
    # 清理范围只能是仓库内的构建目录，不能跟随被替换的目录链接。
    if DIST.resolve() != ROOT.resolve() / 'dist' / 'video-acquire-ts':
        raise SystemExit('构建目录不在预期位置，停止清理')
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    exe = DIST / 'vdl.exe'
    bun = find_bun()
    cmd = [bun, 'build', '--compile', '--minify', '--outfile', str(exe), str(ENTRY)]
    print('编译:', ' '.join(cmd))
    subprocess.run(cmd, check=True, cwd=str(ROOT))

    shutil.copy2(SKILL / 'SKILL.md', DIST / 'SKILL.md')
    shutil.copytree(SKILL / 'references', DIST / 'references')

    size = exe.stat().st_size
    print(f'产物: {DIST}')
    print(f'  vdl.exe {size/1024/1024:.1f} MB')
    write_manifest()
    return DIST


def zip_up(path):
    target = path.with_suffix('.zip')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file in path.rglob('*'):
            if file.is_file():
                zf.write(file, path.name + '/' + file.relative_to(path).as_posix())
    print(f'压缩: {target} ({target.stat().st_size/1024/1024:.1f} MB)')
    return target


def main(argv=None):
    ap = argparse.ArgumentParser(description='构建 TS 版 Skill')
    ap.add_argument('--zip', action='store_true')
    args = ap.parse_args(argv)
    out = build()
    if args.zip:
        zip_up(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
