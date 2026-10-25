#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""界面级验收（手动运行，需要 playwright + msedge）。

    python tools/accept_ui.py http://127.0.0.1:8765 "https://..." \
        --deselect bili-3840 --select bili-854 --shot out.png

深链打开 → 选择档位 → 跟踪这次 API 返回的所有任务 ID → 截图。
不依赖语言或列表顺序；任何一个本次任务失败都返回非零退出码。
"""

import argparse
import json
import sys
from urllib.parse import quote

from playwright.sync_api import sync_playwright

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
        page.wait_for_selector('#result [data-format-id]', timeout=45000)

        for fid in filter(None, args.deselect.split(',')):
            chip = page.locator(f'[data-format-id={json.dumps(fid)}]')
            if chip.get_attribute('aria-pressed') == 'true':
                chip.click()
        for fid in filter(None, args.select.split(',')):
            chip = page.locator(f'[data-format-id={json.dumps(fid)}]')
            if chip.get_attribute('aria-pressed') != 'true':
                chip.click()

        submitted, errors = [], []

        def collect(response):
            if response.request.method != 'POST' or response.url.split('?')[0] != args.base.rstrip('/') + '/api/jobs':
                return
            data = response.json()
            if not data.get('ok'):
                errors.append(data.get('error', {}).get('code', 'submit_failed'))
                return
            submitted.extend(job['id'] for job in data.get('jobs', [data.get('job')]) if job)

        page.on('response', collect)
        button = page.get_by_test_id('download')
        button.click()
        # Vue 提交时禁用按钮；批量提交全部返回后再确定需要跟踪的 ID 集合。
        page.wait_for_function("!document.querySelector('[data-testid=download]').disabled",
                               timeout=args.timeout * 1000)
        if errors or not submitted:
            print('submission failed:', errors or ['no_job'])
            browser.close()
            return 1
        page.wait_for_function("""ids => ids.every(id => {
            const row = document.querySelector(`[data-job-id="${id}"]`);
            return row && ['done', 'failed', 'cancelled'].includes(row.dataset.status);
        })""", arg=submitted, timeout=args.timeout * 1000)
        states = [page.locator(f'[data-job-id="{job_id}"]').get_attribute('data-status')
                  for job_id in submitted]
        print('submitted jobs:', len(submitted), 'states:', ', '.join(states))
        if args.shot:
            page.screenshot(path=args.shot, full_page=True)
        browser.close()

    return 0 if all(state == 'done' for state in states) else 1


if __name__ == '__main__':
    sys.exit(main())
