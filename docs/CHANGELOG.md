# CHANGELOG

> 只记「用户可感知的变化」与「验证结论」。设计与取舍见 `Plan.md`。
> 每个版本的 GitHub Release 从这里摘取。

## 未发布

- **Web UI 支持字幕 / 弹幕**：B站 结果页多出「字幕 / 弹幕」两个开关（选择持久化，刷新后仍在），
  任务接口接受 `subs` / `danmaku`（只认显式 `true`），完成后任务卡片显示实际拿到的条数
  （字幕行数 / 弹幕条数）。其它平台不显示这两个开关
- **Web UI 支持专辑**：新增 `POST /api/album`（网易云 / QQ），界面粘贴专辑链接即列出曲目
  （上限 20，超出会明说略过几首），勾选后逐首建任务；实测 173 首专辑列 20 略 153，
  QQ《轻轻》专辑在界面里下载完成 3,554,923 字节
- **局域网模式 `--lan`**：服务绑 `0.0.0.0`，启动打印仅内网 IPv4 的带 token 地址与风险提示；
  `Origin` 只放行「与本请求 Host 一致」的来源（外来源仍 403）。实测同机走局域网 IP 访问 200
- **Android 手机壳**：`mobile/android/` 极薄 WebView 壳（无第三方依赖，APK 9,637 字节），
  粘 `http://<电脑IP>:8765/?token=...` 即可用电脑端的界面与下载；地址存 SharedPreferences

## v3.2.0 — 2026-10-23

**B站字幕/弹幕、QQ 全链路、专辑批量、酷我/酷狗、L2 嗅探**

- **B站字幕** `--subs`：`player/v2` → `subtitle_url` → SRT，中文 / `ai-zh` 优先；探测时只记 `bvid+cid`，
  不给普通 probe 加请求。实测 `BV1DSnK6REdy`（52s，7 种 AI 字幕）落 32 条；视频已存在走跳过分支仍补字幕；
  无字幕视频输出「该视频没有可用字幕（含 AI 字幕）」
- **B站弹幕** `--danmaku`：落同名 `.danmaku.xml`；实测 K/DA MV 1200 条 / 126,636 字节；番剧明确报「暂不支持」
- **B站进度分母**：改用 `Range: bytes=0-0` 探测的两条流真实字节（原先用 playurl 带宽估算，带宽缺失会退回单流分母）。
  实测 480P 21,093,538 字节全程分母唯一，79 个采样点仅最后 1 个 ≥99.9%
- **QQ 音乐全链路**：`auth qq` 扫码（49 cookies）+ `getQQ` 流式下载 + ffmpeg 标签/封面 + `.lrc` 歌词 + 路由。
  实测《轻轻》128K MP3 3,554,923 字节、96K AAC 2.60MB、`.lrc` 1,991 字节；**该账号 320K/FLAC 仍 104003**（会员权限）
- **QQ 下载前预览**：`/api/preview` 接 `previewQQ`；`/api/stream` 只对 `*.qqmusic.qq.com` / `*.tc.qq.com` 放行 http，
  其它站点仍强制 https。实测 Range 206 `audio/mpeg`，非白名单 http 仍 403
- **专辑批量** `--album`（网易云 / QQ）+ `--dry-run`：上限 20 并如实报略过数量（173 首 → 取 20 / 略过 153）；
  逐首下载、单首失败继续并在结尾汇总，有失败退出码 1
- **酷我 / 酷狗**：公开接口 probe + 下载 + 标签/封面（酷我另有 `.lrc`），已接路由。
  实测酷我 128kbps 3,368,054 字节、酷狗 128kbps 4,631,150 字节（带 `mjpeg` 封面）；会员档被拒时如实报试听档
- **L2 嗅探**：m3u8 / 直链 mp4·webm·mov·mkv·m4v·flv，HLS 用 ffmpeg 合成（进度/取消），直链复用 `.part` 续传。
  实测公开 HLS 184P 20,049,937 字节、直链 mp4 991,017 字节；**不跑页面 JS、不做 blob/MSE**
