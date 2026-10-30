# Plan.md —— 计划、架构与决策（唯一计划来源）

> 状态：**3.4.2 已发布**（tag `v3.4.2`，2026-10-27）。后端主线为 TypeScript（Bun），
> Python 冻结并归档在 `legacy/python/`。硬性约束见 `AGENTS.md`，使用说明见 `README.md`，
> 逐版本历史见 `docs/CHANGELOG.md`，完成盘点见 §2.2，后续执行计划见 §2.6。

## 1. 文档地图

| 想知道 | 看哪里 |
|---|---|
| 接下来做什么、为什么 | **本文**（§2 版本路线） |
| 每个版本改了什么 | `docs/CHANGELOG.md` |
| 不能违反的红线、已验证事实 | `AGENTS.md` |
| 怎么用（安装、命令、界面） | `README.md` |
| 怎么发版（检查清单、体积基线） | `docs/RELEASE.md`（基线数字在 `docs/release-baseline.json`） |
| 给其它 Agent 的契约 | `ts/skill/SKILL.md`（legacy：`legacy/python/skill/SKILL.md`） |
| UI 参考、视觉基线、概念图 | `docs/design/` |
| 第三方来源与授权 | `NOTICE` / `THIRD_PARTY.md` |

---

## 2. 版本路线

### 2.1 已完成

| 版本 | 主题 | 提交 |
|---|---|---|
| M1 | core 契约层（models / errors / router / engines） | `c061013` |
| M2 | `vdl serve` + SSE + token + 路径 jail + Web 界面 | `7710bca` |
| M2.5 | `vdl auth` 扫码登录（B站 / 网易云） | `14bef16` |
| M3 | 界面按设计稿重做（chips / 多选 / 预览 / 角色） | `cf40734` |
| M4 | 网易云引擎（免签名 lossless + 标签封面歌词） | `0c6d95b` |
| M5 | B站引擎（yt-dlp + 合并 + 进度聚合） | `93de338` |
| M6 | Skill 打包（`video-acquire`） | `0f1a79c` |
| R1–R5 | 测试、配置/历史、generic 兜底、局域网、1.0 发布 | 见 CHANGELOG |
| v1.1 | 续传/重试、取消/重试、`doctor --live`、并发 | `ea523b3` |
| v1.2 | schema=2、B站分P、字幕 | `69c6ea2` |
| v1.3 | PWA、浏览器扩展、便携包 | `50cf8bb` |
| v2.0 | 手机首次连接、移动布局、移动路线边界 | `452169e` |
| v2.1 | 封面 sidecar、字幕落盘验证 | `ac37ca1` |

### 2.2 3.1–3.3 完成盘点（TS 主线）

> 本节保留既有验收记录；新的后续建议以 §2.6 为准。历史版本中的「待补」不自动转为当前待办。

> 原先这里是 Python 时代的 v2.2–v2.9 排期。其中的设置与登录态、Vue 3 + i18n、批量三态全选、
> 番剧、限速、单文件打包**都已在 3.0/3.1 完成**（见 `docs/CHANGELOG.md`），故整表重写。
> 批次约束继续有效：**清晰度整批统一**；默认上限 20、硬上限 50；必须 dry-run 预览；
> 只做「该视频所在的分P/合集」，**不做收藏夹抓取**。

#### 2.2.1 P0 收口（先让项目在本机能跑起来）

| 项 | 现状 | 验收 |
|---|---|---|
| 运行时决策 | ✅ 已解决（2026-10-23，winget 实装）：`winget install Oven-sh.Bun` → **Bun 1.4.4**，shim 在 `%LOCALAPPDATA%\Microsoft\WinGet\Links`（该目录已在用户 PATH，但**已开着的终端不会刷新**，需新开窗口——这正是上一轮"记录说装好、实际 `where bun` 找不到"的原因）。`VDACC.bat` 已加 fallback 直接探该路径。实测：`bun --version` / `bun test`（53 绿）/ `bun install`（playwright-core 1.64.1）/ server 起来后 `/` 200 且 `/api/*` 401 / 真实抖音 probe 成功。59 处无 `.ts` 后缀的相对 import 由 Bun 直接解析 | `bun run probe "<url>"` 可用 |
| 启动器 | ✅ 已解决（2026-10-23）：`抖音下载器.bat` 已删，改为 `VDACC.bat`（起服务 + `--open` 打开浏览器）；实测双击后 `/` 200、无 token 的 `/api/health` 401 | 双击起 Web 界面并自动打开浏览器 |
| 版本号 | ✅ 已解决（2026-10-23）：两个 `package.json` 与 `/api/health` 均为 3.1.0，`server.test.ts` 断言同步改为 3.1.0，CHANGELOG 补 v3.1.0，tag `v3.1.0` | 3.1.0 + tag + CHANGELOG 对齐 |

#### 2.2.2 P1 功能补齐

| 项 | 现状 | 验收 |
|---|---|---|
| QQ 音乐接路由 + 下载 | ✅ 已解决（2026-10-23）：`getQQ` 流式落盘 + 限速/续传 + ffmpeg 写 title/artist/album 与封面，已接 `platformOf`/server/cli。实测《轻轻》128K MP3 3,554,923 字节（3,529,853 原始 + 封面标签）、96K AAC 2.60MB，ffprobe 确认 128000bps / mjpeg 封面 / 三个标签。**该账号仍未放行 320K/FLAC**（104003），取决于会员 | probe 出档位；下载带标签/封面 |
| 番剧 4K 选流对齐 yt-dlp | ✅ 已定稿（2026-10-22）：avc 兼容优先，接受体积差（TS 1.47GB vs Python 1.89GB，同为 3840×2160）。不再作为待办 | 差异有明确结论，或消除 |
| SSE 进度分母 | ✅ 已解决（2026-10-23）：原实现已有 base+written 聚合，但分母用的是 playurl 带宽估算（带宽缺失时为 0，退回单流分母 → 视频下完先到 99.9% 再回落）。现改为 Range 探测两条流真实字节作分母，探不到才回退估算 | 视频+音频总字节作分母 |
| 字幕真实样本验证 | ✅ 已解决（2026-10-23）：TS 实现 `--subs`（`player/v2` → `subtitle_url` → SRT，中文/AI 中文字幕优先，失败不影响视频）；实测 `BV1DSnK6REdy`（52s，7 种 AI 字幕）落 32 条 `.srt`，重复执行走跳过分支仍会补字幕 | 找到有 CC 的视频跑通端到端 |

#### 2.2.3 P2 体验

| 项 | 说明 |
|---|---|
| 弹幕 XML | ✅ 已完成（2026-10-23）：`--danmaku` 落同名 `.danmaku.xml`，与 `--subs` 同机制（跳过视频也会补）；实测 K/DA MV 1200 条 / 126,636 字节；番剧明确报「暂不支持」 |
| 音乐专辑批量 | ✅ 已完成（2026-10-23）：`--album`（网易云 / QQ）+ `--dry-run` 预览，单批 20 首；**2026-10-26 补分批**：`offset` 续取（CLI `--offset`、`/api/album` 与界面「加载下一批」），仍逐首下载、失败继续并汇总。实测 173 首 → 第 1/2/9 批分别为 20/20/13，界面追加后保留勾选 |
| 酷我 / 酷狗 | ✅ 已完成（2026-10-23）：公开接口 probe + 下载 + 标签/封面（酷我还有 `.lrc`），已接路由。实测酷我 128kbps 3,368,054 字节 / 酷狗 128kbps 4,631,150 字节；320K/FLAC 需会员，接口拒绝时如实报试听档 |

