# -*- coding: utf-8 -*-
"""纯函数层的回归测试：不联网、不依赖任何第三方包。

这些测试存在的意义是把「踩过的坑」钉死，尤其是 B站 的宽度归档——
按高度归档会把 4K 判成 2K，这是真实发生过的事故。
"""

import unittest

from vdl.core.errors import ErrorCode, VdlError
from vdl.core.models import Format, Media
from vdl.core.naming import safe_name
from vdl.core.router import build_engines, route
from vdl.engines.bilibili import BilibiliEngine


class RouterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engines = build_engines()

    def kind(self, url):
        return route(url, log=lambda *_: None).platform

    def test_douyin_forms(self):
        for url in ('https://www.douyin.com/video/6961737553342991651',
                    'https://v.douyin.com/abc123/',
                    '6961737553342991651'):
            self.assertEqual(self.kind(url), 'douyin', url)

    def test_netease_forms(self):
        for url in ('https://music.163.com/song?id=28606052',
                    'https://y.music.163.com/m/song?id=28606052',
                    '28606052'):
            self.assertEqual(self.kind(url), 'netease', url)

    def test_bilibili_forms(self):
        for url in ('https://www.bilibili.com/video/BV1j5nj68E48',
                    'https://b23.tv/abcd',
                    'BV1j5nj68E48'):
            self.assertEqual(self.kind(url), 'bilibili', url)

    def test_unknown_falls_back_to_generic(self):
        # 未知站点交给 yt-dlp 兜底，不再直接判 unsupported
        self.assertEqual(self.kind('https://example.com/x'), 'generic')

    def test_non_url_rejected(self):
        with self.assertRaises(VdlError) as ctx:
            route('随便一段话', log=lambda *_: None)
        self.assertEqual(ctx.exception.code, ErrorCode.UNSUPPORTED_URL)


class BilibiliBucketTest(unittest.TestCase):
    """宽银幕必须按宽度归档：1920×816 是 1080P，4096×1740 是 4K。"""

    def test_width_buckets(self):
        cases = {
            4096: 3840, 3840: 3840, 2560: 2560, 1920: 1920,
            1280: 1280, 854: 854, 640: 0,
        }
        for width, expected in cases.items():
            limit, _ = BilibiliEngine._bucket(width)
            self.assertEqual(limit, expected, f'width={width}')

    def test_wide_screen_not_downgraded(self):
        # 1920×816 是 1080P；4096×1740 是 4K（按高度会各降一档）
        self.assertEqual(BilibiliEngine._bucket(1920)[0], 1920)
        self.assertEqual(BilibiliEngine._bucket(4096)[0], 3840)

    def test_bare_bv_normalized(self):
        self.assertEqual(BilibiliEngine._normalize('BV1j5nj68E48'),
                         'https://www.bilibili.com/video/BV1j5nj68E48')
        self.assertEqual(BilibiliEngine._normalize('https://b23.tv/x'),
                         'https://b23.tv/x')


class FormatModelTest(unittest.TestCase):
    def test_internal_fields_not_serialized(self):
        fmt = Format(id='x', label='1080P', bytes=0, urls=['http://secret'],
                     extra={'video_id': '30080'})
        data = fmt.to_dict()
        self.assertNotIn('urls', data)
        self.assertNotIn('extra', data)
        self.assertIsNone(data['bytes'])      # 未知就是 null，不是 0

    def test_media_roundtrip(self):
        media = Media(id='1', title='t', duration_ms=0)
        self.assertIsNone(media.to_dict()['duration_ms'])


class NamingTest(unittest.TestCase):
    def test_illegal_chars(self):
        self.assertEqual(safe_name('a/b:c*d?e"f<g>h|i#j'), 'a_b_c_d_e_f_g_h_i_j')

    def test_trim_and_limit(self):
        self.assertEqual(safe_name('  ...  '), 'media')
        self.assertEqual(len(safe_name('x' * 200)), 55)

    def test_cjk_kept(self):
        self.assertEqual(safe_name('鸟之诗 (八音盒版)'), '鸟之诗 (八音盒版)')


class ErrorTest(unittest.TestCase):
    def test_default_next_action(self):
        err = VdlError(ErrorCode.NEED_LOGIN, '需要登录')
        self.assertIn('vdl auth', err.to_dict()['next_action'])

    def test_custom_next_action(self):
        err = VdlError(ErrorCode.DISK, '没空间', next_action='清理磁盘')
        self.assertEqual(err.to_dict()['next_action'], '清理磁盘')


if __name__ == '__main__':
    unittest.main()