- **`auth --status` 默认在线校验**：过期 cookie 不再报「已登录」（实测 B站 `nav` code=-101 会被指出）
- **CLI 展示 warnings**：未登录 / 仅匿名档 / 会员档被拒 / 试听片段不再只藏在 `--json` 里
- **测试**：53 个，`bun test ts/tests` 全绿

## v3.1.0 — 2026-10-23

**限速、QQ 音乐探测骨架、可双击启动**

- **限速**：`--limit 2M`（K/M/G 与纯数字）与 `config.limitRate`（服务端启动/patch 即生效）；
  抖音 / B站 / 网易云的流式落盘全部接入。实测抖音 1080P 6,281,768 字节 @1M 用 6.53s，
  不限速 0.74s，两者 sha256 一致。边界：按单条流算（B站 音轨另起预算），yt-dlp 通用引擎不受此限速管辖
- **QQ 音乐**：只有匿名 `probe`（`canHandle` / `probeQQ`），**未接路由、无下载**。
  匿名只对部分免费曲放行：实测《轻轻》128K MP3 3,529,853 字节 / 96K AAC 2,703,704 字节，
  与接口 `size_128mp3` / `size_96aac` 一致；320K/FLAC 返回 `result=104003`（需登录）；
  搜索匿名不可用（`req_1.code=2001` + 登录页），只吃 songmid / 分享链接
- **启动**：删除指向已归档 `dy_gui.pyw` 的 `抖音下载器.bat`；新增 `VDACC.bat`
  （检查 bun → 起 8765 → `--open` 打开带 token 的浏览器）。实测 `GET /` 200、无 token `/api/health` 401
- **界面**：移除指向已删除 `/legacy/` 的「旧版」链接（原来点了 404）
- **文档**：目录说明/契约路径按 `ts/` + `legacy/python/` 现状重写；PWA 章节改为如实说明已移除
- **测试**：27 个（限速 4 组、QQ 纯函数 5 组），`bun test ts/tests` 全绿

## v3.0.0 — 2026-10-22

**正式版（TS 主线）**

- Vue 3 为默认入口；解析/多选/分P批量/下载前预览/设置/中英
- 进度聚合：B站 视频+音频按已完成字节累加，修复 99.9% 卡住
- 4K 策略定稿：**avc 兼容优先**（与 yt-dlp 的选流差异保留并记录）
- Python `vdl/` 冻结，不再演进；物理归档 `legacy/python/` 列入 3.0.1
- CI 改为 `workflow_dispatch` 手动触发（配额原因）

## v3.0.0-beta.6 — 2026-10-22

**默认入口切到 Vue**

- `/` → Vue 界面；`/legacy/` 保留旧版（回归用，确认后删）
- Service Worker 升 `vdacc-shell-v2`：导航请求网络优先，避免旧缓存把 `/` 锁成旧版
- 实测：`/` 加载 Vue、`/legacy/` 旧版输入框与任务区正常

待补：番剧 4K 选流对齐、删 legacy、3.0 正式版收口

## v3.0.0-beta.5 — 2026-10-22

**下载前流预览（Vue）**

- `POST /api/preview`：解析并返回代理地址；引擎直链缓存在进程内
- `GET /api/stream`：带 UA/Referer 代理（CDN 有防盗链），透传 Range 与 206
- 白名单限制：douyinvod / bilivideo / 126.net 等，避免 SSRF
- Vue 下载前「预览」按钮；实测抖音 `src=/api/stream`，HEAD 200

待补：切默认入口、番剧 4K 选流对齐

## v3.0.0-beta.4 — 2026-10-22

**Vue 批量三态全选**

