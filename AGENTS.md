# AGENTS.md —— 给后续 AI / 协作者的上下文

这个仓库是一个**视频下载工具**，起点是抖音，正在向「多平台 + 视频分析」扩展。
动手前先读 `Plan.md`（路线图与待决策）。本文只写**不能违反的红线**和**已验证的事实**。

## 一、红线（踩过的坑，不要再走回头路）

1. **抖音签名的旧结论已作废，不要复用。**（2026-10-21 更正）

   旧结论（错）：`aweme/detail` 要求 `a_bogus`，只有浏览器 JS 算得出，所以必须借浏览器。

   实测结论（对）：
   - 门是 `x-secsdk-web-signature`，算法 `md5(f"{uifid}_{timestamp}_{SALT}_{query}")`，
     `SALT = A96D855A08C0A9707F8BEF0D9A527E4E`，硬编码；
   - `ttwid` 可自己 POST `https://www.douyin.com/ttwid/register` 注册，
     `passport_csrf_token` 随便填，所以**无 cookie 也能下**；
   - query 必须带 `aid=6383`，否则清晰度被截到 720p；
   - 对照实验：官方 yt-dlp 2026.08.19 未打补丁 → `HTTP 403` + `Fresh cookies needed`；
     打上 PR #17826 的 +56/-1 补丁 → 无 cookie 拿到 `h264_1080p`（1080×1920）。

   现状：修复在 PR #17826，未合并、0 条 review。因此两条都别做：
   - **不要**把抖音引擎删掉换回官方 yt-dlp——未合并前官方版仍然下不了；
   - **也**不要再用"必须借浏览器算签名"当设计理由——浏览器方案保留是为了兜底和其它站点。

2. **不要提议安装任何第三方 GUI**（ytDownloader / Open Video Downloader / Stacher / BBDown 之类）。
   全部基于 yt-dlp 或需要额外环境，且失去可控性。

3. **不要试图读取用户正在使用的浏览器的 cookie。** 三道墙实测无解：
   - 文件锁：Edge 运行时独占 `Network\Cookies`，只读都 PermissionError
   - 后台复活：关掉 Edge 后几秒自己又拉起
   - App-Bound Encryption：Chromium 127+ 密钥绑死浏览器进程，离线解密报
     `Failed to decrypt with DPAPI`

   **正确姿势**：用我们自己 `browser_profile` 起的独立 Edge，通过
   `context.storage_state()` 导出**明文** cookie。我们是进程内合法持有者，
   不涉及任何解密，也不碰用户的浏览器。这是唯一被认可的路。

4. **不做 DRM。** Widevine / Netflix / 付费点播无合法解法，直接判定不支持。

## 二、已验证的事实

| 项 | 值 |
|---|---|
| 抖音截流方案 | 可用，能拿 `normal_1080_0` 最高档，不依赖用户关闭浏览器 |
| yt-dlp 版本 | 2026.08.19（本机加载 1744 个提取器） |
| yt-dlp 的 B站支持 | 完整（BiliBili / Bangumi / Playlist / Live / Intl） |
| yt-dlp 的抖音支持 | 官方版仍 403 + 误导性 `Fresh cookies needed`；PR #17826（+56/-1）实测可修 |
| 抖音签名 | `x-secsdk-web-signature` = `md5(uifid_timestamp_SALT_query)`，纯 HTTP，无需 cookie |
| 网易云播放地址 | `GET /api/song/enhance/player/url?ids=[id]&br=999000` + `MUSIC_U` 直接返回 `level=lossless` 的 FLAC；**不需要 eapi/weapi 加密** |
| B站清晰度归档 | 必须按**宽度**（3840/2560/1920/1280/854）；宽银幕（1920×816、4096×1740）按高度会整体下移一档 |
| B站格式结构 | 全部是 video-only + audio-only，必须成对合并；带 cookie 才看得到 4K/1080P |
| ffmpeg | 当前开发机已装 n8.1.2（winget）；换机仍需确认，缺失会让 B站/YouTube 变无声视频 |
| Playwright | 1.64.0，用 `channel=msedge` 复用系统 Edge，不下载 chromium |
| venv | Python 3.13.4，必须带 tkinter |

