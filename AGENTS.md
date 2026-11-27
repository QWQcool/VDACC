# AGENTS.md —— 给后续 AI / 协作者的上下文

这个仓库是一个**多平台视频/音频下载工具**（抖音 / B站 / 网易云 / QQ / 酷我 / 酷狗 原生实现；
「其它站点」靠**可选**的 yt-dlp 组件，默认关闭），
定位是「桌面可编程下载内核 + 可选 Web GUI + MCP（给 Agent 用）」。
> 2026-11-23 起**没有 Skill 了**：SKILL.md 那种「给 Agent 看的说明」会随发版腐化
> （删之前它把 QQ / 酷我 / 酷狗 都写成不支持），Agent 入口统一走 `ts/src/mcp.ts`（stdio MCP，
> 四个工具 probe / get / album / jobs），Claude / Codex 原生可用，DSH 装 MCP 桥插件即可。
动手前先读 `Plan.md`（路线图与待决策）。本文只写**不能违反的红线**和**已验证的事实**。

> **内容分析与生成侧：解冻后当天又冻结（2026-11-02）**。计划见
> [`docs/style-transfer-plan.md`](docs/style-transfer-plan.md)——**它是冻结状态，不是待办**。
> 冻结原因：拿不到 H3 运行通道（用户不再长租算力；本机 10 GB 显存比 H3 的定位差一个数量级），
> 于是 A0 第三项与 A5 无法验收。重启条件（租几小时 24–48 GB 卡 / 官方额度 / 或收窄成纯分析）
> 写在该文档 §0.1。**人物三视图**另有结论：不排期（跨视角一致性不够）。
> 冻结期间的主线见 `Plan.md` §2.6。

## 一、红线（踩过的坑，不要再走回头路）

1. **抖音签名的旧结论已作废，不要复用。**（2026-10-21 更正）

   旧结论（错）：`aweme/detail` 要求 `a_bogus`，只有浏览器 JS 算得出，所以必须借浏览器。

   实测结论（对）：
   - 门是 `x-secsdk-web-signature`，算法 `md5(f"{uifid}_{timestamp}_{SALT}_{query}")`，
     `SALT = A96D855A08C0A9707F8BEF0D9A527E4E`，硬编码；
   - `ttwid` 可自己 POST `https://www.douyin.com/ttwid/register` 注册，
     `passport_csrf_token` 随便填；
   - **还需要 uifid**（2026-10-26 补正）：签名里必须带，取法见 `getUifid()` ——
     先查 6 种 uifid cookie，再 GET 首页从 `x-tt-trace-host` 响应头取。
     所以「完全无 cookie 也能下」这个说法不准确，准确表述是
     **「不需要登录 cookie，但 ttwid + uifid 缺一不可」**；
   - query 必须带 `aid=6383`，否则清晰度被截到 720p；
   - **Argus 会概率性拦截**：表现为 HTTP 403（`Blocked by ArgusSecurityPlugin Uifid Not Found`）
     或 **HTTP 200 + 空 body**。后者最坑——空 body 会被 JSON 解析器拒掉，看起来像接口改版。
     `fetchDetail()` 已做 3 次退避重试，每次清空 cookie 重新注册、重新签名（timestamp 变了签名必须变），
     连续失败才报 `blocked`。
   - **教训（2026-10-26 踩过）**：一次 `bad_json` 就断定「HTTP 引擎失效」，实际换个时刻就通了。
     排查风控类问题先重试几次再定性，单次失败不足以证明机制坏了。
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

4. **不要再做 UI/UX 与「体验数字」类测试（2026-11-04 起）。**

   这类测试只产出截图和耗时数字，**既不能证明功能正确，也没人会在发版前逐张比对**。
   明确禁止把它做成用例、验收项或发布门槛，包括但不限于：

   - 布局/视觉回归截图对比（`tools/ui_shots.cjs` 那组浅/深 × 中/英 × 390/768/1440 矩阵）、
     像素级对齐、暗色模式逐屏巡览；
   - 开屏/首屏耗时、滚动帧率、动画缓动曲线、骨架屏对比这类「体感数字」；
   - 无障碍朗读逐项核查、浏览器兼容矩阵（我们只保证自己那套壳与主流桌面浏览器）。

   **允许且应该做的只有功能验证**：页面能加载、按钮能触发对应请求、错误能显示出来、
   返回的字段对得上。判断标准一句话——**这条测试失败了，能说明「功能坏了」吗？**
   答不上来就别写。

   注意这条禁的是「把外观/手感变成测试与验收」，不是禁「实现 UI 时自己看一眼」。
   历史产物（`tools/ui_shots.cjs`、`tools/reduced_motion_check.cjs`、`docs/design/ui/shots/`）
   保留但不再维护，也不再作为发布门槛。

