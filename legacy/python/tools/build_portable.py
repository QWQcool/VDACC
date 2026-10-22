#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""组装「绿色包」：解压 + 双击 VDACC.bat 即用（仍需系统有 Python 3.9+）。

    python tools/build_portable.py --zip
    # dist/VDACC-portable/ 与 dist/VDACC-portable.zip

不打包 Python 本体：onefile 版本容易被杀软误报，且体积翻十倍。
"""

import argparse
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist' / 'VDACC-portable'

IGNORE = shutil.ignore_patterns('__pycache__', '*.pyc', '.mypy_cache', '.pytest_cache')

README = """VDACC 便携版
=============

要求：Windows 10/11 + Python 3.9 以上（安装时勾选 Add to PATH）。

第一次：
  双击 VDACC.bat
  → 自动创建 venv、安装 yt-dlp / playwright
  → 启动后打印带 token 的地址，浏览器会自动打开

之后：
  双击 VDACC.bat 即可。

常用：
  venv\\Scripts\\python.exe -m vdl doctor --live     # 三站点体检
  venv\\Scripts\\python.exe -m vdl config --set outDir=D:\\下载
  venv\\Scripts\\python.exe -m vdl auth bilibili      # 扫码登录（1080P+）

没有 Python？
  装一个：https://www.python.org/downloads/windows/
  或改用完整仓库里的源码方式运行。
"""


def build():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    shutil.copytree(ROOT / 'vdl', DIST / 'vdl', ignore=IGNORE)
    for name in ('dy_http.py', 'VDACC.bat', 'requirements.txt', 'README.md',
                 'LICENSE', 'NOTICE', 'THIRD_PARTY.md'):
        shutil.copy2(ROOT / name, DIST / name)
    (DIST / 'README-便携版.txt').write_text(README, encoding='utf-8')

    total = sum(p.stat().st_size for p in DIST.rglob('*') if p.is_file())
    print(f'便携包: {DIST}')
    print(f'  {sum(1 for p in DIST.rglob("*") if p.is_file())} 个文件, {total/1024:.1f} KB')
    return DIST


def zip_up(path):
    target = path.with_suffix('.zip')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file in path.rglob('*'):
            if file.is_file():
                zf.write(file, path.name + '/' + str(file.relative_to(path)))
    print(f'压缩: {target}  ({target.stat().st_size/1024:.1f} KB)')
    return target


def main(argv=None):
    ap = argparse.ArgumentParser(description='构建 VDACC 便携包')
    ap.add_argument('--zip', action='store_true')
    args = ap.parse_args(argv)
    out = build()
    if args.zip:
        zip_up(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
