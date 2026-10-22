#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把仓库里的核心代码组装成可独立安装的 Agent Skill。

    python tools/build_skill.py          # 只组装到 dist/video-acquire/
    python tools/build_skill.py --zip    # 顺便打 dist/video-acquire.zip

Skill 里**不带** Web 界面（vdl/web、vdl/server.py）：
- Agent 不需要它；
- 其中包含角色插画，分发范围受授权约束。

仓库仍是唯一事实来源：改代码只改仓库，重新 build 即可。
"""

import argparse
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SKILL_SRC = ROOT / 'skill'
DIST_ROOT = ROOT / 'dist'
DIST = DIST_ROOT / 'video-acquire'

IGNORE = shutil.ignore_patterns(
    '__pycache__', '*.pyc', 'web', 'server.py', '.mypy_cache', '.pytest_cache')


def validate():
    text = (SKILL_SRC / 'SKILL.md').read_text(encoding='utf-8')
    if not text.startswith('---'):
        raise SystemExit('SKILL.md 必须以 YAML frontmatter 开头')
    head = text.split('---')[1]
    for key in ('name:', 'description:'):
        if key not in head:
            raise SystemExit(f'SKILL.md frontmatter 缺少 {key}')
    if 'name: video-acquire' not in head:
        raise SystemExit('name 必须是 video-acquire（与目录名一致）')


def build():
    validate()
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    shutil.copy2(SKILL_SRC / 'SKILL.md', DIST / 'SKILL.md')
    shutil.copytree(SKILL_SRC / 'references', DIST / 'references')

    scripts = DIST / 'scripts'
    scripts.mkdir()
    shutil.copytree(ROOT / 'vdl', scripts / 'vdl', ignore=IGNORE)
    shutil.copy2(ROOT / 'dy_http.py', scripts / 'dy_http.py')
    for name in ('vdl_run.py', 'requirements.txt'):
        shutil.copy2(SKILL_SRC / 'scripts' / name, scripts / name)

    # 打包进去的必须是能跑的代码，别把空壳发出去
    for needed in (scripts / 'vdl' / 'cli.py', scripts / 'dy_http.py'):
        if not needed.exists():
            raise SystemExit(f'构建缺少文件: {needed}')

    total = sum(p.stat().st_size for p in DIST.rglob('*') if p.is_file())
    print(f'构建完成: {DIST}')
    print(f'  文件数: {sum(1 for p in DIST.rglob("*") if p.is_file())}  体积: {total/1024:.1f} KB')
    return DIST


def zip_up(path):
    target = path.with_suffix('.zip')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file in path.rglob('*'):
            if file.is_file():
                zf.write(file, path.name + '/' + str(file.relative_to(path)))
    print(f'打包完成: {target}  ({target.stat().st_size/1024:.1f} KB)')
    return target


def main(argv=None):
    ap = argparse.ArgumentParser(description='构建 video-acquire Skill')
    ap.add_argument('--zip', action='store_true', help='同时生成 zip')
    args = ap.parse_args(argv)
    out = build()
    if args.zip:
        zip_up(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