5. **DRM 研究决策已更新（2026-10-27）。** 取消「不做 DRM」的项目红线，允许把 DRM 和受保护媒体纳入研究计划，见 `Plan.md` §2.6.3 和 `ReversePlan.md`。这是研究范围变更，不表示项目已支持 Widevine 或其他 DRM，也不能把付费点播一概认定为 DRM；当前能力以代码与验证结果为准。

## 二、已验证的事实

> **完整事实表在 [`docs/verified-facts.md`](docs/verified-facts.md)**（40+ 条，按平台分：B站 / 抖音 /
> 网易云 / QQ / 酷我 / 酷狗 / Android / 工具链）。**动手前先读那个文件**——这里只留
> 「弄错就会直接写出错功能」的七条，以及它们之间的因果。

1. **路由顺序**：专用引擎（抖音/网易云/QQ/酷我/酷狗/B站）→ L2 直链·m3u8（`sniff`）→ `ytdlp-generic` 兜底。
   抖音裸 ID 规则最宽，必须排最前；L2 只认媒体扩展名，不跑页面 JS。
2. **ffmpeg 是硬前提**：B站 / YouTube 全是 DASH 音视频分离，缺它就只能得到无声视频；
   `analyze` 也依赖它（`/api/health` 的 `capabilities.analyze` 会为 false）。
3. **抖音**：`x-secsdk-web-signature = md5(uifid_timestamp_SALT_query)`，**ttwid + uifid 缺一不可**
   （但**不需要登录 cookie**）；Argus 会概率性 403 或 200+空 body——**单次失败不足以定性，先重试**。
4. **B站**：清晰度按**宽度**归档（3840/2560/1920/1280/854，按高度会把宽银幕整体下移一档）；
   字幕必须走 **wbi 签名的 `/x/player/wbi/v2`**（未签名的 `/x/player/v2` 会概率性返回别的稿件的字幕）；
   番剧第 4 档 `id=122` 只在页面 SSR `playurlSSRData` 里；**收藏夹是服务端分页、合集忽略 `pn/ps`**（本地切片）。
5. **网易云**：播放地址直接用 `/api/song/enhance/player/url`（**不需要 eapi/weapi**）；
   歌单 `trackIds` 恒为全量、详情要按 100 条一批补并按 id 还原。
6. **酷狗**：专辑 `album/info` 的 `songcount` 恒为 0，总数只能取 `album/song` 的 `total`；
   匿名只放行 `privilege=8 / pay_type=0`，付费曲回 `error:"需要付费"` 且 `url` 为空。
7. **QQ**：`result=104003` = **账号没有该档位权益**（320K/FLAC 需绿钻），
   **不是 cookie 没带上**——判据是同一账号在别的曲目上能拿到 128K/96K。

没有记录过的行为不要写成结论；先验，再写进 `docs/verified-facts.md`。

## 三、目录与运行

```
├─ ts/src/           主线（Bun）：cli.ts / server.ts / auth.ts / skill_cli.ts
│  ├─ core/          契约层：types / platform / config / http / progress / cancel / rate / naming / errors
│  ├─ engines/       douyin / netease / qq / kuwo / kugou / bilibili(_api) / sniff(L2) / generic(yt-dlp)
│  └─ analyze/       A1：分镜(scdet) / 抽帧 / 台词 / 客观指标（不依赖任何模型）
│                    cutlist.ts 把「分镜 + 静音」翻成 cutlist.csv（切点）与 cutlist.edl（保留段）
│                    只删 ≥1s 的静音；黑场/口头语/闪白要靠模型判断，猜错就是删正片，不做
│                    asr.ts 是可选适配器：找本机 whisper.cpp（VDACC_WHISPER_BIN/MODEL）→
│                    抽 16k wav → 读回 .srt；**不内建模型**，没装只记 warning，不静默降级
├─ ts/tests/         bun test（当前 425 个）；env.ts 是能力探测（非测试文件），
│                    capabilities.test.ts 把 ffmpeg/Bun 版本打进输出，缺什么一眼能看到
├─ web/              Vue 3 界面（默认入口 /）+ vendor / assets（无 PWA：sw/manifest 已删）
├─ ts/src/mcp.ts     MCP server（stdio + 行分隔 JSON-RPC）；默认**在本进程内** startServer({port:0})，
│                    也可用 VDACC_BASE_URL / VDACC_TOKEN 复用已开实例；能编译成单文件 exe
├─ ts/src/engines/douyin_shop.ts  抖音商城（商品主图视频 + 图集）；**详情长图不做**（要登录且风控）
├─ ts/src/shop/crawl.cjs          商城抓包：node + playwright-core + Edge（Bun 下 CDP 超时，必须走 node）
├─ legacy/python/    Python 归档：vdl / skill / tests / tools / dy_* / VDACC.bat（冻结，仅参考）
├─ docs/             CHANGELOG.md、verified-facts.md（平台事实表）、music-channels.md、
│                    design/（UI 与能力基线）、archive/（已收口章节）
├─ mobile/android/   Android 壳：本地引擎模式（引擎 bundle 在 assets）+ 连电脑模式
│                    engine/ 是引擎打包工程（Bun.build + shims），见同目录 README
│                    源码入库，build/ 与 .gradle/ 不入库
├─ tools/            构建脚本（build_skill_ts.py；legacy 构建在 legacy/python/tools/）
├─ scripts/setup.ps1 环境准备（Bun/ffmpeg/依赖/doctor），**必须存成 UTF-8 with BOM**
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

**环境准备（新机器 / 重装 / 从快照复原后）**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1              # 主线：Bun + ffmpeg + Python → bun install → doctor
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -WithLegacy  # 再加 venv + playwright/yt-dlp → legacy doctor
```