#### 2.2.4 P3 可选 / 长期

| 项 | 前提 |
|---|---|
| 移动原生壳 | 🟡 Android 已做（2026-10-23）：`mobile/android/` 极薄 WebView 壳（无第三方依赖，APK 9,637 字节），配合服务端新增的 `--lan`；手机只当屏幕，解析/下载都在电脑上。HarmonyOS NEXT（HAP）待华为开发者账号；端上仍不跑引擎 |
| L2 通用嗅探（m3u8 / 直链） | ✅ 已完成（2026-10-23）：扩展名接管（mp4/webm/mov/mkv/m4v/flv/m3u8），m3u8 解析 master 变体（时长/体积估算）并用 ffmpeg 合成 mp4（进度/取消）；直链复用 `.part` 续传。实测公开 HLS 184P 20,049,937 字节、直链 mp4 991,017 字节。**不跑页面 JS、不做 blob/MSE**，网页仍交给 yt-dlp |

#### 2.2.5 不做

私密视频 / 直播；站点广度竞赛；收藏夹批量抓取；视频分析与生成侧（§2.4）。付费限制和 DRM 研究的决策已于 2026-10-27 更新，见 §2.6.3。

### 2.3 TS 可行性验证（`spike/ts-core`）

> 历史验证方案，TS 已在 3.0 转为主线；本节不再排期。2026-10-25 复核远端 spike 分支没有领先 main 的提交。

目的：回答「TS 能否等价替代 Python」，不是重写。分支 5 天，不合并，产出 `REPORT.md`。

| # | 问题 | 通过条件 |
|---|---|---|
| Q1 | 四个引擎能否等价实现 | 同一 URL 的 probe 字段一致；抖音 1080P 下载字节数相同 |
| Q2 | yt-dlp 怎么用 | 独立 `yt-dlp.exe`（**无系统 Python**）跑通 B站，进度可解析 |
| Q3 | 运行时能力 | HTTP/SSE、流式、续传、ffmpeg、重命名 |
| Q4 | 登录设施 | Playwright Node 的 `storageState` 与现有 `auth/*.json` 兼容 |
| Q5 | 打包 | `bun build --compile` 的 exe 体积与冷启动 |

失败条件（任一成立即写「不建议迁移」，不硬拗）：

- 抖音签名需要 Node 拿不到的头且无法绕过；
- `yt-dlp.exe` 在无 Python 环境跑不起来；
- 进度只能靠轮询文件大小且不稳定；
- exe 启动 > 3s 或体积 > 100MB。

若通过：**增量迁移**——新引擎（QQ）先用 TS，Python 保留旧引擎，`/api` 按平台路由；
parity 稳定后再决定 Python 是否退化为 yt-dlp helper。

### 2.4 暂缓与明确不做

**暂缓**（技术未成熟，不排期）：视频分析、人物三视图、提示词反推。
重启条件见 `AGENTS.md` 顶部；不要因为它们出现在 §3 设计里就当成待办。

**明确不做**：私密视频 / 直播；站点广度竞赛；收藏夹批量抓取；
端上跑 B站（依赖 yt-dlp，不可移植）；QQ/酷狗/酷我之外的音乐平台。

### 2.5 TS 主线（3.0，2026-10-22）

**决策：后端主线切到 TypeScript（Bun），Python 的 `vdl/` 冻结并归档到 `legacy/python/vdl/`。**

| 项 | 状态 |
|---|---|
| 引擎 | ✅ 抖音、网易云解析、B站（分P / 番剧，playurl + DASH + ffmpeg） |
| 服务 | ✅ `ts/src/server.ts`：probe / jobs / SSE / files / 静态页；界面（原 `vdl/web`）已提到仓库根 `web/`，现在是 Vue |
| 性能 | B站 probe 305ms（Python 1.6s）；分P 下载与 Python 字节一致 |
| 入口 | 根 `package.json`：`bun run serve` / `probe` / `get` |
| yt-dlp | 降为**可选组件**：未知站点按需下载，不内置 |
| 推荐档 | B站 批量/分P 默认 **1080P**，避免默认 1.4GB/集的 4K |
| 已补（alpha.2） | 网易云下载（标签/封面/歌词）、`auth`（Node Playwright）、设置、取消/重试、任务持久化 |
| 已补（alpha.3） | Skill 切 TS：单文件 `vdl.exe`（91.9MB）+ `SKILL.md`，zip 42.6MB |
| 已补（alpha.4） | TS 测试 16 个 + CI `test-ts`；平台识别抽成 `core/platform.ts` |
| 已补（beta.1） | yt-dlp 可选组件（安装 + `allowGeneric` + 通用引擎）、设置面板 UI |
| 已补（beta.2） | Vue 3 切片（`/vue/`，解析/多选/分P/下载/SSE/取消重试/主题）+ 中英 i18n |
| 已补（beta.3） | Vue 设置面板（目录/主题/并发/组件）+ 完成任务本地预览 |
| 已补（beta.4） | Vue 批量三态全选（分P/合集、上限 20、整批统一清晰度） |
| 已补（beta.5） | 下载前流预览（`/api/preview` + `/api/stream` 代理，含 Range） |
| 已补（beta.6） | 默认入口切 Vue；旧版移到 `/legacy/`；SW 导航网络优先 |
| 已补（3.1） | 限速：`core/rate.ts`，三引擎流式落盘接入；CLI `--limit 2M`；服务端读 `config.limitRate` |
| 已补（3.1） | QQ 音乐引擎骨架：匿名 `probe`（仅接口真放行的档位），**未接路由**、无下载 |
| 3.0.0 | 正式版：Vue 默认、B站 进度聚合、4K avc 兼容优先、CI 手动 |
| 3.0.1 | ✅ 已完成：Python 物理归档 `legacy/python/`、删 `/legacy/` 路由与旧 UI（Vue 唯一入口） |
| 3.1.0 | 限速 + QQ 音乐探测骨架（未接路由）+ 双击启动 + 版本/文档对齐（tag `v3.1.0`） |
| 3.2.0 | B站字幕/弹幕 + 进度真实分母、QQ 全链路（下载/歌词/预览）、专辑批量、酷我/酷狗、L2 嗅探、auth 在线校验（tag `v3.2.0`） |
| 3.3.0 | Web UI V2（infOS 风格）、限速进设置、并发诚实化、浮层 Esc/滚动锁/焦点、任务分组（tag `v3.3.0`） |
| 3.4.0 | 专辑分批、缺档位不静默换档、账号状态与重新登录、附属单独重取、`doctor` 与组件 SHA256 校验、Android 壳自动收起地址栏/离线页（tag `v3.4.0`） |
| 3.4.1 | ffmpeg 异步化、真实 worker 池（1–4）+ 目标路径预留、提交去重、酷我元数据降级、抖音详情抗风控（tag `v3.4.1`） |
| 3.4.2 | 前端模块化（i18n/api/format/jobs/overlays）+ 12 组布局回归脚本、Skill 包 manifest/SHA256SUMS 与校验器（tag `v3.4.2`） |
| 已知边界 | 番剧 4K 选流与 yt-dlp 有差异；B站 合并后的 mp4 比两条流之和大一点（容器索引，实测 61KB/21MB） |

