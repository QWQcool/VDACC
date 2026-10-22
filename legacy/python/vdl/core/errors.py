# -*- coding: utf-8 -*-
"""错误码 —— 契约的一部分，不是日志。

原则：每个 code 都必须能回答「下一步做什么」。像 `Fresh cookies needed`
那种既不能重试也不能换路的报错，是反面教材（见 README 的 2026-10-21 更正）。
"""


class ErrorCode:
    # 输入 / 路由
    BAD_INPUT = 'bad_input'
    UNSUPPORTED_URL = 'unsupported_url'
    NOT_IMPLEMENTED = 'not_implemented'

    # 权限 / 风控
    NEED_LOGIN = 'need_login'
    SIGN_REJECTED = 'sign_rejected'
    FILTERED = 'filtered'

    # 解析
    NO_STREAM = 'no_stream'
    WRONG_VIDEO = 'wrong_video'
    BAD_JSON = 'bad_json'

    # 传输
    HTTP_ERROR = 'http_error'
    NETWORK = 'network'
    TIMEOUT = 'timeout'
    BUSY = 'busy'

    # 落地
    DISK = 'disk'
    DOWNLOAD_FAILED = 'download_failed'
    TRUNCATED = 'truncated'
    BAD_PAYLOAD = 'bad_payload'

    # 环境
    FFMPEG_MISSING = 'ffmpeg_missing'
    BROWSER_MISSING = 'browser_missing'
    ENGINE_UNAVAILABLE = 'engine_unavailable'


# 给 agent / 用户看的默认建议；具体调用处可以覆盖。
NEXT_ACTIONS = {
    ErrorCode.BAD_INPUT: '检查链接是否完整；短链需要能跳转',
    ErrorCode.UNSUPPORTED_URL: '当前只支持抖音；B站/网易云在排期中',
    ErrorCode.NOT_IMPLEMENTED: '等对应引擎接入，或改用 --engine browser',
    ErrorCode.NEED_LOGIN: '运行 `vdl auth <site>` 扫码登录一次',
    ErrorCode.SIGN_REJECTED: '签名被拒：先重试；仍失败说明算法变了，临时用 --engine browser',
    ErrorCode.FILTERED: '视频被平台下架/限制（私密、已删、地区限制），换源',
    ErrorCode.NO_STREAM: '没解析到可下载流；用 --engine browser 对比一下',
    ErrorCode.WRONG_VIDEO: '接口返回了别的视频，重试；持续出现说明接口变了',
    ErrorCode.BAD_JSON: '接口返回非 JSON，多半被风控拦截；稍后重试',
    ErrorCode.HTTP_ERROR: '看 message 里的状态码与响应片段',
    ErrorCode.NETWORK: '检查网络/代理后重试',
    ErrorCode.DISK: '检查输出目录权限与剩余空间',
    ErrorCode.FFMPEG_MISSING: '把 ffmpeg.exe/ffprobe.exe 放进 venv\\Scripts 或加进 PATH',
    ErrorCode.BROWSER_MISSING: '安装 playwright 或指定可用的 msedge/chrome',
}


class VdlError(Exception):
    """带契约错误码的异常。str(e) 是给人看的 message。"""

    def __init__(self, code, message, next_action=None, detail=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.next_action = next_action or NEXT_ACTIONS.get(code, '')
        self.detail = detail

    def to_dict(self):
        out = {'code': self.code, 'message': self.message}
        if self.next_action:
            out['next_action'] = self.next_action
        if self.detail:
            out['detail'] = self.detail
        return out