脚本**不依赖 winget**（本机实测 App Installer 缺失）：直接从官方发布地址下载、装到用户目录
（Bun → `%USERPROFILE%\.bun\bin`、ffmpeg → `%LOCALAPPDATA%\Programs\ffmpeg\bin`、
Python → `%LOCALAPPDATA%\Programs\Python\Python312`），并把目录写进用户 PATH。
装完必须**新开终端**，旧窗口不会刷新。只检查不安装加 `-SkipInstall`。

两个容易踩的点（脚本已处理，别改回去）：① Windows 的 `python.exe` 可能是 Store 占位别名，
必须真跑一次 `--version` 才算认到；② 子进程 Python 要 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`，
否则 legacy doctor 在中文 Windows 上按 GBK 输出，控制台一片乱码。

手工等价（有 winget 时更省事）：

```bash
winget install Oven-sh.Bun Gyan.FFmpeg    # 都装到用户目录；装完必须新开终端，旧窗口 PATH 不刷新
cd ts && bun install                       # 只装 playwright-core（复用系统 Edge，不下载浏览器）
venv\Scripts\python.exe -m pip install playwright yt-dlp   # 仅 legacy 需要
```

> 复原快照后**源码不会缺**（266 个跟踪文件与 `origin/main` 逐字节一致），缺的永远是这些不入库的东西：
> `ts/node_modules`、`venv/`、`下载/`、`browser_profile/` 与 `cookies.txt`（凭据要重新 `auth`）、
> `mobile/android/build/`。`setup.ps1` 负责前两项，凭据只能重新登录。

验收（缺一不可）：

```bash
bun --version                              # 1.4.x
ffmpeg -version                            # 9.x；缺了 B站/音乐/m3u8 全废
bun test ts/tests                          # 425 pass（缺 ffmpeg 时 3 条端到端 skip，capabilities.test.ts 会写明）
bun ts/src/cli.ts probe "<抖音或B站链接>" --json
```

`vdl auth`（扫码登录）依赖 `cd ts && bun install`，否则报 playwright-core 缺失。

**Android 构建与签名（2026-11-23 起）**

工具链装在 `C:\tools`：JDK 17 `jdk-17.0.21+9`、Gradle 8.7、SDK 34（`android-sdk`，含 platform-34 /
build-tools/34.0.0 / platform-tools）。`mobile/android/local.properties` 写 `sdk.dir=C:/tools/android-sdk`
（**正斜杠**，反斜杠会被 properties 当转义）。

```bash
# 本机 Maven Central 的 DNS 解析不了，必须用阿里云镜像（.tmp 里放 init 脚本，见 CHANGELOG 2026-11-20）
gradle assembleDebug   -I <mirror-init>.gradle     # 未签名调试包
gradle assembleRelease -I <mirror-init>.gradle     # 需要 keystore.properties，否则失败
```

签名文件 `mobile/android/keystore/vdacc-release.jks` + `keystore.properties` **都在 .gitignore 里**，
生成命令见 `keystore.properties.example`。**丢了就再也签不出同一个应用**（升级要卸载重装），自行备份。
当前产物：`app-release.apk` **822 KB**（minSdk 26 / target 34），`apksigner verify` 通过（`CN=VDACC`）。

## 四、工程约定

- **代码里不写绝对路径。** TS 用 `import.meta.dir` + `path.join` 派生；legacy 用
  `pathlib.Path(__file__).resolve().parent`。输出目录可用参数覆盖。
- **服务端与 CLI 共用同一批引擎。** 业务逻辑只写在 `ts/src/engines/`，`cli.ts` / `server.ts` /
  `skill_cli.ts` 都只是壳。这个后端要给 agent 调用，输出必须是结构化数据而非只给人看的日志。
- **单例约束**：`%LOCALAPPDATA%\vdl\profile` 同时只能被一个进程使用（Playwright 会锁），
  TS `auth` 与 legacy 共用同一目录，所以两边也不能同时跑。
- **纯 HTTP 引擎只用标准库（legacy）。** `legacy/python/dy_http.py` 故意不依赖 requests / playwright：
  换台机器 clone 下来就能跑。别为省事给它添新依赖。
- **请求与任务状态隔离。** `core/operation.ts` 为每个 HTTP 请求和下载任务创建独立作用域；
  引擎使用 `operationState`，不要重新引入全局 last* / URL 缓存或进度、取消回调。
  队列按设置起 1–4 个 worker；同名目标由 `core/dest.ts` 预留（同时写才加后缀），
ffmpeg 已改异步可取消。**限速仍是「每条流」**，总带宽 ≈ 并发 × 限速；yt-dlp 子进程不受我们的限速。
- **契约优先。** 对外字段只加在 `ts/src/core/types.ts`（schema=2），错误码由 `core/errors.ts` 统一；
  legacy 对应 `legacy/python/vdl/core/models.py`、`errors.py`，两边字段名必须一致。
  不许在壳里自己拼字段名，也不许把已知失败写成"下载失败"了事。
- **本地服务的安全约束别松。** `ts/src/server.ts` 必须：默认只绑 `127.0.0.1`、`/api/*` 校验 token、
  带 `Origin` 的请求校验同源（`VDL_ALLOW_ORIGIN` 才放行宿主）、`/api/reveal` 与 `/api/files`
  只能访问输出目录内的路径、`/api/stream` 只代理白名单域名。少任何一条，任意网页都能向本机提交任务或读走文件。
- **局域网模式**：TS 主线默认绑 `127.0.0.1`；`--lan` 会绑 `0.0.0.0` 供手机壳访问，
  必须同时满足：token 校验不变、`Origin` 只放行「与本请求 Host 完全一致」的来源、
  启动时打印醒目警告与仅内网 IP。公共网络下不要开。
- **凭据只在用户目录。** `bun ts/src/cli.ts auth`（legacy：`python -m vdl auth`）写
  `%LOCALAPPDATA%\vdl\auth\`（`storage_state` 里是 HttpOnly cookie），profile 在
  `%LOCALAPPDATA%\vdl\profile`。两者永不入库、永不打印值——日志只报 cookie 名与数量。
  **测试/冒烟必须设 `VDL_AUTH_DIR` 指到临时目录**：`POST /api/auth/bilibili/logout` 会真删
  `auth/bilibili.json`（2026-11-10 误删过一次，靠同目录 `bilibili.cookies.txt` 还原）。
- **独立包只能由构建脚本组装。** TS 版：`python tools/build_skill_ts.py --zip`（单文件 `vdl.exe`
  + 脚本内生成的 `README.txt`；**不再产 SKILL.md**）。别手工往 `dist/` 拷代码。
  面向 Agent 的入口是 `ts/src/mcp.ts`（MCP），不是包里的文档——文档会腐化，schema 不会。
  legacy 包（`legacy/python/tools/build_skill.py`）保持原样，只作历史参考。
- **商城抓取固定走 node 子进程。** `douyin_shop.ts` 用 `spawn('node', shop/crawl.cjs)`，
  不要在 Bun 里直接 import playwright——`connectOverCDP` 在 Bun 下会 30s 超时（`auth.ts` 早就记过这条）。
  另外**详情页长图不做**：H5 无详情区、`product/detail` 回 `10002 用户未登录`、扫码登录触发风控，
  三条路都实测堵死；别反复试登录，会被风控。
- **MCP 的 stdout 只许写协议。** `ts/src/mcp.ts` 里任何日志必须走 stderr；stdio 传输是
  **行分隔 JSON-RPC**，写错一行整条连接就废。工具级失败放 `result.isError`，
  不要用 JSON-RPC error（宿主会当成协议故障）。
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