契约不变：仍是 `schema=2`，`ts/src/core/types.ts` 与 `legacy/python/vdl/core/models.py` 字段一致。

---

### 2.6 2026-10-25 审计 / 10-26 修复与新开发计划

交互详情图：[后续开发工作台](docs/design/development-roadmap-2026-10-25.html)。
本节是唯一计划来源；HTML 为本轮修复和路线快照。后续版本是阶段划分，不承诺日期。

#### 2.6.1 审计基线与本轮已完成

修复前 `main`、`origin/main` 与远端实际 main 同为 `f16eb4a`，ahead/behind = 0/0，工作区干净。
`v3.3.0` 指向 `266af2a`，main 在标签后有两个环境/文档提交；spike/ts-core 无独有待合入提交。
最新已列出的 Release 为 v3.0.0-beta.6；v3.3.0 有标签、没有 Release。
这组值是**修复前快照**；本轮代码与计划按用户要求在 main 提交并推送，具体提交以 Git 历史为准。

本轮完成以下 7 个修复包：

1. **F01 · 安全边界**：完整 Origin 匹配；文件按 realpath + relative 归属校验；媒体代理每次重定向都重新检查白名单。伪 localhost、错误端口、相邻目录、junction 与跳转到内网均有回归。
2. **F02 · 数据可靠性**：创建父目录、同目录临时文件原子替换、设置类型校验、损坏存档不覆盖。新任务先落盘再入队，失败整体回滚；保留全部活跃任务及最近 100 条终态。
3. **F03 · Skill 能力**：probe/get 只接受实际内置的三平台，其余结构化拒绝；选项值不误认作 URL，编译产物已验证同样行为。
4. **F04 · 状态隔离**：引擎缓存、字幕/弹幕上下文、进度与取消回调移入独立 operation 作用域。交错测试验证下载 A 时解析 B 不串任务。当前依然是单 worker。
5. **F05 · 产物完整性**：Web/CLI 的抖音与 B站封面开关落盘；已存在主文件可补取附属文件，失败明确警告；字幕计数只反映实际内容；B站合并失败保留分离流。
6. **F06 · 界面恢复**：SSE 重连快照、防重复提交、失败提示与重试、深链解析、设置/预览焦点循环与返回；修复 768px/390px 溢出。验收脚本按本次任务 ID 判断，不再误用旧任务终态。
7. **F07 · 构建修复**：旧 CI 39744319053 的 TS Skill 步骤失败根因已从日志确认是中文输出遇到 cp1252；构建脚本统一 UTF-8。Bun 固定 1.4.4，继续手动 CI。

#### 2.6.2 已完成验证与未覆盖范围

- `bun test ts/tests`：**75 pass / 0 fail**，包含业务交错、持久化失败、真实服务路由与 Skill 子进程回归。
- `node tools/accept_regression_ui.cjs --python-acceptance`：9 类 Edge 场景及 Python V2 入口通过；真实本地媒体下载、服务重启、断线任务快照、焦点、网络失败恢复，1440/768/390px 无横向溢出。
- 在干净临时目录由官方脚本构建 Skill，模拟 `PYTHONIOENCODING=cp1252` 通过；ZIP 约 52.2MB、exe 约 110.0MB（Bun 1.4.4），编译产物的 JSON / 非零退出码验证通过。
- 全部自动场景使用临时用户/输出目录、测试 token、可控媒体/接口桩；没有读真实凭据。测试覆盖现有缺陷，不等于第三方平台在线可用性承诺。
- 第三方站点下载、会员档位、Android 真机与无开发环境机器仍需专门验收。新标签/Release 不随代码推送自动发布。
- 远端 CI 针对推送后的具体提交手动验证，结果以 Actions 为准；不把旧提交的失败当成本轮结论。

#### 2.6.3 后续阶段与明确验收门槛

**M1 · 3.4：可控并发与批次选择（优先）。**

- **N01 · 真正的 worker 池**：✅ 2026-10-27 完成——`core/ffmpeg.ts` 的 `runFfmpeg()`，
  B站 合并、音乐写标签/封面缩放（网易云 / QQ / 酷我 / 酷狗共用 `core/audio`）全部改异步；
  取消走 200ms 轮询任务作用域并 kill 子进程，找不到 ffmpeg 用 `code=-2` 区分。
  实测合并 9.48 MB 视频（h264+aac）与 QQ 标签仍正常，测试 86。
  **补了提交去重**（2026-10-26）：同 URL + 同档位已在队列时复用原任务，避免双击/重试写出两个同名文件；
  界面会提示未重复创建。
  **2026-10-27 完成 worker 池**：`core/dest.ts` 目标路径预留 + 七个引擎接入（`finally` 释放），
  网易云/QQ 固定临时封面改为跟随目标名；设置恢复 1/2/4，`workerLimit()` 读配置并夹在 1–4。
  实测 3 并发互不干扰、取消 A 不影响 B/C。
  **边界（已知）**：限速是「每条流」，总带宽 ≈ 并发 × 限速；HLS 合成仍由单个 ffmpeg 进程处理，
  不受 worker 数影响；generic 的 yt-dlp 子进程不读我们的限速。
- **N02 · 批次预览与后续批次**：✅ 2026-10-26 完成——`planAlbum` 带 `offset/hasMore/nextOffset`，
  CLI `--offset` 与 Web「加载下一批」共用；档位缺失改为显式 `no_stream`（列出可用档位），不再静默换档。
  已验：173 首批 20 / 第二批 40 / 末批 13、勾选保留、缺档位报错。**不做**收藏夹抓取。

**M2 · 3.5：infOS 体验一致性与可维护性。**

- **N03 · 前端模块化**：✅ 2026-10-27 完成——词条 `i18n.js`、`api.js`、`format.js`、`jobs.js`、`overlays.js`；
  `app.js` 628 → 481 行；`tools/ui_shots.cjs` 覆盖浅/深 × 中/英 × 390/768/1440，12/12 通过。
  剩余可选：reduced-motion 专项检查。
- **N04 · 登录与附属文件状态**：✅ 2026-10-26 完成——`GET /api/auth`（本地凭据 + 在线校验，缓存 20s）、
  `POST /api/auth/<site>/login`（在电脑上开独立 Edge，手机只看状态）、设置面板「账号」区显示
  有效/已失效/无凭据；已完成 B站 任务多出「重取字幕/弹幕」按钮，走 `POST /api/jobs/:id/sidecar`
  只重取附属、不重下主文件。实测：三站点状态正确（QQ 的 uin 过期显示已失效）、
  重取后 32/268 且 `.srt` mtime 更新、非 B站 或未完成任务返回 400/409。
  凭据仍只在用户目录，不读日常浏览器。

**M3 · 分发与移动端（有前提）。**

- **N05 · 分发门槛与 doctor**：🟡 部分完成（2026-10-26）——`build_skill_ts.py` 产出
  `manifest.json` + `SHA256SUMS`（已随 zip 打包），`verify_skill_ts.py` 可逐个核对（篡改即失败）；
  `bun ts/src/cli.ts doctor` 只读诊断
  （Bun/ffmpeg/组件/配置/输出目录/三站凭据，fail 才退出码 1）；yt-dlp 安装改为先取官方
  `SHA2-256SUMS` 再校验、把 SHA256 记进配置，`/api/components` 依据记录报 `verified`。
  实测重装 17,880,111 字节、SHA256 `33121d19…`、doctor 显示「已校验」。
  **2026-10-27 收口**：新增 `tools/release_baseline.cjs`（体积基线 `docs/release-baseline.json`，
  exe **91.95 MB** / zip **42.58 MB** / 3 个文件，两次构建漂移 0.0%）与 `docs/RELEASE.md`
  （版本号四处同步、必跑项、CI 手动触发、标签与 Release、回滚）。
  **仍未做**：干净机器验收（需要一台没有 Bun/Python/ffmpeg 的 Windows，这是 N05 唯一缺的硬证据）；
  自动 CI 仍因配额暂停。
