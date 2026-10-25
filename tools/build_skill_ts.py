#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""组装 TS 版 Skill：Bun 编译出单文件 vdl.exe + SKILL.md。

    python tools/build_skill_ts.py --zip

需要 Bun：优先环境变量 BUN，其次 PATH、WinGet shim，最后临时下载副本。
产物在 dist/video-acquire-ts/，不入库。
"""

import argparse
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
    env = os.environ.get('BUN')
    if env and pathlib.Path(env).exists():
        return env
    found = shutil.which('bun')
    if found:
        return found
    local = os.environ.get('LOCALAPPDATA')
    if local:
        winget = pathlib.Path(local) / 'Microsoft' / 'WinGet' / 'Links' / 'bun.exe'
        if winget.exists():
            return str(winget)
    fallback = pathlib.Path(os.environ.get('TEMP', '')) / 'vdacc-ts' / 'bun' / 'bun-windows-x64' / 'bun.exe'
    if fallback.exists():
        return str(fallback)
    raise SystemExit('找不到 Bun：设置 BUN 环境变量或把 bun 加进 PATH')


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
