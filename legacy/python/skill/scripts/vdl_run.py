#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Skill 入口：把 scripts/ 放进 sys.path，然后转给 vdl.cli。

这样 `vdl` 包里的 `import dy_http` 才能找到同级的 dy_http.py。
"""

import pathlib
import sys

BASE = pathlib.Path(__file__).resolve().parent
# 源码树里 vdl/ 在 legacy/python/vdl；构建产物里与 scripts/ 同级
for candidate in (BASE, BASE.parents[1] if len(BASE.parents) > 1 else BASE):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from vdl.cli import main  # noqa: E402  (必须先调整 sys.path)

if __name__ == '__main__':
    sys.exit(main())
