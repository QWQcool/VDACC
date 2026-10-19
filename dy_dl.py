#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抖音视频下载器 —— 借浏览器签名拿直链

原理
----
抖音的视频详情接口（aweme/detail）要求每个请求带 a_bogus 签名，这个签名
只有浏览器里的 JS 算得出来（yt-dlp 的提取器就是因为缺这一步而失效）。
所以本工具不自己发请求，而是：

    让 Playwright 起一个独立的 Edge
      -> 打开视频页，浏览器自己算签名、自己请求
      -> 我们在旁边截下 detail 的 JSON 和视频 CDN 地址
      -> 按码率择优，用浏览器上下文下载

依赖：playwright + 系统已安装的 Edge（复用，不额外下载 chromium）
不会碰你正在用的 Edge：使用独立的 profile 目录。
"""

import argparse
import json
import pathlib
import re
import sys
import time

BASE = pathlib.Path(__file__).resolve().parent
OUT = BASE / '下载'
PROFILE = BASE / 'browser_profile'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')

URL_RE = re.compile(r'https?://[^\s，,。；;、"\')】\]]+')
ID_RE = re.compile(r'(?<!\d)(\d{15,20})(?!\d)')


# ---------------------------------------------------------------- 输入解析

def extract_targets(text):
    """从整段分享口令里抠出链接和/或视频 ID。"""
    urls = [u.rstrip('.,;:!?，。；：！？') for u in URL_RE.findall(text)]
    dy = [u for u in urls if 'douyin.com' in u or 'iesdouyin.com' in u]
    if dy:
        out = []
        for u in dy:
            if u not in out:
                out.append(u)
        return out
    ids = []
    for i in ID_RE.findall(text):
        if i not in ids:
            ids.append(i)
    return ids


def to_url(item):
    return item if item.startswith('http') else f'https://www.douyin.com/video/{item}'


def id_from(url):
    m = re.search(r'/video/(\d+)', url)
    return m.group(1) if m else ''


def safe_name(s, limit=55):
    s = re.sub(r'[\\/:*?"<>|\r\n\t#]', '_', s or '')
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:limit] or 'douyin'


# ---------------------------------------------------------------- 抓取逻辑

def collect_candidates(aweme):
    """按码率从高到低返回 (码率, url, 标签)。"""
    out = []
    if not aweme:
        return out
    video = aweme.get('video') or {}
    for br in (video.get('bit_rate') or []):
        rate = br.get('bit_rate') or 0
        pa = br.get('play_addr') or {}
        for u in (pa.get('url_list') or []):
            if u.startswith('http'):
                out.append((rate, u, br.get('gear_name') or f'{rate}bps'))
    for key in ('play_addr_h264', 'play_addr', 'play_addr_265', 'download_addr'):
        node = video.get(key) or {}
        for u in (node.get('url_list') or []):
            if u.startswith('http'):
                out.append((0, u, key))
    seen, uniq = set(), []
    for item in out:
        if item[1] not in seen:
            seen.add(item[1])
            uniq.append(item)
    uniq.sort(key=lambda x: -x[0])
    return uniq


def pick_aweme(details, vid):
    for d in details:
        aweme = d.get('aweme_detail') or d
        if str(aweme.get('aweme_id')) == str(vid):
            return aweme
    for d in details:
        aweme = d.get('aweme_detail')
        if isinstance(aweme, dict) and aweme.get('video'):
            return aweme
    return None


class Grabber:
    """一个持久的浏览器上下文，可以连续处理多个链接。"""

    def __init__(self, log=print, headless=True):
        self.log = log
        self.headless = headless
        self._pw = None
        self.ctx = None
        self.page = None
        self.details = []
        self.media = []

    def __enter__(self):
        from playwright.sync_api import sync_playwright
        PROFILE.mkdir(parents=True, exist_ok=True)
        self._pw = sync_playwright().start()
        self.ctx = self._pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE),
            channel='msedge',
            headless=self.headless,
            user_agent=UA,
            viewport={'width': 1366, 'height': 860},
            locale='zh-CN',
            timezone_id='Asia/Shanghai',
            args=['--disable-blink-features=AutomationControlled',
                  '--no-first-run', '--no-default-browser-check',
                  '--autoplay-policy=no-user-gesture-required'],
        )
        self.page = self.ctx.new_page()
        self.page.on('response', self._on_response)
        return self

    def __exit__(self, *exc):
        try:
            if self.ctx:
                self.ctx.close()
        except Exception:
            pass
        try:
            if self._pw:
                self._pw.stop()
        except Exception:
            pass

    def _on_response(self, resp):
        try:
            u = resp.url
            if '/aweme/detail' in u or '/aweme/v1/web/aweme' in u:
                try:
                    j = resp.json()
                    if j:
                        self.details.append(j)
                except Exception:
                    pass
            ct = (resp.headers or {}).get('content-type', '')
            if ct.startswith('video/') and u not in self.media:
                self.media.append(u)
        except Exception:
            pass

    def _wait_aweme(self, vid, seconds):
        deadline = time.time() + seconds
        aweme = None
        while time.time() < deadline:
            aweme = pick_aweme(self.details, vid)
            if aweme:
                return aweme
            time.sleep(0.8)
        return None

    def fetch(self, url, waitu=6.0):
        """打开页面，返回 (vid, title, candidates, media)。"""
        self.details.clear()
        self.media.clear()
        self.page.goto(url, wait_until='domcontentloaded', timeout=45000)
        time.sleep(2.5)
        vid = id_from(self.page.url)
        try:
            self.page.evaluate(
                "() => { const v=document.querySelector('video');"
                " if(v){v.muted=true; v.play().catch(()=>{});} }")
        except Exception:
            pass
        aweme = self._wait_aweme(vid, waitu)
        if not aweme:
            self.log('    (未截到 detail，强制重载一次)')
            try:
                self.page.reload(wait_until='domcontentloaded', timeout=45000)
            except Exception:
                pass
            time.sleep(2.0)
            aweme = self._wait_aweme(vid, waitu)
        self.log(f'    detail 响应 {len(self.details)} 条，命中: {"是" if aweme else "否"}，'
                 f'媒体流 {len(self.media)} 条')
        title = self.page.title() or vid
        cands = collect_candidates(aweme)
        return vid, title, cands, list(self.media)

    def save(self, cands, media, dest_base, max_try=6):
        """逐个试下，返回 (label, bytes) 或 None。"""
        pool = [(r, u, l) for (r, u, l) in cands[:max_try]]
        if not pool:
            pool = [(0, u, 'intercepted') for u in media[:3]]
        best = None
        for i, (rate, u, label) in enumerate(pool, 1):
            try:
                resp = self.ctx.request.get(u, headers={
                    'Referer': 'https://www.douyin.com/',
                    'User-Agent': UA,
                    'Accept': '*/*',
                }, timeout=120000)
                if resp.status != 200:
                    self.log(f'    [{i}] {label} HTTP {resp.status}')
                    continue
                body = resp.body()
                self.log(f'    [{i}] {label:<20} {len(body)/1048576:.2f} MB')
                if best is None or len(body) > len(best[1]):
                    best = (label, body)
            except Exception as e:
                self.log(f'    [{i}] {label} 异常 {type(e).__name__}')
        return best


def download(targets, out_dir=OUT, log=print, headless=True, force=False):
    """下载一批目标，返回 [(target, ok, path/msg)]。"""
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []

    with Grabber(log=log, headless=headless) as g:
        for idx, item in enumerate(targets, 1):
            url = to_url(item)
            log(f'--- ({idx}/{len(targets)}) {url}')
            try:
                vid, title, cands, media = g.fetch(url)
                log(f'    标题: {safe_name(title, 50)}')
                if not vid:
                    log('    [失败] 没能识别视频 ID')
                    results.append((item, False, 'no video id'))
                    continue

                exist = list(out_dir.glob(f'{vid}_*.mp4'))
                if exist and not force:
                    log(f'    [跳过] 已存在: {exist[0].name}')
                    results.append((item, True, str(exist[0])))
                    continue

                if not cands and not media:
                    log('    [失败] 没截到视频地址')
                    results.append((item, False, 'no stream'))
                    continue

                log(f'    候选 {len(cands)} 个，开始挑最高码率')
                best = g.save(cands, media, vid)
                if not best:
                    log('    [失败] 所有地址都下不动')
                    results.append((item, False, 'download failed'))
                    continue

                dest = out_dir / f'{vid}_{safe_name(title)}.mp4'
                for old in out_dir.glob(f'{vid}_*.mp4'):
                    try:
                        old.unlink()
                    except Exception:
                        pass
                dest.write_bytes(best[1])
                log(f'    [完成] {dest.name}  ({len(best[1])/1048576:.2f} MB, {best[0]})')
                results.append((item, True, str(dest)))
            except Exception as e:
                log(f'    [异常] {type(e).__name__}: {e}')
                results.append((item, False, f'{type(e).__name__}: {e}'))
    return results


def main():
    ap = argparse.ArgumentParser(description='抖音视频下载器')
    ap.add_argument('input', nargs='*', help='链接 / 短链 / 视频ID / 整段分享口令')
    ap.add_argument('--headful', action='store_true', help='显示浏览器窗口（排错用）')
    ap.add_argument('--force', action='store_true', help='已存在的也重新下')
    ap.add_argument('-o', '--out', default=str(OUT), help='输出目录')
    args = ap.parse_args()

    if args.input:
        text = '\n'.join(args.input)
    else:
        print('把抖音分享出来的整段文字粘进来，多个一行一个，空行结束：')
        lines = []
        while True:
            try:
                line = input('> ')
            except (EOFError, KeyboardInterrupt):
                break
            if not line.strip():
                if lines:
                    break
                continue
            lines.append(line)
        text = '\n'.join(lines)

    targets = extract_targets(text)
    if not targets:
        print('没有识别到抖音链接或视频 ID')
        return 1

    print(f'共 {len(targets)} 个目标\n')
    results = download(targets, out_dir=args.out,
                       headless=not args.headful, force=args.force)
    ok = sum(1 for _, s, _ in results if s)
    print('')
    print('=' * 58)
    print(f'完成：成功 {ok} / {len(results)}')
    for item, s, info in results:
        print(f'  {"OK " if s else "FAIL"}  {info[-70:]}')
    print('=' * 58)
    return 0 if ok == len(results) else 3


if __name__ == '__main__':
    sys.exit(main())
