# CHANGELOG

> 只记「用户可感知的变化」与「验证结论」。设计与取舍见 `Plan.md`。
> 每个版本的 GitHub Release 从这里摘取。

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