- 分P/合集列表：全选 / 半选（indeterminate）/ 逐条勾选
- 硬上限 20；超限提示分批；预计体积按当前档位估算
- 清晰度整批统一，每个勾选项一个 job
- 实测：4 分P，初始全选 → 取消 1 → 全选 → 选 2，提交 `2/2`

待补：下载前流预览、切默认入口

## v3.0.0-beta.3 — 2026-10-22

**Vue 设置面板与本地预览**

- 设置弹窗：输出目录 / 主题 / 并发 / 通用解析开关 + 组件状态与安装
- 完成任务可「▶ 预览」本地文件（`GET /api/preview?path=`，仅限输出目录）
- 旧版的「下载前远程流预览」未迁移，Vue 只预览已完成文件
- Playwright 实测：设置回填、组件 17.1MB、任务 5.99MB、预览 src 指向 `/api/preview`

待补：批量三态全选、下载前预览、切默认入口

## v3.0.0-beta.2 — 2026-10-22

**Vue 3 迁移（切片）+ i18n**

- `/vue/`：无构建 Vue 3 页面（Vue 170KB 本地托管，无 CDN）
- 功能：解析、多选档位、分P 下拉、下载、SSE 任务、取消/重试、明暗主题
- i18n：中英切换，`localStorage` 持久化；旧版界面保留在 `/`
- 服务端静态路由支持目录 `index.html`
- 实测：抖音 3 档 + 5.99MB 完成；B站 4 分P 选中 P2；16+2 测试通过

待补（未迁到 Vue）：设置面板、预览、批量三态全选；旧版仍为默认入口

## v3.0.0-beta.1 — 2026-10-22

**可选通用组件 + 设置面板**

- `GET /api/components` / `POST /api/components/ytdlp/install`：按需下载 `yt-dlp.exe`（17.9MB，3s）
- `allowGeneric` 开关 + `engines/generic.ts`：未知站点 probe/get，直链实测 1,128,375 字节
- 设置面板 UI：输出目录 / 主题 / 并发 / 通用解析开关 + 组件安装状态
- 实测：组件安装、通用 probe、通用下载、设置弹窗（Playwright）均通过

已知边界：SSE 进度按单条流统计；番剧 4K 选流与 yt-dlp 有差异。

## v3.0.0-alpha.4 — 2026-10-22

**TS 测试与 CI**

- `bun test`：16 个用例（平台识别 / 命名 / 契约默认值 / 服务端 401·403·404·静态页 / 设置）
- 平台识别抽成 `core/platform.ts`，CLI / Skill / 服务端共用，避免三处正则漂移
- 服务端测试用子进程 + 随机端口 + `VDL_STORE` 隔离，不污染真实历史
- CI 新增 `test-ts` job（Bun + Python 构建校验），与 Python legacy 并行

待补：yt-dlp 可选组件、设置面板 UI

## v3.0.0-alpha.3 — 2026-10-22

**TS 版 Skill（单文件）**

- `tools/build_skill_ts.py`：`bun build --compile` 出 `vdl.exe`（91.9 MB），
  配 `SKILL.md` + `references/engines.md`，zip 42.6 MB
- 入口 `ts/src/skill_cli.ts` 刻意不含 `auth`/playwright，体积不膨胀
- 未知站点返回 `unsupported_url`（不再落到 `bad_input`）
- 实测：抖音 3 档 / 6.28 MB 下载；B站 4 分P + 1080P 推荐；网易云 2 档

待补：测试迁移、yt-dlp 可选组件、设置面板 UI

## v3.0.0-alpha.2 — 2026-10-22

**TS 服务能力补齐**

- 网易云下载：FLAC/320K + 800px 封面 + 标签 + `.lrc`（实测 19,066,853 字节）
- `auth`：Node Playwright 复用同一 profile；只落本站域名 cookie；`--status` / `--clear`
- 设置 `GET/PATCH /api/settings`（outDir / theme / concurrency / limitRate / allowGeneric）
- 任务取消（14.1% 实测）、重试（127MB 完成）、持久化（重启恢复，中断标记）
- 依赖：`playwright-core`（不下载浏览器，复用系统 Edge）

