#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""界面级验收（手动运行，需要 playwright + msedge）。

    python tools/accept_ui.py http://127.0.0.1:8765 "https://..." \
        --deselect bili-3840 --select bili-854 --shot out.png

做三件事：深链打开 → 勾选指定档位 → 等**最新任务**完成 → 截图。
注意：必须看最新任务（列表是 prepend 的），否则会被上一条已完成的任务骗过。
"""

import argparse
import sys
from urllib.parse import quote

from playwright.sync_api import sync_playwright

DONE = ("['完成','失败'].includes(document.querySelector('.job .state').textContent)")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('base', help='例如 http://127.0.0.1:8765')
    ap.add_argument('url')
    ap.add_argument('--token', default='')
    ap.add_argument('--deselect', default='', help='逗号分隔的档位 id，先取消')
    ap.add_argument('--select', default='', help='逗号分隔的档位 id，再勾上')
    ap.add_argument('--shot', default='')
    ap.add_argument('--timeout', type=int, default=180)
    args = ap.parse_args(argv)

    q = f'{args.base}/?url={quote(args.url, safe="")}'
    if args.token:
        q += f'&token={quote(args.token)}'

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='msedge', headless=True)
        page = browser.new_page(viewport={'width': 1200, 'height': 1100},
                                locale='zh-CN')
        page.goto(q, wait_until='domcontentloaded')
        page.wait_for_selector('.material', timeout=45000)

        for fid in filter(None, args.deselect.split(',')):
            page.click(f'.chip[data-id="{fid}"]')
        for fid in filter(None, args.select.split(',')):
            page.click(f'.chip[data-id="{fid}"]')

        print('button:', page.inner_text('#download'))
        page.click('#download')
        page.wait_for_function(DONE, timeout=args.timeout * 1000)
        page.wait_for_timeout(500)

        print('state:', page.eval_on_selector('.job .state', 'n => n.textContent'))
        print('info:', page.eval_on_selector('.job .info', 'n => n.textContent'))
        if args.shot:
            page.screenshot(path=args.shot, full_page=True)
        browser.close()

    return 0


if __name__ == '__main__':
    sys.exit(main())
