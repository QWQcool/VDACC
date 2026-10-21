# -*- coding: utf-8 -*-
"""VDACC core 层。

这个包只做一件事：把「链接 → 可下载档位 → 落地文件」翻译成**稳定的结构化契约**。
CLI、Web GUI、Skill 都是它的壳，不允许在壳里写业务逻辑。
"""

__version__ = '1.0.0'

# 契约版本。字段增删要改这里，壳按它决定怎么解析。
SCHEMA_VERSION = 1
