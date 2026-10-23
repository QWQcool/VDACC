# AGENTS.md —— 给后续 AI / 协作者的上下文

这个仓库是一个**多平台视频/音频下载工具**（抖音 / B站 / 网易云 + yt-dlp 通用兜底），
定位是「桌面可编程下载内核 + 可选 Web GUI + Agent Skill」。
动手前先读 `Plan.md`（路线图与待决策）。本文只写**不能违反的红线**和**已验证的事实**。

> **内容分析与生成侧已暂缓（2026-10-21）**：下载后自动分析、人物三视图、视频生成提示词反推
> 均不列入开发计划，等前提成熟再重启（见 `Plan.md` §3.4「暂缓」）。不要主动提议开始，
> 也不要因为看到 `Plan.md §4` 有设计就当成待办。

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
| 路由顺序 | 专用引擎（抖音/网易云/QQ/B站）→ `ytdlp-generic` 兜底。抖音裸 ID 规则最宽，必须排最前；QQ 只认域名（14 位 mid 裸串不路由） |
| ffmpeg | 本机 n8.1.2（winget，走 PATH）。TS 主线用 `VDL_FFMPEG` 或 PATH；legacy 的查找顺序 `venv\Scripts` → `PATH`（`legacy/python/vdl/core/env.py`）。缺失会让 B站/YouTube 变无声视频 |
| Playwright | 1.64.0，用 `channel=msedge` 复用系统 Edge，不下载 chromium |
| venv | 本机实际 **Python 3.12.0**（计划里写的 3.13.4 未复现）；必须带 tkinter |

ffmpeg 为什么是硬前提：B站/YouTube 全是 DASH 音视频分离，yt-dlp 下完会得到
`.fXXX.mp4` + `.fXXX.m4a` 两个文件然后警告 ffmpeg 不存在，结果是**无声视频**。
抖音那套能跑通，纯粹因为抖音返回单文件 mp4。

## 三、目录与运行

```
├─ ts/src/           主线（Bun）：cli.ts / server.ts / auth.ts / skill_cli.ts
│  ├─ core/          契约层：types / platform / config / http / progress / cancel / rate / naming / errors
│  └─ engines/       douyin / netease / qq / bilibili(_api) / generic(yt-dlp)
├─ ts/tests/         bun test（当前 22 个）
├─ web/              Vue 3 界面（默认入口 /）+ vendor / assets（无 PWA：sw/manifest 已删）
├─ ts/skill/         TS Skill 源（SKILL.md + references），由 tools/build_skill_ts.py 组装
├─ legacy/python/    Python 归档：vdl / skill / tests / tools / dy_* / VDACC.bat（冻结，仅参考）
├─ docs/             CHANGELOG.md、music-channels.md、design/
├─ tools/            构建脚本（build_skill_ts.py；legacy 构建在 legacy/python/tools/）
├─ VDACC.bat         双击启动：起服务 + --open 打开浏览器
├─ 下载/             输出目录（不入库）
└─ venv/             Python 环境（只给 legacy 用，不入库）
```

```bash
bun ts/src/cli.ts probe "<url>" --json
bun ts/src/cli.ts get "<url>" -o 下载 --limit 2M     # --limit 可选（K/M 后缀）
bun ts/src/server.ts --port 8765 --token <token>
cd ts && bun install          # auth 需要 playwright-core（复用系统 Edge）
bun test ts/tests
```

## 四、工程约定

- **代码里不写绝对路径。** TS 用 `import.meta.dir` + `path.join` 派生；legacy 用
  `pathlib.Path(__file__).resolve().parent`。输出目录可用参数覆盖。
- **服务端与 CLI 共用同一批引擎。** 业务逻辑只写在 `ts/src/engines/`，`cli.ts` / `server.ts` /
  `skill_cli.ts` 都只是壳。这个后端要给 agent 调用，输出必须是结构化数据而非只给人看的日志。
- **单例约束**：`%LOCALAPPDATA%\vdl\profile` 同时只能被一个进程使用（Playwright 会锁），
  TS `auth` 与 legacy 共用同一目录，所以两边也不能同时跑。
- **纯 HTTP 引擎只用标准库（legacy）。** `legacy/python/dy_http.py` 故意不依赖 requests / playwright：
  换台机器 clone 下来就能跑。别为省事给它添新依赖。
- **契约优先。** 对外字段只加在 `ts/src/core/types.ts`（schema=2），错误码由 `core/errors.ts` 统一；
  legacy 对应 `legacy/python/vdl/core/models.py`、`errors.py`，两边字段名必须一致。
  不许在壳里自己拼字段名，也不许把已知失败写成"下载失败"了事。
- **本地服务的安全约束别松。** `ts/src/server.ts` 必须：默认只绑 `127.0.0.1`、`/api/*` 校验 token、
  带 `Origin` 的请求校验同源（`VDL_ALLOW_ORIGIN` 才放行宿主）、`/api/reveal` 与 `/api/files`
  只能访问输出目录内的路径、`/api/stream` 只代理白名单域名。少任何一条，任意网页都能向本机提交任务或读走文件。
- `--lan` 只在 legacy（`legacy/python/vdl`）里有；TS 主线固定只绑 `127.0.0.1`，
  要暴露到局域网必须自己加，并且打印醒目警告、不要在公共网络下默认开启。
- **凭据只在用户目录。** `bun ts/src/cli.ts auth`（legacy：`python -m vdl auth`）写
  `%LOCALAPPDATA%\vdl\auth\`（`storage_state` 里是 HttpOnly cookie），profile 在
  `%LOCALAPPDATA%\vdl\profile`。两者永不入库、永不打印值——日志只报 cookie 名与数量。
- **Skill 只能由构建脚本组装。** TS 版：`python tools/build_skill_ts.py --zip`（单文件 `vdl.exe`
  + `ts/skill/SKILL.md`）；legacy 版：`legacy/python/tools/build_skill.py`。别手工往 `dist/` 拷代码。
  legacy 包刻意排除 `legacy/python/vdl/web` 与 `server.py`（Agent 不需要，且含授权受限的插画）；
  TS 包只含 `skill_cli.ts`。
- **legacy 已冻结。** `legacy/python/`（`dy_dl.py` / `dy_gui.pyw` / `vdl/` / `skill/` / `tests/`）
  只保留抖音浏览器兜底与历史参考，不再加新能力、不接新站点；新功能一律加在 `ts/`。
  **不要**把 tkinter 迁到 TS——浏览器引擎在 legacy 里，迁过去会丢能力。
- **3.0 起新能力只加 `ts/`。** 解析/服务的主线是 `ts/src`（Bun），`legacy/python/vdl/` 只修
  会让 legacy 彻底不可用的 bug，不接新站点、不改契约。对外契约仍是 `schema=2`，
  两边字段名必须一致（`ts/src/core/types.ts` ↔ `legacy/python/vdl/core/models.py`）。
- **TS 引擎的 Cookie 必须过滤。** B站 番剧接口对超大 Cookie 头返回 400；
  只带域名匹配且未过期的（约 27 条/1.7KB），不要直接把 `storage_state` 全拼进去。
- **提交前脱敏**：确认没有 cookie / 密钥 / 绝对路径 / 机器名进入 diff。
  `browser_profile/`、`cookies.txt` 已在 `.gitignore` 里，不要用 `-f` 强加。
- 中文注释，函数级说明写清「为什么这么做」，而不只是「做了什么」。
