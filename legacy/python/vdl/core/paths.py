# -*- coding: utf-8 -*-
"""运行时目录。

凭据和浏览器 profile 一律放用户数据目录，**绝不放进仓库**：
profile 里有活的登录态，一次误提交就等于泄露账号。
"""

import os
import pathlib
import sys

APP = 'vdl'


def data_dir():
    if os.name == 'nt':
        base = os.environ.get('LOCALAPPDATA') or (pathlib.Path.home() / 'AppData' / 'Local')
    elif sys.platform == 'darwin':
        base = pathlib.Path.home() / 'Library' / 'Application Support'
    else:
        base = os.environ.get('XDG_DATA_HOME') or (pathlib.Path.home() / '.local' / 'share')
    path = pathlib.Path(base) / APP
    path.mkdir(parents=True, exist_ok=True)
    return path


def auth_dir():
    path = data_dir() / 'auth'
    path.mkdir(parents=True, exist_ok=True)
    return path


def profile_dir():
    """扫码登录用的持久 profile（和用户自己的浏览器完全隔离）。"""
    path = data_dir() / 'profile'
    path.mkdir(parents=True, exist_ok=True)
    return path


def auth_file(site):
    return auth_dir() / f'{site}.json'


def cookies_file(site):
    return auth_dir() / f'{site}.cookies.txt'
