# -*- coding: utf-8 -*-
"""用户配置：`%LOCALAPPDATA%\\vdl\\config.json`，不进仓库。

只放**偏好**，不放凭据。凭据一律在 `auth/` 下（见 paths.py）。
"""

import json
import os

from .paths import data_dir

DEFAULTS = {
    'outDir': '',          # 空 = 用 CLI 默认（./下载）
    'theme': 'light',      # UI 的初始主题；用户在前端切换会写 localStorage 覆盖
}


def config_path():
    return data_dir() / 'config.json'


def load():
    data = dict(DEFAULTS)
    path = config_path()
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding='utf-8'))
            if isinstance(loaded, dict):
                data.update(loaded)
        except Exception:                    # noqa: BLE001 - 坏配置就当默认值
            pass
    return data


def save(patch):
    data = load()
    data.update(patch or {})
    path = config_path()
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(tmp, path)
    return data
