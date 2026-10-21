# -*- coding: utf-8 -*-
"""扫码登录 → 导出明文 cookie。

为什么必须用浏览器而不是"让用户手贴 cookie"：
- `MUSIC_U` / `SESSDATA` 都是 **HttpOnly**，`document.cookie` 读不到；
- 我们用的是自己起的独立 profile，`storage_state()` 是进程内合法持有者导出，
  不涉及 App-Bound Encryption 解密（那条路见 AGENTS.md 红线 3，实测无解）。

产物：
- `<data>/auth/<site>.json`        —— Playwright storage_state（含凭据，勿提交）
- `<data>/auth/<site>.cookies.txt` —— Netscape 格式，直接喂 `yt-dlp --cookies`
"""

import json
import time

from .core.paths import auth_file, cookies_file, profile_dir

SITES = {
    'bilibili': {
        'login_url': 'https://passport.bilibili.com/login',
        'domain': 'bilibili.com',
        'need': ('SESSDATA', 'DedeUserID'),      # 两枚齐了才算登录成功
        'label': 'B站',
    },
    'netease': {
        'login_url': 'https://music.163.com/login?targetUrl=%2F',
        'domain': 'music.163.com',
        'need': ('MUSIC_U',),
        'label': '网易云音乐',
    },
}

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')


def _log(msg=''):
    print(msg, flush=True)


def _netscape(cookies, domain):
    """转成 yt-dlp 能吃的 Netscape 格式；只导目标站点，别把无关 cookie 带走。"""
    lines = ['# Netscape HTTP Cookie File',
             '# 由 vdl auth 生成，含凭据，勿提交/勿分享', '']
    for c in cookies:
        host = c.get('domain') or ''
        if domain not in host:
            continue
        expiry = int(c.get('expires') or 0)
        if expiry < 0:
            expiry = 0
        lines.append('\t'.join([
            host,
            'TRUE' if host.startswith('.') else 'FALSE',
            c.get('path') or '/',
            'TRUE' if c.get('secure') else 'FALSE',
            str(expiry),
            c.get('name') or '',
            c.get('value') or '',
        ]))
    return '\n'.join(lines) + '\n'


def login(site, timeout=300):
    spec = SITES.get(site)
    if not spec:
        _log(f'不认识的站点: {site}（可选: {", ".join(SITES)}）')
        return 2

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        _log('缺少 playwright。用仓库里的 venv 跑：')
        _log(rf'  venv\Scripts\python.exe -m vdl auth {site}')
        _log('（装一次即可：venv\\Scripts\\python.exe -m pip install playwright）')
        return 2

    _log(f'启动独立浏览器（profile: {profile_dir()}）')
    with sync_playwright() as pw:
        try:
            ctx = pw.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir()),
                channel='msedge',
                headless=False,
                viewport={'width': 1280, 'height': 900},
                locale='zh-CN',
                timezone_id='Asia/Shanghai',
                user_agent=UA,
                args=['--disable-blink-features=AutomationControlled',
                      '--no-first-run', '--no-default-browser-check'],
            )
        except Exception as e:                   # noqa: BLE001
            _log(f'浏览器起不来：{type(e).__name__}: {e}')
            _log('常见原因：上一个 vdl auth 还开着、占着同一个 profile。关掉它再试。')
            return 3

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto(spec['login_url'], wait_until='domcontentloaded', timeout=60000)
        except Exception as e:                   # noqa: BLE001
            _log(f'打开登录页失败：{e}')
            ctx.close()
            return 3

        _log(f'已打开{spec["label"]}登录页，请在浏览器窗口里扫码 / 登录。')
        _log(f'最多等待 {timeout} 秒，检测到登录会自动保存并关闭窗口。')

        deadline = time.time() + timeout
        ok = False
        while time.time() < deadline:
            try:
                names = {c['name'] for c in ctx.cookies()}
            except Exception:                    # 窗口被手动关掉
                names = set()
                break
            if all(n in names for n in spec['need']):
                ok = True
                break
            time.sleep(2)

        if not ok:
            _log('没检测到登录态（超时或窗口被关闭）。可以重跑这条命令。')
            try:
                ctx.close()
            except Exception:
                pass
            return 3

        time.sleep(1.5)                          # 等页面把附属 cookie 写完
        state = ctx.storage_state()
        try:
            ctx.close()
        except Exception:
            pass

    target = auth_file(site)
    target.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    try:
        target.chmod(0o600)
    except OSError:
        pass

    jar = cookies_file(site)
    jar.write_text(_netscape(state['cookies'], spec['domain']), encoding='utf-8')
    try:
        jar.chmod(0o600)
    except OSError:
        pass

    names = sorted({c['name'] for c in state['cookies']
                    if spec['domain'] in (c.get('domain') or '')})
    _log(f'登录成功，已保存 {len(names)} 个 cookie（{", ".join(names[:8])}'
         f'{"…" if len(names) > 8 else ""}）')
    _log(f'  凭据: {target}')
    _log(f'  给 yt-dlp: {jar}')
    _log('提示：文件名和内容都含凭据，不要提交、不要贴群里。')
    return 0


def status():
    rows = []
    for site, spec in SITES.items():
        path = auth_file(site)
        if not path.exists():
            rows.append({'site': site, 'label': spec['label'], 'loggedIn': False,
                         'cookies': 0, 'path': str(path), 'updatedAt': None})
            continue
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except Exception:                        # noqa: BLE001 - 坏文件也算未登录
            data = {'cookies': []}
        names = {c['name'] for c in data.get('cookies', [])
                 if spec['domain'] in (c.get('domain') or '')}
        rows.append({
            'site': site, 'label': spec['label'],
            'loggedIn': all(n in names for n in spec['need']),
            'cookies': len(names),
            'path': str(path),
            'updatedAt': int(path.stat().st_mtime),
        })
    return rows


def clear(site):
    spec = SITES.get(site)
    if not spec:
        return 2
    removed = 0
    for path in (auth_file(site), cookies_file(site)):
        if path.exists():
            path.unlink()
            removed += 1
    _log(f'已清除 {spec["label"]} 的 {removed} 个凭据文件')
    return 0
