#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""校验 Skill 产物：读 SHA256SUMS，逐个比对文件。

    python tools/verify_skill_ts.py dist/video-acquire-ts
"""

import hashlib
import pathlib
import sys

# 与构建脚本一致：Windows 控制台可能是 cp1252/cp936，中文日志直接崩或乱码
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv):
    root = pathlib.Path(argv[1] if len(argv) > 1 else 'dist/video-acquire-ts').resolve()
    sums = root / 'SHA256SUMS'
    if not sums.is_file():
        print(f'缺少 {sums}，先运行 python tools/build_skill_ts.py --zip')
        return 2

    bad = 0
    checked = 0
    for line in sums.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        expected, _, rel = line.partition('  ')
        target = root / rel
        if not target.is_file():
            print(f'FAIL  {rel}  文件缺失')
            bad += 1
            continue
        actual = sha256_of(target)
        checked += 1
        if actual == expected:
            print(f'OK    {rel}')
        else:
            print(f'FAIL  {rel}  {actual[:12]}… != {expected[:12]}…')
            bad += 1

    print(f'\n{checked} 个文件校验，失败 {bad} 个')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