ffmpeg 为什么是硬前提：B站/YouTube 全是 DASH 音视频分离，yt-dlp 下完会得到
`.fXXX.mp4` + `.fXXX.m4a` 两个文件然后警告 ffmpeg 不存在，结果是**无声视频**。
抖音那套能跑通，纯粹因为抖音返回单文件 mp4。

## 三、目录与运行

```
├─ dy_dl.py          入口 + 浏览器引擎（Playwright 截流）+ 命令行入口
├─ dy_http.py        纯 HTTP 引擎（只用标准库，自己算签名；默认优先）
├─ vdl/              core 契约层：models / errors / router / engines / cli / server / web
├─ skill/            SKILL.md + references + 入口脚本（Skill 打包源）
├─ tools/build_skill.py  组装 dist/video-acquire(.zip)
├─ dy_gui.pyw        tkinter 界面，worker 在子线程调 download()
├─ 抖音下载器.bat    start pythonw 启动 GUI，无命令行窗口
├─ browser_profile/  独立 Edge 配置（不入库，删了会自动重建）
├─ 下载/             输出目录（不入库）
└─ venv/             独立 Python 环境（不入库）
```

```bash
venv\Scripts\python.exe dy_dl.py "https://v.douyin.com/xxxx/"
venv\Scripts\python.exe dy_dl.py 7601899463951770978 --force
venv\Scripts\python.exe dy_dl.py 链接 --headful    # 显示窗口排错
```

## 四、工程约定

- **代码里不写绝对路径。** 一律用 `pathlib.Path(__file__).resolve().parent` 派生，
  输出目录可用参数覆盖。
- **GUI 与 CLI 共用同一后端。** 不许把业务逻辑写进 `dy_gui.pyw`。
  这个后端未来要给 agent 调用，输出必须是结构化数据而非只给人看的日志。
- **单例约束**：`browser_profile` 同时只能被一个进程使用，并发会崩。
  多任务必须串行或加文件锁。
- **纯 HTTP 引擎只用标准库。** `dy_http.py` 故意不依赖 requests / playwright：
  换台机器 clone 下来就能跑，以后塞进 Skill 也不用先 bootstrap 依赖。别为省事引入新依赖。
- **契约优先。** 对外字段只加在 `vdl/core/models.py`，错误码只加在 `vdl/core/errors.py`；
  CLI、Web GUI、Skill 都吃这两份。不许在壳里自己拼字段名，也不许把已知失败写成"下载失败"了事。
- **本地服务的安全约束别松。** `vdl serve` 必须：只绑 `127.0.0.1`、`/api/*` 校验 token、
  带 `Origin` 的请求校验同源、`/api/reveal` 只能打开输出目录内的路径。少任何一条，
  任意网页都能向本机提交任务或拉起程序。
- **凭据只在用户目录。** `vdl auth` 写 `%LOCALAPPDATA%\vdl\auth\`（`storage_state` 里是 HttpOnly cookie），
  profile 在 `%LOCALAPPDATA%\vdl\profile`。两者永不入库、永不打印值——日志只报 cookie 名与数量。
- **Skill 只能由构建脚本组装。** 别手工把 `vdl/` 拷进 `dist/`；改代码只改仓库再 `build_skill.py`。
  Skill 包刻意排除 `vdl/web` 与 `vdl/server.py`（Agent 不需要，且含授权受限的插画）。
- **legacy 已冻结。** `dy_dl.py` / `dy_gui.pyw` 只保留抖音的浏览器兜底，不再加新能力；
  新功能一律加在 `vdl/`。**不要**把 tkinter 迁到 vdl——浏览器引擎不在 vdl 里，迁过去会丢能力。
- **提交前脱敏**：确认没有 cookie / 密钥 / 绝对路径 / 机器名进入 diff。
  `browser_profile/`、`cookies.txt` 已在 `.gitignore` 里，不要用 `-f` 强加。
- 中文注释，函数级说明写清「为什么这么做」，而不只是「做了什么」。