- **N06 · Android 真机**：✅ 2026-10-26 在 realme RMX5200 / Android 16 完成壳子验收（安装、连接、解析、下载、预览、取消/重试、错误 token、电脑离线、前后台）；局域网路径未打通（未加防火墙规则）。
- **N07 · Android 独立端（C 路线）**：🟡 **M0 已完成（2026-10-27）**，见 `docs/design/android-standalone-plan.md` §13（决策）与 §2.1（实测）。
  方案：WebView 复用 Vue 界面 + TS 引擎打成 bundle + Kotlin 桥（fs / transfer / crypto）+ 前台下载服务 + Media3 合并。
  M0 实测：引擎 bundle 8.5KB（gzip 4.6KB）、APK 846KB；桥 `paths`/`crypto.md5Hex`/`fs`（16KB 分块 + staging→publish）
  在真机（RMX5200 / Android 16）跑通，落盘 md5 与设备 `md5sum` 一致；局域网模式回归通过。
  已定：minSdk 26、输出 `Download/VDACC`（MediaStore + staging `.part`）、桥用 Kotlin、UI 复用 Vue。
  **M1 已完成（2026-10-29）**：抖音单文件、Vue 产品界面直上端、前台下载/取消/限速/锁屏、
  网易云（端上自写 ID3v2.3 与 FLAC Vorbis comment + 封面，因为端上没有 ffmpeg），全链路有真机证据。
  **M2 已完成（2026-10-30）**：B站 DASH 两轨 + 端上合并（`MediaExtractor`/`MediaMuxer` 纯封装，
  未引入 Media3，理由见 `mobile/android/README.md`）+ 150MB 超限拆轨 + 弹幕落盘（顺带修了桥只解
  gzip 不认 deflate 导致弹幕恒 0 条的问题）；产物与桌面端 `ffmpeg -c copy` 逐帧对拍一致。
  **M3 已完成（2026-10-30）**：酷我 / 酷狗 / QQ 音乐三个引擎上机（共用 `music-common` 公共层：
  Range 探真音频、暂存下载、自写标签/封面、截断判定）；酷狗实测三档全放行、无损 43.6 MB 标签与
  500×500 封面正确，QQ 匿名只放行 128K/96K 并带 `result=104003`，m4a 明确不写标签。
  **M4 已完成（2026-10-30）**：系统分享入口（`text/plain` → `?url=` 深链自动解析）、
  完成通知（publish 之后由 JS 触发，点击回 App）、自选保存目录（SAF 持久授权 + 写失败回退并透出原因）。
  任务历史自 M1-d 起就在 `localStorage`，本期未改动。
  **M5 已完成（2026-10-30）**：被杀后自动续传（次数上限 2）、修 416（`.part` 已完整却被续传拒掉）、
  断网失败归类为 `ENET` 且恢复后重试成功、内存不随文件大小增长；HLS 评估结论为**不移植**
  （桌面靠 ffmpeg，端上缺 playlist 解析 + AES-128 + 跨分片时间戳重排）。
  仍在分支 `feat/android-standalone`（未合并 main）。**下一步 M6** 是「会员认证/付费限制」研究项，
  按 `ReversePlan.md` 需要用户明确授权才能做线上验证，不擅自开工；另一条路是把本分支合并回 main
  并更新根 `README.md` 的 Android 章节（那里还写着「手机只当屏幕」）。
  遗留：专辑批量、端上登录（QQ 320K/无损、B站字幕与 1080P 以上档位因此拿不到，只会如实报
  `need_login`）、「打开文件夹/预览」仍是 `unsupported`、HLS。
- **HarmonyOS NEXT**：仍等待华为开发者账号与 DevEco 签名；独立端方案可复用同一份 JS 引擎 bundle 与桥接口设计。

执行依赖：F01–F07 → N01/N02 → N03/N04；N05 可在稳定源码上独立推进；N06 依赖设备和稳定连接恢复。

**付费限制与 DRM 研究（2026-10-27 决策更新）**：取消此前对付费绕过和 DRM 的项目禁令，允许将付费限制、会员凭证及 DRM 相关机制纳入研究。该方向目前仅为研究意向，尚无经验证的实现或支持承诺；工作步骤、证据与未验证项见 [ReversePlan.md](ReversePlan.md)。DRM、普通加密、付费限制和版权权限分别判断，不可混为一谈。
**QQ 第一批（工作包 1–2）已完成，仅离线验证**：数据流与已知/未知清单见
[`docs/design/qq-capability-baseline.md`](docs/design/qq-capability-baseline.md)；
四档全部进 probe（不可用档带真实 `result` 代码）、全档被拒区分 `filtered`/`need_login`、
显式档位不再静默降级、试听片段不再报完成；测试 101 → 111。线上档位未复测，会员账号未验证。
**网易云第二批同日完成（同样仅离线验证）**：见
[`docs/design/netease-capability-baseline.md`](docs/design/netease-capability-baseline.md)；
两档全量呈现、详情缺失改 `not_found`、显式档位不降级、`incomplete_media`；测试 111 → 120。

**持续边界**：schema=2 兼容；业务仍在 TS 引擎，对外字段集中定义；legacy 冻结。
私密、直播、收藏夹抓取、站点广度竞赛不做。
视频分析、三视图、提示词反推继续暂缓，不列入任何阶段。

#### 2.6.4 UI 设计依据

