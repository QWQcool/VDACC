#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抖音纯 HTTP 引擎 —— 自己算 x-secsdk-web-signature

背景（2026-10-21 更正，详见 Plan.md 变更记录）
----------------------------------------------
本仓库原先认为抖音 aweme/detail 要求 a_bogus、只有浏览器里的 JS 算得出，
所以整个工具建立在 Playwright 截流上。实测推翻了这个前提：真正的门是
x-secsdk-web-signature，算法就是一次 MD5：

    sig = md5(f"{uifid}_{timestamp}_{SALT}_{query}")

SALT 硬编码，query 是按插入顺序 urlencode 的参数字符串，所以纯 HTTP 就能算完，
既不需要浏览器，也不需要用户自己的 cookie：

    ttwid               —— POST /ttwid/register 自己注册
    passport_csrf_token —— 随便填（服务端只检查存在）
    uifid               —— 优先读 cookie；没有就用首页响应头 x-tt-trace-host

query 里必须带 aid=6383，否则清晰度会被截到 720p（PR #17826 里 juranranranran 的发现）。

只依赖标准库：故意不用 requests/httpx —— 换台机器 clone 下来就能跑，
也让这个模块可以单独塞进任何 agent 的 Skill 里，不必先装依赖。

局限（当前版本）
----------------
- 只做单视频，不做主页批量/图文/直播；
- cookie 只在进程内存里，不落盘（所以每次启动都要重新注册 ttwid，约 0.3 秒）；
- 抖音改算法就失效，失效时抛 HttpEngineError，由上层回退浏览器方案。
"""

import argparse
import hashlib
import http.cookiejar
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field

HOST = 'https://www.douyin.com'
DETAIL_URL = HOST + '/aweme/v1/web/aweme/detail/'
TTWID_URL = HOST + '/ttwid/register'

SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E'   # PR #17826
AID = 6383                                   # aweme_general：决定能拿到 1080p 档位

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')

# uifid 在不同时期/不同入口下的 cookie 名，PR 里列了这六个
UIFID_COOKIES = ('uifid', 'uifid_temp', 'uifidtemp',
                 'UIFID', 'UIFID_TEMP', 'UIFIDTEMP')

VID_RE = re.compile(r'/(?:video|note)/(\d{15,20})')
MODAL_RE = re.compile(r'[?&]modal_id=(\d{15,20})')
BARE_ID_RE = re.compile(r'^\s*(\d{15,20})\s*$')


class HttpEngineError(RuntimeError):
    """带错误码的失败，方便上层决定「回退浏览器」还是「直接报错」。"""

    def __init__(self, message, code='http_error'):
        super().__init__(message)
        self.code = code


@dataclass
class Candidate:
    rate: int          # bit_rate，排序用；不确定的给 0
    label: str         # 给人看的档位名，如 h264_1080p_2540397
    url: str


@dataclass
class Media:
    vid: str
    title: str
    author: str
    duration_ms: int
    candidates: list = field(default_factory=list)


def extract_vid(text):
    """从各种形态的抖音链接里抠视频 ID：/video/、?modal_id=、裸 ID。"""
    if not text:
        return ''
    for rx in (VID_RE, MODAL_RE):
        m = rx.search(text)
        if m:
            return m.group(1)
    m = BARE_ID_RE.match(text)
    return m.group(1) if m else ''


class DouyinHttp:
    """一个进程内复用的 HTTP 会话（cookie 在内存里）。"""

    def __init__(self, log=print, timeout=20):
        self.log = log
        self.timeout = timeout
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))
        self._uifid = None

    # ------------------------------------------------------------ 底层请求

    def _request(self, url, data=None, headers=None, timeout=None):
        hdrs = {
            'User-Agent': UA,
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': HOST + '/',
        }
        hdrs.update(headers or {})
        req = urllib.request.Request(url, data=data, headers=hdrs)
        try:
            return self.opener.open(req, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as e:
            # 403 的响应体里通常带 ArgusSecurityPlugin 的具体原因，原样带出去
            try:
                body = e.read(600).decode('utf-8', 'replace').strip()
            except Exception:
                body = ''
            code = 'blocked' if e.code == 403 else f'http_{e.code}'
            raise HttpEngineError(f'HTTP {e.code}: {body[:400]}', code) from None
        except urllib.error.URLError as e:
            raise HttpEngineError(f'网络错误: {e.reason}', 'network') from None

    # ------------------------------------------------------------ cookie

    def _cookie(self, names):
        for c in self.jar:
            if c.name in names:
                return c.value
        return None

    def _set_cookie(self, name, value):
        cookie = http.cookiejar.Cookie(
            version=0, name=name, value=value, port=None, port_specified=False,
            domain='.douyin.com', domain_specified=True, domain_initial_dot=True,
            path='/', path_specified=True, secure=True, expires=None,
            discard=True, comment=None, comment_url=None, rest={}, rfc2109=False)
        self.jar.set_cookie(cookie)

    def _ensure_cookies(self):
        """把 detail 接口要求的两块敲门砖补齐，全程不需要用户登录。"""
        if not self._cookie(('ttwid',)):
            self._request(
                TTWID_URL,
                data=json.dumps({'aid': AID, 'service': 'www.douyin.com'}).encode(),
                headers={'Content-Type': 'application/json',
                         'Accept': 'application/json, text/plain, */*'})
            if not self._cookie(('ttwid',)):
                raise HttpEngineError('ttwid 注册失败（没有拿到 Set-Cookie）', 'no_ttwid')
        if not self._cookie(('passport_csrf_token',)):
            self._set_cookie('passport_csrf_token', uuid.uuid4().hex)

    def _get_uifid(self):
        """uifid 优先来自 cookie；没有就用首页响应头 x-tt-trace-host（0xvd 的发现）。"""
        if self._uifid:
            return self._uifid
        value = self._cookie(UIFID_COOKIES)
        if not value:
            resp = self._request(HOST + '/', headers={
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'})
            value = resp.headers.get('x-tt-trace-host')
            try:
                resp.close()
            except Exception:
                pass
        if not value:
            raise HttpEngineError('拿不到 uifid（cookie 与 x-tt-trace-host 都为空）', 'no_uifid')
        self._uifid = value
        return value

    # ------------------------------------------------------------ 签名

    def _sign(self, query):
        """签名 + 补齐参数。顺序必须与 PR #17826 一致，否则 md5 对不上。"""
        uifid = self._get_uifid()
        timestamp = str(int(time.time()))
        signed = {**query, 'uifid': uifid, 'timestamp': timestamp}
        encoded = urllib.parse.urlencode(signed)
        digest = hashlib.md5(f'{uifid}_{timestamp}_{SALT}_{encoded}'.encode()).hexdigest()
        return {**signed, 'x-secsdk-web-signature': digest}

    # ------------------------------------------------------------ 取详情

    def fetch(self, target):
        """返回 Media。target 可以是链接、短链或裸 ID。"""
        vid = extract_vid(target)
        if not vid:
            # 短链：先跟随跳转，从落地 URL 里再抠一次
            resp = self._request(target, headers={
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'})
            vid = extract_vid(resp.geturl())
            try:
                resp.close()
            except Exception:
                pass
        if not vid:
            raise HttpEngineError('没能从这个输入里识别出视频 ID', 'bad_input')

        self._ensure_cookies()
        query = self._sign({'aweme_id': vid, 'aid': AID})
        url = DETAIL_URL + '?' + urllib.parse.urlencode(query)
        resp = self._request(url, headers={
            'Accept': 'application/json, text/plain, */*',
            'Referer': HOST + '/video/' + vid})
        raw = resp.read()
        try:
            resp.close()
        except Exception:
            pass

        try:
            data = json.loads(raw.decode('utf-8', 'replace'))
        except Exception:
            raise HttpEngineError(
                f'详情不是 JSON（前 120 字节: {raw[:120]!r}）', 'bad_json') from None

        aweme = data.get('aweme_detail')
        if not aweme:
            # 失效/私密/地区限制的响应也会 200，但 aweme_detail 是 null，
            # 真正的原因在 filter_detail.filter_reason（如 core_dep），别把整个 JSON 甩给用户
            fd = data.get('filter_detail') or {}
            reason = fd.get('filter_reason') or ''
            note = fd.get('detail_msg') or data.get('status_msg') or data.get('message') or ''
            bits = '；'.join(x for x in (reason, note) if x)
            raise HttpEngineError(
                '响应里没有 aweme_detail' + (f'（{bits}）' if bits else ''),
                'filtered' if reason else 'no_detail')

        # 关键校验：详情接口有时会回推荐视频，必须按 aweme_id 对号入座
        got = str(aweme.get('aweme_id') or '')
        if got and got != str(vid):
            raise HttpEngineError(f'返回的视频 ID 不匹配（要 {vid}，拿到 {got}）', 'wrong_video')

        video = aweme.get('video') or {}
        author = aweme.get('author') or {}
        return Media(
            vid=str(vid),
            title=(aweme.get('desc') or '').strip() or f'douyin_{vid}',
            author=author.get('nickname') or '',
            duration_ms=int(video.get('duration') or 0),
            candidates=self._candidates(video),
        )

    @staticmethod
    def _candidates(video):
        """按码率从高到低排；带水印的 download_addr 只放最后兜底。"""
        out = []
        for br in (video.get('bit_rate') or []):
            rate = int(br.get('bit_rate') or 0)
            label = br.get('gear_name') or f'{rate}bps'
            for u in ((br.get('play_addr') or {}).get('url_list') or []):
                if u.startswith('http'):
                    out.append(Candidate(rate, label, u))
        # 老接口/没有 bit_rate 数组时的兜底档位
        for key in ('play_addr_h264', 'play_addr', 'play_addr_265'):
            for u in ((video.get(key) or {}).get('url_list') or []):
                if u.startswith('http'):
                    out.append(Candidate(0, key, u))
        # download_addr 是带水印的播放流，只能垫底
        for u in ((video.get('download_addr') or {}).get('url_list') or []):
            if u.startswith('http'):
                out.append(Candidate(-1, 'download_addr(带水印)', u))

        seen, uniq = set(), []
        for c in sorted(out, key=lambda x: -x.rate):
            if c.url not in seen:
                seen.add(c.url)
                uniq.append(c)
        return uniq

    # ------------------------------------------------------------ 下载

    def download(self, media, dest, max_try=3, force=False):
        """流式下载到 dest，成功返回 (档位名, 字节数)。

        不再像浏览器版那样"把所有候选整个读进内存比大小"：直接按码率从高到低
        试，写 .part 再原子改名，失败就换下一个候选。
        """
        dest = pathlib.Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists() and not force:
            return 'existing', dest.stat().st_size

        part = dest.with_name(dest.name + '.part')
        last = None
        for i, cand in enumerate(media.candidates[:max_try], 1):
            try:
                size = self._download_one(cand.url, part)
                if not self._looks_like_video(part, size):
                    raise HttpEngineError(f'落地文件不像视频（{size} 字节）', 'bad_payload')
                dest.unlink(missing_ok=True)
                part.replace(dest)
                return cand.label, size
            except HttpEngineError as e:
                last = e
                self.log(f'    [候选 {i}/{min(max_try, len(media.candidates))}] '
                         f'{cand.label} 失败: {e}')
            except Exception as e:      # 网络中断 / 磁盘异常
                last = e
                self.log(f'    [候选 {i}] {cand.label} 异常: {type(e).__name__}: {e}')
            finally:
                if part.exists():
                    try:
                        part.unlink()
                    except Exception:
                        pass

        raise HttpEngineError(f'所有候选都失败（最后: {last}）', 'download_failed')

    def _download_one(self, url, part):
        req = urllib.request.Request(url, headers={
            'User-Agent': UA,
            'Referer': HOST + '/',
            'Accept': '*/*',
        })
        written = 0
        with self.opener.open(req, timeout=120) as resp, open(part, 'wb') as f:
            expected = resp.headers.get('Content-Length')
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                written += len(chunk)
        if expected and expected.isdigit() and int(expected) != written:
            raise HttpEngineError(
                f'长度不符（声明 {expected}，实收 {written}）', 'truncated')
        return written

    @staticmethod
    def _looks_like_video(path, size):
        if size < 10 * 1024:
            return False
        with open(path, 'rb') as f:
            head = f.read(16)
        if head[4:8] == b'ftyp':
            return True
        # 少数封装 ftyp 不在最前，退回"不是文本"判断
        return not (head[:1] in (b'{', b'<'))


def _safe_name(s, limit=55):
    s = re.sub(r'[\\/:*?"<>|\r\n\t#]', '_', s or '')
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:limit] or 'douyin'


def setup_console():
    """Windows 管道/控制台默认 gbk，标题里的 emoji 会直接抛 UnicodeEncodeError。

    只改错误处理策略（不可编码的字符变 ?），不动编码：换编码在 cp936 终端上会变乱码。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except Exception:
            pass


def main(argv=None):
    setup_console()
    ap = argparse.ArgumentParser(description='抖音纯 HTTP 下载（不需要浏览器）')
    ap.add_argument('url', help='视频链接 / 短链 / 视频 ID')
    ap.add_argument('-o', '--out', default='下载', help='输出目录')
    args = ap.parse_args(argv)

    eng = DouyinHttp()
    media = eng.fetch(args.url)
    print(f'{media.title}')
    print(f'  作者: {media.author}  时长: {media.duration_ms / 1000:.1f}s  '
          f'候选: {len(media.candidates)}')
    if not media.candidates:
        print('没有可用档位')
        return 2

    out = pathlib.Path(args.out)
    dest = out / f'{media.vid}_{_safe_name(media.title)}.mp4'
    label, size = eng.download(media, dest)
    print(f'OK  {dest}  ({size / 1048576:.2f} MB, {label})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