待补：Skill 切 TS、测试迁移、yt-dlp 可选组件

## v3.0.0-alpha.1 — 2026-10-22

**TS 后端主线（Bun）**

- `ts/` 成为默认入口：抖音、B站（分P / 番剧）、网易云解析；`probe/jobs/SSE/files` 服务
- 纯 TS B站：`playurl` + DASH + ffmpeg，probe **305ms**（Python 1.6s），分P 与 Python 字节一致
- 番剧实测：197 集、480P **127,096,266 字节 / 15.7s** 可播放
- 修复：Cookie 头 8.9KB 会触发 400，改为域名/过期过滤（27 条 / 1.7KB）
- 推荐档改为 **1080P**（批量/分P 场景）
- yt-dlp 降为**可选组件**，不内置
- `vdl/`（Python）冻结为 legacy，契约仍为 `schema=2`

待补：网易云下载、`auth`、设置 / 取消 / 持久化、Skill 切 TS、测试迁移

## v2.1.0 — 2026-10-22

**附属文件**

- `--cover`：封面存成同名图片（按 `Content-Type` 定 `.jpg/.png/.webp`），B站/抖音共用
- Web 界面：有缩略图时出现「封面」勾选框，默认勾上
- `tests/test_sidecar.py`：本地 HTTP 桩端到端验证「字幕 JSON → SRT → 落盘」
- 实测：抖音封面 438×330、B站 480P 封面 1600×900；测试 33 → 37

## v2.0.0 — 2026-10-22

**跨端入口**

- 手机/新浏览器首次打开显示「连接本机 VDACC」，粘贴 token 一次即可
- token 失效自动清除并回到连接页
- 移动布局 390×844 实测通过
- `integrations/mobile/README.md`：三种移动路线与「端上只跑纯 HTTP、B站必须遥控」的边界
- **原生壳未构建**：本机无 JDK / Android SDK / DevEco

## v1.3.0 — 2026-10-22

**入口**

- PWA：manifest + service worker（只缓存外壳，不缓存 `/api`）+ 192/512 图标
- Chrome/Edge MV3 扩展：右键转发链接，只做导航打开，不需要 host 权限
- `tools/build_portable.py`：便携包（40 文件 / 481KB，不打包 Python 本体）
- i18n 延期

## v1.2.0 — 2026-10-22

**内容完整性**

- 契约 `schema=2`：`media.parts[]`、`formats[].subtitles[]`（只增不改）
- B站 多P/合集：pagelist 取分P，`?p=N` 只解析该分P；UI 分P下拉
- `--subs` 落同名 `.srt`（中文优先）
- 实测：`BV1SknF6KE5g` 四P，P1 145MB / P2 89MB
- 边界：排行榜前 12 个视频均无 CC，字幕端到端只验证到「无字幕静默跳过」

## v1.1.0 — 2026-10-21

**可靠性**

- Range 断点续传（`.part` + 来源 URL sidecar，换候选不拼错）
- 网络/5xx 自动重试 3 次
- 任务取消（保留 `.part`）与重试；任务状态新增 `cancelled`
- `doctor --live` 三站点真解析；`--bundle` 脱敏诊断包
- `serve --concurrency 1~4`
- 实测：480P 取消于 39.8% 后重试完成；并发下抖音+网易云同时完成

## v1.0.0 — 2026-10-21

**首个可用版本**

- 四个引擎：抖音（纯 HTTP 签名）、B站（yt-dlp + 合并）、网易云（免签名 lossless）、
  `ytdlp-generic` 兜底
- `vdl serve`：token、SSE、任务队列、路径 jail、局域网、文件回传
- `vdl auth`：独立 profile 扫码，凭据不入库、不回显
- Skill：`video-acquire`（23 文件 / 90KB）
- 28 个离线测试 + CI
- Apache-2.0 + NOTICE