参考 [infOS S06](https://github.com/YoKONCy/infOS/blob/main/.docs/S06_UI_UX_DESIGN_SPEC.md)：
浅灰画布、白色内容面、粉色主操作、天蓝运行态、少量紫色强调；侧栏 232–256px、
14px 卡片与右侧 Slide-over。正文系统字体、数据等宽；复用 VDACC 的语义令牌，
不复制角色、品牌素材或整套组件。HTML 可离线查看、筛选任务、展开详情、切换主题及打印。

---

## 3. 设计存档（2026-10-19 讨论）

> 以下为当时的架构探讨，部分前提已被 2026-10-21 的实测推翻（见各节批注）。
> 保留它是为了记录「为什么这么设计」，**不要按它排期**。

---

### 3.1 起点：现状盘点

已跑通的部分（抖音）：

```
Playwright 起独立 Edge（channel=msedge，独立 user_data_dir）
  → 打开视频页，浏览器自己算 a_bogus 签名、自己请求 aweme/detail
  → 拦 response 拿 detail JSON（24~30 档清晰度）+ 视频 CDN 地址
  → 按 bit_rate 排序，逐个试下，实际比字节数取最大
  → 用浏览器上下文下载（自动带 cookie + Referer）
```

已验收：能拿 `normal_1080_0` 最高档，无水印，不依赖用户关闭浏览器。
GUI 侧 worker 在子线程调用，已验证线程安全。

> **2026-10-21 更正（推翻本文件多处前提）**：上面这套截流方案本身可用，但"抖音签名只有浏览器算得出"是错的。
> 真正的门是 `x-secsdk-web-signature`（md5 + 硬编码 salt），纯 HTTP 可算；`ttwid` 还能自己注册，
> 所以**无 cookie 也能下**。已实测官方 yt-dlp 2026.08.19 + PR #17826 补丁：无 cookie 拿到 1080×1920 / h264 / 30fps；
> 未打补丁则 403。结论：抖音应从"必须借浏览器的 L3"降级为"纯 HTTP 引擎"，
> 浏览器方案保留作兜底与其它站点用。

**体检发现（关键）**：~~`venv` 与 PATH 都没有 ffmpeg~~ → 2026-10-21 复检，本机 PATH 已有 **ffmpeg n8.1.2**（winget）。
它仍是 B站/YouTube 的硬前提（DASH 音视频分离），但不再是当前阻塞（理由见 AGENTS.md 第二节）。

---

### 3.2 目标拆解

用户提出三件事，复杂度差异极大，建议**按依赖顺序推进，不要并行**：

| # | 目标 | 性质 | 风险 |
|---|---|---|---|
| A | 支持 B站 | 工程，路径清晰 | 低 |
| B | 通用网页视频下载 | 工程，边界要划清 | 中 |
| C | ~~下载后自动分析 → 三视图 / 视频提示词~~ | 半研究性质 | **高 —— 已暂缓** |
| D | 整体封装成 Skill | 形态重构 | 低（但依赖 A-C 稳定） |

**2026-10-21 决策：目标 C 暂不列入开发计划。** 理由：三视图的跨视角一致性、视频生成提示词的可复刻性都还依赖尚未稳定的能力，现在做只能得到"看起来像"的中间产物，投入产出比不成立。等技术成熟（角色一致性可控、视频模型提示词语义稳定）再重启。
设计探讨仍保留在 §3.5，作为将来重启时的输入，**但不要按它开始排期**。

---

### 3.3 目标 A：B站 —— 加"第二个引擎"，不是新写提取器

#### 3.3.1 问题定性（2026-10-21 更正）

抖音的病**不是**"签名算不出来"：签名是 `x-secsdk-web-signature = md5(uifid_timestamp_SALT_query)`，
纯 HTTP 可算，见 §3.1 更正。「必须借浏览器」这条判断不成立。
B站的病是**要不要登录**（WBI 签名 yt-dlp 已经实现）。

两者性质不同，所以 B站不该复刻截流方案。

#### 3.3.2 方案对比

| 方案 | 能拿到 | 代价 | 结论 |
|---|---|---|---|
| A1. yt-dlp 裸跑 | 最高 720P（未登录） | 零成本 | 起步够用 |
| A2. yt-dlp + 自有 profile 导 cookie | 1080P / 部分 4K | 需登录一次 | **推荐主线** |
| A3. Playwright 截 `playurl` 响应 | 同 A2 | 复刻抖音那套 | 冗余，不做 |

#### 3.3.3 核心洞察：三道墙其实可以合法绕开

App-Bound Encryption 挡的是「**从磁盘偷用户的 cookie**」——密钥绑在浏览器进程上，
离线解密必挂。但我们自己起的独立 profile，`context.storage_state()` 拿到的是
**明文 cookie**，因为我们是进程内的合法持有者，不是外部窃取者。

```
在 browser_profile 里扫码登录一次 B站
  → context.storage_state() 导出 → cookies.txt
  → 喂给 yt-dlp --cookies cookies.txt
```

不碰用户浏览器、不用关 Edge、不涉及任何解密。
同一把钥匙以后还能开 YouTube（年龄限制）、小红书、微博。

**结论**：这条路比"再写一个截流器"划算得多，应作为通用凭据方案。

#### 3.3.4 待办

- [ ] 实现 `auth.py`：headful 打开目标站 → 用户手动登录 → 导出 `cookies.txt`
- [ ] B站 engine 接入 yt-dlp，格式选择 `bv*+ba/b`（最高画质优先）
- [ ] 验证 1080P 是否真的拿到（对比 `-F` 列表里的分辨率）

---

### 3.4 目标 B：通用化 —— 分层，别指望一个万能的

#### 3.4.1 三层结构

| 层 | 手段 | 覆盖 | 可靠性 | 备注 |
|---|---|---|---|---|
| L1 | yt-dlp | 1752 站点 | 高 | 社区维护，优先 |
| L2 | 通用嗅探（拦 m3u8/mp4/DASH） | 任意网页 | 中 | 复用抖音那套拦截思路 |
| L3 | 逆向站点签名 | 抖音这类 | 低 | 易失效，逐个加 |

路由原则：**域名命中 L3 → L3；否则先试 L1；L1 报 unsupported → 降级 L2。**

#### 3.4.2 L2 的真正难点（不是"截到地址"）

截到 URL 只是开始，后面的处理才是难点：

1. **m3u8 分片** —— 不要自己拼，把 m3u8 URL 直接交给 ffmpeg 吃
2. **DASH 分离流** —— 要挑 video + audio 两条，再 `-c copy` 合并
3. **候选选优** —— 页面里常有广告流 / 预览流 / 正片流混杂，不能只按字节数排序
4. **流式落盘** —— 现在的 `save()` 用 `resp.body()` 全量进内存，
   1GB 的文件直接爆。必须改成边下边写 + 边算大小

#### 3.4.3 DRM 历史决策（已更新）

历史上将 DRM 排除在范围之外；该决定已于 2026-10-27 取消，现以 §2.6.3 和 `ReversePlan.md` 为准。取消禁令不代表现有实现支持任何 DRM 方案；具体协议、内容和权限须分别验证。

---

### 3.5 目标 C：视频分析 —— 已暂缓（2026-10-21）

> ⚠️ **本节不排期。** 目标 C 已明确暂不列入开发计划，以下内容仅作将来重启时的设计输入。
> 重启前先确认两件事：① 是否有支持图像输入的模型可用（见 §3.9 决策 2 的遗留风险）；
> ② 角色一致性能否达到可用水平（现在只到"参考级"）。

#### 3.5.1 三段式拆解（确定性依次下降）

| 段 | 内容 | 手段 | 确定性 |
|---|---|---|---|
| C1 | 抽帧 + 场景切换检测 + 语音转写 | ffmpeg `scdet` + faster-whisper | **确定，纯工程** |
| C2 | 画面内容理解 | VLM（本地 Qwen-VL 类 7B / 云端多模态 API） | 半确定 |
| C3 | 生成三视图 / 视频提示词 | 文生图 / 提示词工程 | **不确定** |

建议**先做 C1，C2 可做，C3 单独隔离**。别让高不确定性功能拖垮已经很稳的下载工具。

#### 3.5.2 坑一：三视图不能"抽一帧直接生成"

单帧里压根没有背面和侧面的信息，模型只能瞎猜，出来是三张不同的脸。靠谱路径：

```
多帧采样（覆盖不同角度 / 景别）
  → VLM 提炼「角色设定卡」（结构化字段）
     发色 / 发型 / 瞳色 / 体型 / 服装 / 配饰 / 画风 / 年龄段
  → 逐视角独立生成（正面 / 侧面 / 背面，固定 seed + 同一设定卡）
```

**预期管理**：一致性是行业难题。能做到"参考级"三视图，做不到"可直接进 pipeline 的资产级"。
要资产级需上角色 LoRA 或 ControlNet，那是另一个量级的工程。

#### 3.5.3 坑二：反推提示词不是"写一段描述"

视频生成模型吃的是**镜头级**提示词，结构大致：

```
主体 + 动作 + 运镜（推/拉/摇/移/环绕）+ 光线 + 风格 + 时长 + 情绪
```

一条长描述喂给 Seedance 只会得到平庸结果。必须**按镜头切分，一镜一条**。
而且各平台偏好不同（MiniMax 偏自然语言叙事、可灵支持结构化运镜参数），
需要一层「模板适配器」，不能一套提示词打天下。

#### 3.5.4 合规红线

视频里是真实人物时，生成其三视图属肖像权高风险区。
默认走「风格化 / 二次元化」路径，或在 UI 上明确标注用途受限。

---

### 3.6 目标 D：Skill 化 —— 值得做，但不是现在

#### 3.6.1 三个判断

**判断一：现在这套形态和 Skill 要的不是一回事。**
Skill 的消费者是 agent，agent 不会去点 tkinter。它需要的是：

```bash
cli.py "url" --json    # 吐结构化结果
```

GUI 留着给人用，两者共用同一套后端。这正好倒逼把 `download()` 的
log 回调改成「结构化事件 + 可选人类可读日志」。

**判断二：拆两个 Skill，不要合成一个。**

| Skill | 输入 → 输出 | 触发语 | 失败模式 |
|---|---|---|---|
| `video-acquire` | 链接 → mp4 + meta.json | 下载/保存这个视频 | 网络、签名失效 |
| `video-analyze` | 本地视频 → 分析 JSON / 提示词 / 三视图 | 分析这个视频、反推提示词 | 模型幻觉、画质不足 |

合成一个会导致 SKILL.md 臃肿到触发条件模糊。

**判断三：有三个硬约束必须先解决，否则 Skill 不可用。**

1. **profile 单例锁** —— `browser_profile` 被两个进程同时用会崩，必须上文件锁
2. **超时** —— agent 耐心是分钟级。单视频 6~10 秒 + 启动浏览器 3 秒，
   批量 5 个就一分钟。要么"先返回任务 id 再轮询"，要么限制批量
3. **输出契约** —— 日志给人看，agent 要的是：
   ```json
   {"ok": true, "path": "...", "title": "...", "platform": "douyin",
    "quality": "1080p", "bytes": 833706, "error_code": null}
   ```
   错误码要区分：`signature_invalid` / `login_required` / `drm_unsupported` / `network`，
   而不是一句 `Fresh cookies needed`。

---

### 3.7 现有代码的重构点

增量重构即可，GUI 几乎不用动。

| 位置 | 问题 | 改法 |
|---|---|---|
| `dy_dl.py:40` `extract_targets()` | 硬编码 douyin 域名，无抖音链接就退化成抠数字 ID，B站链接会被当无效输入 | 拆成「通用 URL 抽取」+「域名路由」 |
| `dy_dl.py:74` `collect_candidates()` | 写死 `aweme.video.bit_rate` 结构 | 移进 `DouyinEngine` |
| `dy_dl.py:182` `fetch()` | 只认 `/aweme/detail` 响应 | 移进 `DouyinEngine` |
| `dy_dl.py:210` `save()` | `resp.body()` 全量进内存 | 重写为流式落盘 |
| `dy_dl.py:172` `_wait_aweme()` | `time.sleep(0.8)` 轮询 | 改事件等待（`page.wait_for_response`） |
| `dy_dl.py:271` 命名 | `vid_title.mp4` 的 vid 语义绑定抖音 | 换通用 schema |

目标形态：

```python
class Engine:          # 抽象
    def fetch(url) -> MediaInfo
    def download(MediaInfo, dest) -> Path

class DouyinEngine(Engine):   # 现有 Grabber 收编
class YtdlpEngine(Engine):    # B站/YouTube/1752 站点
class SniffEngine(Engine):    # 通用 m3u8 / 直链兜底

def route(url) -> Engine: ...  # 域名 → 引擎
```

---

### 3.8 当年的推进顺序（P0–P5，已完成归档）

| 优先级 | 任务 | 状态 | 验收标准 | 依赖 |
|---|---|---|---|---|
| **P0** | 装 ffmpeg | **完成**（本机 n8.1.2） | `yt-dlp -F` 不再警告 ffmpeg not found | — |
| **P0.5** | 抖音纯 HTTP 签名引擎（`dy_http.py`） | **完成 2026-10-21** | 无 cookie 拿 1080p，浏览器方案降为兜底 | P0 |
| **P1** | 引擎路由重构 + B站跑通 | **完成**（M1 + M5） | B站视频下有声音有画面，1080P | P0 |
| **P2** | 通用兜底 | **完成**：`ytdlp-generic`（R3）+ L2 直链/`m3u8` 嗅探（3.2.0，`ts/src/engines/sniff.ts`；不跑页面 JS、不做 blob/MSE） | 任找一个 yt-dlp 不支持的站点下成功 | P1 |
| ~~P3~~ | ~~分析链路（抽帧 + 转写）~~ | **暂缓 2026-10-21** | — | — |
| ~~P4~~ | ~~生成侧（三视图 / 提示词）~~ | **暂缓 2026-10-21** | — | — |
| **P5** | Skill 化封装（`video-acquire`） | **完成**（M6） | agent 能一句话调通 | P1 |

**P0/P1 是地基**，且能验证"通用化"这个假设成不成立。
P3 之后的每一段都应能独立失败而不影响下载器。

---

### 3.9 当年已决策（2026-10-21）

| # | 决策 | 影响 |
|---|---|---|
| 1 | **ffmpeg：优先便携版**，`ffmpeg.exe` + `ffprobe.exe` 放 `venv\Scripts\`；找不到再回落系统 PATH | 运行时查找顺序以 `legacy/python/vdl/core/env.py` 为准：`venv\Scripts` → `PATH` → 报 `ffmpeg_missing`；TS 侧认 `VDL_FFMPEG` 或 PATH。二进制不入库（venv 已 gitignore）。**本机现状（2026-10-23 实装）**：`winget install Gyan.FFmpeg` → **ffmpeg/ffprobe 9.0.2-full_build**，shim 在 `%LOCALAPPDATA%\Microsoft\WinGet\Links`（在用户 PATH）。功能等同，但不符合"不污染系统"的初衷；换机时按便携版放进 `venv\Scripts\` 即符合决策 |
| 2 | ~~分析侧走云端 API（DeepSeek key）~~ **暂缓（2026-10-21）** | 目标 C 整体暂缓，本决策随之搁置。原遗留风险仍未验证：DeepSeek 公开 API 是否支持**图像输入**。重启时第一步先验模型能力，再决定云端 VLM（Qwen-VL / GLM-4V / Gemini）或本地方案 |
| 3 | **B站 V1 就登录** | `vdl auth bilibili`：独立 profile 扫码 → `storage_state()` 导出 cookie → yt-dlp 用。不登录只到 720P |
| 4 | GUI 壳 = **本地 Web UI**（`vdl serve`），tkinter 仅过渡 | 端口固定 `8765` + 一次性 token；SSE 推进度 |
| 5 | 音乐默认 **lossless**，拿不到时如实降级并标注 | 单曲体积大，UI 必须先显示真实大小 |
| 6 | infOS **暂不集成**，UI 风格向它靠 | 等作者确认要不要子应用；我们的 `vdl serve` 已为其预留对接点 |

---

## 4. 变更记录

- 2026-10-27：根据用户后续决策取消 DRM 的原项目禁令，将 DRM 纳入研究，细节见 `ReversePlan.md`；该决策不代表已实现或验证。
- 2026-10-27：根据用户决策取消「付费绕过」的原项目禁令，将付费限制与会员凭证列为研究方向，细节见 `ReversePlan.md`。当时的 DRM 禁令已由上条更新取消。
- 2026-10-19：初版。完成架构探讨，建立 git 版本管理，确定 P0-P5 顺序与三项待决策。
- 2026-10-21：更正抖音签名结论（`a_bogus` → `x-secsdk-web-signature`）。实测 PR #17826 补丁在官方 yt-dlp 2026.08.19 上干净应用，无 cookie 下 1080×1920 / 30fps；未打补丁仍 403。追加 P0.5，浏览器方案降级为兜底，并新增 B站/多平台的纯 HTTP 方向判断。
- 2026-10-21：**P0.5 完成**。新增 `dy_http.py`（标准库实现 ttwid 自注册 + uifid 兜底 + MD5 签名 + `aid=6383` + 流式落盘），`dy_dl.download()` 改为 `engine=auto|http|browser`，默认 HTTP 优先、失败回退浏览器。实测：与 yt-dlp 补丁版产出**字节数完全一致**（6,281,768），1080×1920/30fps，冷启动 1.15 秒/条；系统 Python（无 playwright）可直接运行。
- 2026-10-21：**形态决策**。① GUI 壳选「本地 Web UI」（core 起 HTTP + 单页），tkinter 仅保留为过渡；② 音乐只做网易云，且必须走 `vdl auth` 自有 profile 扫码导出的 cookie（M4 实测：免签名的 player/url 接口即可，不需要 eapi 加密），外层直链只覆盖免费曲；③ infOS 当前**没有运行时插件机制**（wiki 的 MOD 文档对应旧 Python 架构，TS 重构 5c760e9 已移除），集成只能走「薄 Vue 页面 + 本地 HTTP 服务」；④ UI 参考见 `docs/design/ui-reference.md`。
- 2026-10-21：**参数与基线落定**。ffmpeg 用便携版；分析侧云端（DeepSeek key，图像输入能力待确认）；B站 V1 登录；端口 8765 + token；音乐默认 lossless；infOS 暂不集成。用 REA 对 `remote-client-prototype` 抓了视觉参照基线（`docs/design/screenshots/prototype-baseline-1440x900.png`，1440×900 / reduced-motion）。角色资产经 infOS 作者口头许可使用，仅出现在空态/解析中/完成三处，后续可替换为自有角色。
- 2026-10-21：**M1 完成（core 契约层）**。新增 `vdl/` 包：`core/models.py`（Media/Format/ProbeResult/DownloadResult）、`core/errors.py`（可指导下一步的错误码表）、`core/router.py`、`engines/{base,douyin,pending}.py`、`cli.py`。`python -m vdl probe|get|doctor --json` 全部跑通：抖音 4 个 bit_rate 折叠为 3 档（1080/720/540），体积取自 `play_addr.data_size`，带水印档不进列表；B站/网易云返回 `not_implemented` 而不是"下载失败"；`dy_dl.py` 行为未变（回归通过）。
- 2026-10-21：**M2 完成（本地服务 + 可用 Web 界面）**。`vdl serve`：固定 8765 + 随机 token、`/api/probe`、`/api/jobs`（单 worker 串行）、`/api/events`（SSE）、`/api/reveal`（路径 jail）、静态页；安全三件套实测（无 token 401 / 伪造 Origin 403 / 越界 reveal 400）。`dy_http` 下载加入 `progress(written,total)` 回调（0.2s 节流），SSE 实测收到 running→done 事件。界面为 M3 的设计稿打底（token 取自 infOS `ui-tokens.css`），已用 Edge headless 截图核对布局。
- 2026-10-21：**M2.5 完成（扫码登录）**。`vdl auth <site>`：独立 profile（`%LOCALAPPDATA%\vdl\profile`）+ msedge headful，轮询 cookie 判定成功，`storage_state()` 导出 `auth/<site>.json`，同时转 Netscape `<site>.cookies.txt` 供 yt-dlp。实测 B站 27 cookie（SESSDATA + DedeUserID）、网易云 20 cookie（MUSIC_U）；凭据不打印值、不入库。
- 2026-10-21：**M3 完成（界面按设计稿重做）**。画质 chips（带真实体积，与勾选双向同步）、素材多选、`/api/preview` 同源直链预览、批量提交（`formatIds`）、空态/完成态角色、深链 `?url=` 自动解析。角色素材取自 infOS（缩放到 420px 高，仅空态与完成态使用），来源与授权写进 `THIRD_PARTY.md`。实机 E2E：勾选 1080P+720P → 两个任务完成 → 两个文件并存；截图归档 `docs/design/screenshots/vdl-web-m3.png`。修了 `.preview` 类名冲突（dialog 的宽度泄漏到按钮）。
- 2026-10-21：**M4 完成（网易云引擎）**。实测确认**不需要 eapi/weapi 加密**：`GET /api/song/enhance/player/url?ids=[id]&br=999000` 带 `MUSIC_U` 直接返回 `level=lossless` 的 FLAC，无 cookie 对免费曲返回 320K。新增 `engines/netease.py`（详情/歌词/播放地址均免签），落盘用 ffmpeg 写 title/artist/album/年份 + 800px JPEG 封面（原图 1920² PNG 有 5.25MB，直接内嵌会撑大三成），歌词另存 `.lrc`。两个"数字不真实"的问题顺手修掉：`size` 以 CDN 的 `Content-Length` 为准、年份用时间戳换算（原先截成 `1388`）。实测：FLAC 18.18MB / 736kbps、320K MP3 7.97MB，封面 800×800。
- 2026-10-21：**M5 完成（B站引擎）**。`engines/bilibili.py`：yt-dlp 解析（cookie 来自 `vdl auth bilibili`），按**宽度**归档清晰度（宽银幕 1920×816 / 4096×1740 按高度会整体下移一档，实测踩到并修正），同档位优先 H.264，音视频成对合并，两条流的进度按文件名累计后聚合成单条进度。实测 5 档（4K/1080P/720P/480P/标清）；720P 31.2MB 4.5 秒完成，产物 h264+aac、206.5s；服务端任务 480P 21.15MB `done`。`server.py` 的百分比加了 99.9 上限（`filesize_approx` 可能偏小）。
- 2026-10-21：**M6 完成（Skill 打包）**。`skill/SKILL.md`（frontmatter + 前置检查 + 契约 + 错误码→下一步 + 时间预期 + 红线）、`skill/references/engines.md`（三站点差异与失效模式）、`skill/scripts/vdl_run.py`（入口，调整 sys.path 以找到 `dy_http`）、`tools/build_skill.py`（校验 frontmatter → 组装 `dist/video-acquire` → 可选 zip）。产物 23 文件 / 89.8KB / zip 41.8KB，刻意排除 `vdl/web` 与 `vdl/server.py`（Agent 不需要，且含授权受限插画；Skill 版 `serve` 会明确拒绝并 exit 2）。实测：包内 `doctor` 全绿；抖音/网易云/B站（含裸 BV 号）三引擎解析正常；包内下载抖音 1080P 成功。
- 2026-10-21：**R1 完成（测试与验收）**。`tests/` 25 个用例（路由/B站宽度归档/命名/错误码/序列化 + 服务端 token/Origin/路径越界/静态页 + 任务持久化），`make_server()` 构造与启动分离；版本号统一 0.3.0；`doctor` 改回只读（不再创建下载目录）；新增 `tools/accept_ui.py`（等**最新**任务完成，避免被上一条已完成任务骗过）。界面验收：网易云 18.18MB FLAC、B站 480P 21.15MB 均在 UI 内完成。
- 2026-10-21：**R2 完成（可交付）**。`vdl/core/config.py`（`%LOCALAPPDATA%\vdl\config.json`，`vdl config --set`）；任务历史落盘 `jobs.json`（最近 100 条，`running` 重启后标 `interrupted`）；`doctor --fix` 只补 pip 依赖（ffmpeg 不自动下载）；`VDACC.bat` 一键启动；`.github/workflows/ci.yml`（unittest + Skill 构建校验）。legacy `dy_dl.py`/`dy_gui.pyw` 冻结：不迁移 tkinter（浏览器兜底不在 vdl 里），新能力只加 vdl。（v2 时代口径；3.0 起 `vdl/` 已冻结并归档到 `legacy/python/vdl/`，新能力只加 `ts/`）
- 2026-10-21：**R3 完成（通用兜底）**。抽出 `engines/_ytdlp.py`：档位折叠（按宽度）、音视频成对合并、两条流进度聚合只写一处；`bilibili.py` 瘦身为 50 行薄封装（保留 `bili-*` 档位 id）；新增 `engines/generic.py`（`ytdlp-generic`，任意 http(s) 链接兜底，失败返回 yt-dlp 原始报错并清洗 `ERROR:` 前缀）。路由顺序固定为「专用引擎 → 通用兜底」。测试 26 个全绿。**分P 与字幕 sidecar 推迟**：前者要改契约（`parts[]`），后者价值低，留到有真实需求时做。
- 2026-10-21：**R4 完成（局域网与宿主接入）**。`vdl serve --lan` 绑 `0.0.0.0` 并打印局域网地址与风险提示；新增 `--allow-origin`（可重复）与配置里的 `allowedOrigins`；新增 `/api/files/<jobId>` 流式回传（仅 done 任务、仅输出目录内）；Web UI 的完成任务多一个「下载」按钮；`integrations/infos/` 提供薄页面参考（Vue 3 SFC + 接入说明），不改 infOS 仓库。测试 28 个。
- 2026-10-21：**R5 完成（1.0.0）**。补齐 Apache-2.0 `LICENSE`（官方原文）、`NOTICE`（infOS 角色素材、yt-dlp、FFmpeg、MediaGrabber 参考范围）、`docs/ROADMAP.md`、`docs/RELEASE-1.0.0.md`；版本号统一 1.0.0；构建 `dist/video-acquire.zip` 作为 Release 资产。
- 2026-10-21：**v1.1 完成（可靠性）**。`core/download.py` 与 `dy_http` 支持 Range 续传（`.part` + 记录来源 URL 的 sidecar，避免换候选拼错文件）、网络/5xx 自动重试 3 次；任务支持取消（`cancelled` 状态，保留 `.part`）与重试（新建任务）；`serve --concurrency 1~4`；`doctor --live` 三站点真解析（实测 531/436/1875ms）、`--bundle` 脱敏诊断包。实测：B站 480P 取消于 39.8%，重试后完成；并发下抖音+网易云同时下载完成。
- 2026-10-21：**目标 C 暂缓，路线收口**。视频分析 / 三视图 / 提示词反推暂不列入开发计划，等角色一致性与视频模型提示词语义稳定后再重启（§3.2、§3.5 已标注）。同步清掉两处文档不一致：① ffmpeg 决策改为「优先便携版、回退 PATH」并如实记录本机是 winget 装在 PATH 上；② 分析侧模型决策随目标 C 一并搁置，DeepSeek 图像输入能力仍未验证。§3.8 补齐 P0–P5 的实际完成状态（P2 只做了通用兜底，L2 嗅探未做）。
- 2026-10-22：**v1.2 完成（内容完整性）**。契约升到 `schema=2`（新增 `media.parts[]` 与 `formats[].subtitles[]`，均为新增字段）。B站 多P/合集：用公开 pagelist 接口取分P，`?p=N` 选中并只解析该分P（实测 BV1SknF6KE5g 四P，P1 145MB / P2 89MB，selected 正确）；UI 加分P下拉。字幕：`--subs` 落同名 `.srt`（中文优先），覆盖 to_srt 单测；**实测边界**：排行榜前 12 个视频均无 CC，端到端只验证到「无字幕时静默跳过」，有 CC 的真实样本待补。弹幕 XML 与音乐专辑批量延期到 1.2.x/1.3。测试 33 个。
- 2026-10-22：**v1.3 完成（入口）**。① PWA：manifest + service worker（只缓存外壳、不缓存 /api）+ 192/512 图标；token 首次带参数打开后存 localStorage，从桌面图标启动无需再带 token（实测 manifest/sw/icon 的 MIME 均正确）。② Chrome/Edge 扩展（MV3）：右键转发链接到本机，只做导航打开、不 fetch，因此不需要 host 权限与 Origin 白名单。③ 便携包 `tools/build_portable.py`（40 文件 / 481KB，zip 368KB，不打包 Python 本体避免杀软误报）。i18n 延期：当前 UI 仅中文，抽词条要动全部模板，收益低于入口建设。
- 2026-10-22：**v2.0 完成（跨端入口）**。手机首次打开无 token 时显示「连接本机 VDACC」输入框，token 存 localStorage，之后可直接从快捷方式进入（实测 390×844：门禁可见 → 输入 token → 主界面加载）。移动布局复核通过（任务卡、取消/重试、完成提示均正常）。**原生壳未构建**：本机无 JDK / Android SDK / DevEco，不提供安装包；Android(Capacitor)/Harmony(ArkWeb) 的构建前提与「端上只跑纯 HTTP 引擎、B站必须遥控」的边界写进 `integrations/mobile/README.md`。
- 2026-10-22：**v2.1 完成（附属文件）**。新增 `core/sidecar.py`：`--cover` 把封面存成同名图片（按 Content-Type 定 .jpg/.png/.webp），B站 与抖音共用同一实现；`--subs` 与 `--cover` 都遵守「附属文件失败不影响视频」。Web 界面在下载按钮旁增加「封面」勾选框（有缩略图时显示）。补 `tests/test_sidecar.py`：用本地 HTTP 桩端到端验证「取字幕 JSON → 转 SRT → 写同名文件」与封面落盘，补上 v1.2 遗留的字幕未验证缺口。实测：抖音封面 438×330、B站 480P 封面 1600×900 均正确落盘；测试 33 → 37。
- 2026-10-22：**文档收口**。① 顶部状态行从「v2.1.0 已发布，下一步 spike」更新为「3.0.0 已发布，3.1 开发中」——TS 早已转主线，旧描述会误导；② 章节编号重排：原「§3 版本路线 / §4 设计存档」与存档内部的 §0–§9 编号冲突且乱序，现统一为 §1 文档地图、§2 版本路线（2.1–2.5）、§3 设计存档（3.1–3.9，原 §0–§9 整体下沉一级）、§4 变更记录，并同步修正 9 处交叉引用；③ §2.2 由过期的 v2.2–v2.9 排期改为 TS 主线后续计划（P0 运行时收口 / P1 功能补齐 / P2 体验 / P3 可选），因为原表里的设置、Vue、i18n、批量、番剧、限速、打包都已完成。
