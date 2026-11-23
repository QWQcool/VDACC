# Plan.md —— 计划、架构与决策（唯一计划来源）

> 状态：**3.8.0 已定版**（2026-11-23；MCP 可编单文件、粗剪清单、可选本地 ASR）。后端主线为 TypeScript（Bun），
> Python 冻结并归档在 `legacy/python/`。硬性约束见 `AGENTS.md`，使用说明见 `README.md`，
> 逐版本历史见 `docs/CHANGELOG.md`，完成盘点见 §2.2，后续执行计划见 §2.6。
> 已收口的长章节按 `docs/archive/` 归档（见 §1 文档地图），主计划只留未完成项与决策。

## 1. 文档地图

| 想知道 | 看哪里 |
|---|---|
| 接下来做什么、为什么 | **本文**（§2 版本路线） |
| 每个版本改了什么 | `docs/CHANGELOG.md` |
| 不能违反的红线、已验证事实 | `AGENTS.md` |
| 怎么用（安装、命令、界面） | `README.md` |
| 怎么发版（检查清单、体积基线） | `docs/RELEASE.md`（基线数字在 `docs/release-baseline.json`） |
| 给其它 Agent 的契约 | **`ts/src/mcp.ts`（MCP，stdio；工具 probe / get / album / jobs）**；2026-11-23 起不再维护 SKILL.md（legacy 归档里仍有一份） |
| UI 参考、视觉基线、概念图 | `docs/design/` |
| 已收口的长章节（不再维护，只作结论来源） | `docs/archive/`：`plan-2026-11-bilibili-experience.md` = §2.7–2.8；`plan-version-history-2026-10.md` = §2.1–2.3；`plan-design-2026-10.md` = §3 |
| 第三方来源与授权 | `NOTICE` / `THIRD_PARTY.md` |

---

## 2. 版本路线

### 2.1–2.3 已归档：历史版本与 TS 可行性验证

> 3.0–3.3 的完成盘点、`spike/ts-core` 的可行性验证已整体下沉到
> [`docs/archive/plan-version-history-2026-10.md`](docs/archive/plan-version-history-2026-10.md)。
> 逐版本改了什么看 `docs/CHANGELOG.md`；这里只留「当前还没做什么」。

### 2.4 解冻状态与明确不做

**解冻后又冻结（2026-11-02）**：视频风格分析与提示词反推方向成立、计划已写（
[`docs/style-transfer-plan.md`](docs/style-transfer-plan.md)，A0–A5 约 6 个工作日），
但当天实测确认**拿不到 H3 运行通道**——本机 RTX 3080 只有 10 GB 显存，够跑 480–512p 的无声小模型，
而 H3 是 768P / 4–15 s / 原生音频同一次推理，差一个数量级；小模型也不能替它验收提示词。
于是 A0 第三项与 A5 无法关闭，**A0–A5 整体暂停**。重启条件写在计划文档 §0.1
（租几小时 24–48 GB 卡 / 官方额度 / 或收窄成纯分析的 A1）。
**人物三视图**另有一条独立结论：不排期（跨视角一致性不够）。

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
| 3.5.0 | **Android 独立端**（M0–M6：本地引擎、抖音/网易云/B站/酷我/酷狗/QQ、原生流式下载与续传、DASH 合并、写标签、分享入口、完成通知、自选目录、端上登录）+ 网易云真无损判据 + 端上三个真 bug 修复（tag `v3.5.0`，2026-11-02） |
| 3.7.0 | **登录态真实能力 + 体验补齐**：三站会员矩阵重核（B站 4K/Hi-Res、网易云无损、QQ `104003` 语义化）、B站合集分页修复（接口忽略 `pn/ps`，改本地切片）、B站「系列」明确不支持、A3 风格卡进界面、运镜勾选框、CLI 未知参数告警、酷狗批量文件名修正、Android 端补酷狗歌单/专辑并恢复构建链（APK 1.05MB，雷电装上启动）、CI 恢复自动触发（tag `v3.7.0`） |
| 3.6.0 | **发版收口**：`scripts/setup.ps1`（装 Bun 1.4.4 + ffmpeg → 依赖 → doctor，不依赖 winget）、`engines.bun`、版本号四处一致性用例、发布基线按 3.6.0 重算（exe 110.0 MB / zip 52.2 MB）；把 v3.5.0 之后 32 个提交的功能一并写进 CHANGELOG（tag `v3.6.0`） |
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
  exe **91.95 MB** / zip **42.58 MB** / 3 个文件，两次构建漂移 0.0%；**2026-11-16 按 3.6.0 重算**：
  exe **110.0 MB** / zip **52.2 MB**，增量来自新增引擎与界面）与 `docs/RELEASE.md`
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
  **已合并回 `main`**（2026-10-30，快进 14 个提交 + 根 `README.md` 的 Android 章节更到现状）。
  **端上登录已完成并真机验收（2026-10-30 晚）**：独立 WebView 登录、cookie 不出原生
  （`http.request` / `transfer.start` 按域名自动补 `Cookie`），设置面板复用桌面端 `/api/auth`。
  登录后手机端 `BV1SknF6KE5g` 到 **1080P 119 MB**、网易云黑胶曲拿到**无损 FLAC 34.42 MB**
  （落盘 36,097,193 字节、901 kbps、解码通过）。随之修掉三个真 bug：漏 import 导致的
  「点解析无反应」、`head.truncated` 误判让整曲 FLAC 不写标签、四档串行导致解析十几秒。
  **M6 重新定义为「经授权的权益核对」并已做 B站/网易云**（2026-10-30）：用用户本人大会员 / 黑胶账号，
  记录平台实际放行什么——B站番剧 会员 16 轨 / 最大 1440 宽 vs 匿名 6 轨 / 640 宽，
  网易云 VIP 曲 `type=flac`（901K~1656K）vs 匿名 `code=-110`；同时确认「有会员 ≠ 该曲可下」
  （`id=186016` 会员态仍 `code=404`）。矩阵见 `docs/design/member-capability-baseline.md`。
  **不做**凭证伪造、cookie 盗用、DRM 破解或付费墙绕过。
  遗留：HLS（已定不移植）；专辑批量、QQ 登录通道、「打开文件夹/预览」三项已于 N08（2026-11-06）补齐，见下。
  B站 字幕与 1080P 以上档位并不是遗留——cookie 一直带得到，10-30 已真机验收过登录后 1080P。
- **HarmonyOS NEXT**：仍等待华为开发者账号与 DevEco 签名；独立端方案可复用同一份 JS 引擎 bundle 与桥接口设计。

**M4 · 2026-11-06 收尾（B/C/D 三条）**

- **N08 · 端上二期（专辑 / QQ 登录通道 / 打开预览）**：✅ 完成（真机 realme RMX5200 验收）。
  ①专辑：引擎补 `albumTracks`（网易云 / QQ）+ `entry.albumAny` 复用 `core/album.ts` 的 `planAlbum`，
  `local-api` 加 `POST /api/album`，界面零改动（`web/vue` 本来就有「加载下一批」）；
  实测《叶惠美》11/11、`offset=10` 只回 1 首。②QQ：`Auth.kt` 增站点（`qm_keyst`，校验按 cookie 现拼
  `musicu.fcg`），`headerFor` 只给 `y/u/c.y.qq.com` 补 Cookie（不按 `qq.com` 后缀，避免发给 CDN），
  新增只读桥方法 `auth.uin`，vkey 不再固定 `uin=0`；**`comm.authst` 刻意不发**（等于把 cookie 交给 JS），
  所以「登录后 320K 是否放行」仍**待真实账号验证**，未验证前文案不承诺。③打开/预览：新增
  `bridge/Open.kt`（路径 → `content://`：直认 / MediaStore / SAF），桥方法 `ui.reveal` / `ui.preview`；
  手机没有「在文件夹中显示」，`reveal` 语义改为「用系统默认应用打开」，端上文案由 `build-ui.mjs`
  改写成「打开」。预览地址改由 API 给（桌面新增 `POST /api/preview-url`，端上回 `content://`）。
  实测 `<video>` 载入 `content://` `readyState=4 / duration=42.03s`，「打开」跳到系统播放器。
- **N09 · 番剧 4K 选流与 yt-dlp 对齐**：✅ 完成。根因不是参数没给全——`fnval ∈ {4048,12240,16336,20464}`
  × `qn ∈ {0,120,125,126,127}` × v1/v2、以及签过 wbi 的 `/x/player/wbi/playurl` 全部试过，
  API 最高只给 `id=120`（4K 5978k）；yt-dlp 多出来的那档是**页面 SSR `playurlSSRData` 里的 `id=122`**
  （avc1 8554k / hvc1 5968k），它本来就先读 SSR。现在番剧探测多读一次页面，按括号配平取出 SSR 的
  `dash.video`，与 API 结果按 `id+codecs+bandwidth` 去重合并后**再折叠**；解析失败静默退回 API。
  实测 `ep397051`：4K 从 1.09 GB/6155k 变成 **1.52 GB/8731k**，地址实为 `…-100198.m4s`，
  `Range: bytes=0-1023` 回 `206` 且 `content-range /1517239746`（与 yt-dlp 的 1.41 GiB 完全一致）。
- **N10 · 目标 C 收窄为 A1（纯分析）**：✅ 落地（`ts/src/analyze/` + `cli analyze`）。
  只做确定性部分：`ffmpeg scdet` 切分镜、每镜中点抽帧（<30s→30 帧、>10min→100 帧，均写在
  `frames.ts`）、帧亮度用同一次 ffmpeg 的 16×16 灰度算、台词优先读同名 `.srt`/`.lrc`（没有就说没有，
  **不跑语音识别**）、指标只报 ffprobe 直算值。产物 `下载/_analysis/<文件名>/{result.json,frame-*.jpg}`。
  实测 122.5s / 1080P 的 MV：47 段分镜、41 张帧、10.9 s 跑完；单测 19 项（含真 ffmpeg 的 3 秒测试片）。
  **仍然冻结**：A2 逐镜描述、A3 风格卡、A4/A5 H3 提示词与评估——它们要 H3 通道才能验收，
  见 `docs/style-transfer-plan.md` §0.1。

- **N11 · 桌面分析面板（把 A1 接进 Web UI）**：✅ 2026-11-09。此前 A1 只有 CLI，用户实际用不到。
  服务端新增 `POST /api/analyze`（路径 jail 与 `/api/preview` 同一套，产物强制落
  `<输出目录>/_analysis/<文件名>/`——默认落 cwd 会让自定义 outDir 的帧落在 jail 之外、图全裂）；
  `/api/health` 增 `capabilities.analyze`，缺 ffmpeg 与本机之外的端上一律不显示入口。
  界面：已完成**视频**任务卡加「分析」，面板给分镜（起止/亮度）、帧缩略图、逐镜台词、ffprobe 指标；
  点帧/分镜跳预览对应时刻（`loadedmetadata` 时才写 `currentTime`，早写会被浏览器丢掉）。
  浮层管理扩成三层（预览 > 分析 > 设置），Esc 逐层关，关上层后焦点回下层。
  真浏览器验收：47 段 / 41 帧、帧图 `naturalWidth=1920`、点第 3 帧 `currentTime=6.1s`
  （时长 122.5s）、`pageErrors` 为空、Esc 后分析面板仍在。
  **验收抓到真 bug**：同一成品分析第二次，帧文件已存在 → ffmpeg 在 stdin 等「是否覆盖」→
  退出码非 0、stdout 空 → 亮度全 null，而图片还是上一次的（看起来正常）。已加 `-y` 并补回归用例。

- **N12 · B站 字幕串号（用户报「每次下到的字幕都是错的」）**：✅ 2026-11-09 修。
  根因是**接口**不是选轨：未签名的 `/x/player/v2` 对同一稿件会概率性返回**别的稿件**的字幕
  （207s 的 MV 连问 5 次：1 条 278 行跨 746s、0 条、720 行跨 1606s、0 条、675 行跨 1337s；
  另见 3018 行跨 10109s）。改走网页播放器同款 **wbi 签名 `/x/player/wbi/v2`**（aid+cid / ep_id，
  密钥从 `nav` 的 `wbi_img` 拼、按固定表打散取 32 位、缓存 30 分钟）。
  加两道闸门：①人工轨优先于 `ai-*`；②落盘前校验时间轴跨度 ≈ 片长（容许 max(8s,2%)、且 ≥60s 的片子
  不能只盖前一半），不通过就**不写文件**并报「平台返回的字幕与本视频对不上：…s vs …s」。
  AI 轨额外提示「可能与音频不完全一致」。实测：`BV1UB4v67Exr` 62 行（跨度 184s/片长 188s）；
  `BV1j5nj68E48`（K/DA MV）从未签名的「600 行别人的字幕」变成「没有可用字幕」。

- **N13 · A2 逐镜语义描述（DeepSeek 视觉）**：✅ 2026-11-09。A0 第一项（VLM 连通性）实测通过：
  账号可用模型两个，只有 `deepseek-flash` 支持图像输入（`input_modalities: text+image`）。
  实现 `analyze --describe [--max-describe N]`：逐帧串行调模型，产出 7 字段
  （景别/主体/动作/场景/光线/构图/画面文字），写进 `result.json` 的 `scenes[].visual` 与 `describe` 汇总
  （model / shots / failed / tokens）。提示词要求只写看得见的、不确定留空、不推测剧情、忽略平台角标水印；
  全字段留空按失败处理（不伪造内容）。默认关闭（花额度），API 侧 `POST /api/analyze {describe:true}` 同样可用。
  **实测 3 镜**：3/3 成功、6792 tokens；字段与画面逐一核对一致，连画面左下角小徽章上的韩文
  「남자 417」都读对了（不是编的，已对照原帧确认）。成本 ≈ 2.2k tokens/镜。
  **踩坑**：该模型是推理模型，`max_tokens` 同时覆盖 reasoning 与答案——500 预算会被推理吃光
  （`finish_reason=length`、content 空），半截 JSON 也会解析失败。现在固定 `reasoning_effort: low`、
  默认 1200 预算，并在 `finish_reason=length` 时自动加倍重试一次（上限 4000）。
  **已完成（2026-11-17）**：界面「语义描述」的确认区里有「同时判断运镜」勾选框——运镜是模型字段
  （要抽首尾帧喂给 `deepseek-flash`），所以不能做成独立按钮，只能跟着描述一起要；
  勾上后 `POST /api/analyze` 带 `pairFrames:true`。实测 58 镜 / 54 pairs / 3 镜描述 → 3 镜 `camera=固定`。
  A3 风格卡与 A4/A5 仍等 H3 通道。

- **N14 · 语义描述进界面 +「不花额度」的描述来源**：✅ 2026-11-09。分析面板逐镜显示 7 个描述字段，
  并加「语义描述」动作（内联确认 + 预估 token，不用原生弹窗；缺 key 时后端自动跳过）。
  同时补 `analyze --visuals <json>`：Agent / 人逐帧看完写好的描述走同一契约并入 `scenes[].visual`，
  `describe.source` 区分 `model` / `file` / `mixed`，三种文件形状（镜号键 / 数组 / `{scenes:[]}`）都吃，
  字段按白名单收窄、全空记录不算「描述过」。合并结果写 `<输出目录>/_analysis/<文件名>/visuals.json` 快照——
  否则界面里再点一次「分析」会重写 `result.json` 并把描述冲掉（踩过）。
  **B 项实测**：41 张帧由 Agent 直接读图（不调 API、0 token）写完，`--visuals` 合并成 41/47 镜
  （6 个镜没有抽样帧，如实留空），界面重开两次仍在。真浏览器验收：`.an-visual` 41 条、
  镜 1「中景 · 两名女性 Coser…」、镜 3「…「남자 417」」、`pageErrors` 空。

- **N15 · 运镜（对照 H3 提示词字段的第一块缺口）**：✅ 2026-11-09。`--pair-frames` 每镜补一张
  「首帧|尾帧」并排图（两头各内缩 8%、至少 120ms 避开转场），描述字段新增 `camera`
  （固定/推/拉/摇/移/升降/环绕/手持）。面板显示「运镜 xxx」。
  合并逻辑改为**字段级叠加**：camera-only 文件不再清空 subject 等字段（先合并 7 字段再合并运镜时踩到，
  已留回归用例）。
  实测 41 镜的分布：固定 12 / 推 7 / 拉 8 / 移 9 / 环绕 2 / 多机位 1（镜 46 时长 9.3s，
  内含疑似切换但 scdet 未切开——这是分镜精度问题，已记录）。
  **边界**：两帧对比分不出「慢推」与「主体走近」，拿不准写「固定」；真正的运镜判定需要光流或 3 帧以上。
  剩余缺口是**声音**（`overall_soundscape` / `non_diegetic_music`），见 `docs/style-transfer-plan.md` §4.1。

- **N16 · 声音客观量（H3 提示词的第二块缺口）**：✅ 2026-11-09。`ts/src/analyze/audio.ts` 用
  ffmpeg `ebur128` 一次解码拿到：整片积分响度、LRA、真峰值、100ms 包络（下采样 ≤600 点）、
  静音段（≤-50 LUFS 且 ≥300ms）、每镜平均响度。默认开启（`--no-audio` 关），接口传 `audio:false`。
  分镜行显示「音量 -xx.x」，指标行显示「-18.2 LUFS · 静音 0.2%」。
  **边界（重要）**：只报测得出来的数字，**不判「对白/音乐/环境声」**——那需要频谱或 ASR，
  光看音量会编。`overall_soundscape` / `non_diegetic_music` 的措辞仍要人来写。
  实测：本片 -18.2 LUFS / LRA 3.3 / 真峰 -6.2 dBFS / 静音 0.2%，分析耗时 10.9s → 13.5s。
  坑：ebur128 的逐帧数值只打在 `-loglevel info` 里（惯用的 `error` 一行都拿不到）；
  汇总解析必须先剔掉带 `TARGET:` 的逐帧行，否则会把最后 100ms 的积分值当成整片值（-25 vs -18.2）。

- **N17 · A3 风格卡（只做「可读的卡」）**：✅ 2026-11-09。`analyze --style-card` 产出
  `style-card.md` + `style-card.json`：节奏（镜数/平均/中位/最短/最长/每分钟切点）、景别与运镜分布
  （运镜按主类归并，否则「拉 / 拉（轻微）/ 拉（大幅拉远）」会被算成三类）、亮度均值与偏暗偏亮计数、
  实测响度、描述高频词（标注为词频统计）、覆盖度。
  **明确不产出成品 H3 提示词**（4–15s 拼接与 soundscape 措辞需人写，且 A5 无法验证），
  卡尾固定列出三条边界。实测本片：47 镜 / 2.61s 均长 / 23 次切每分；运镜 固定 12 / 移 10 / 推 8 / 拉 8 / 环绕 2 / 多机位 1。
  单测覆盖节奏、归并、降级（无描述/无音轨时写「无法统计」而不是 0）。

- **N18 · infOS Package（Phase 1）**：✅ 2026-11-09 骨架落地。按 `.docs/A06_EXTENSION_SYSTEM.md`
  的 Manifest V2 写了 `integrations/infos/package/`：`skill` ×1 + `tool` ×3
  （`vdl_probe` / `vdl_get` / `vdl_jobs`），`createContribution(host)` 形态、返回 JSON 字符串、
  token 只从 `host.dataDirectory/config.json` 读。零依赖、纯 `.mjs`。
  验证分两层：①仓库内静态契约测试（manifest 字段、允许的 kind、entry 不出包、无 `node_modules`、
  体积 < 20 MiB、`definition` 形状）；②对真实本机服务的冒烟——解析「孤勇者」得 3 档、
  真下到 `done`（53.7 MB，验完删除）、错误档位异步 `no_stream`、缺 token 给出带路径的提示。
  **真实宿主验证已完成（2026-11-11，`D:\infOS` 的 `@infos/backend` 0.9.12，127.0.0.1:9120）**：
  ZIP（9,868 字节，根含 `manifest.json`）→ `POST /api/packages/install` →
  `POST /api/packages/vdacc.media-acquire/authorize`（`runtime:execute`）→ `PUT .../enabled`
  → `state=active / enabled=true / authorized=true / contributions=4`；
  `GET /api/integrations/installed` 出现 `package:vdacc.media-acquire`（界面「工具与扩展」能看见）。
  再用**安装目录里那份代码**（`@data/packages/.managed/releases/<uuid>/tools/probe.mjs`）真调一次：
  `vdl_probe` → 本机 VDACC → 网易云 `在你的身边 / 盛哲`，三档齐全；删掉 `config.json` 后报的是
  「请在 …\config.json 写入 {baseUrl,token}」而不是「请求失败」。
  **一处与文档不一致（如实记）**：install 返回的 `digest`（`3b5509…`）与注册表里记的
  `authorizedDigest`（`fb408f…`）不是同一个值，但 authorize 仍成功——「内容摘要」的实际算法
  在宿主侧，不是上传 ZIP 的哈希，别拿它当校验幂等键。
  **仍未验证**：`application` 仍是受控入口（子应用路线不变）；`web-ui` / `presenter` 贡献没做。
  见 `integrations/infos/README.md`。

执行依赖：F01–F07 → N01/N02 → N03/N04；N05 可在稳定源码上独立推进；N06 依赖设备和稳定连接恢复。
N08–N18 于 2026-11-06/09 收口，N13 依赖 DeepSeek 额度（无 key 时自动跳过，不影响其余结果）。

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
视频分析/提示词反推已于 2026-11-02 解冻，计划见 `docs/style-transfer-plan.md`；**人物三视图仍不排期**。

#### 2.6.4 UI 设计依据

参考 [infOS S06](https://github.com/YoKONCy/infOS/blob/main/.docs/S06_UI_UX_DESIGN_SPEC.md)：
浅灰画布、白色内容面、粉色主操作、天蓝运行态、少量紫色强调；侧栏 232–256px、
14px 卡片与右侧 Slide-over。正文系统字体、数据等宽；复用 VDACC 的语义令牌，
不复制角色、品牌素材或整套组件。HTML 可离线查看、筛选任务、展开详情、切换主题及打印。

### 2.7–2.8 已归档：B站 体验专项 / 收藏夹入口（2026-11-10）

2026-11-16 把这两节整体下沉到
[`docs/archive/plan-2026-11-bilibili-experience.md`](docs/archive/plan-2026-11-bilibili-experience.md)：
它们已全部落地并验收过（N19 扫码登录 / N20 分析页 / N21 剪贴板 / N22 地址过期重取 / N23 收藏夹选择入口），
继续留在主计划里只会让后来读上下文的人先翻 290 行已完成内容。

**仍然有效的结论（细节看归档）**：

- B站 登录走扫码：两个 GET、不需要 cookie 也不需要浏览器；网易云扫码被平台拒（`8821`），仍走 Edge。
- 收藏夹只做「分页列表 + 逐条下载」的选择入口，**不做一键全下**（与唧唧Down 同构）。
- 未验证：合集 `season`（手上没有真实 `sid`）；QQ 登录后 320K 未用真实账号验证。

### 2.9 平台泛化：同样的两件事能不能搬到别的站

能，但要按"只加适配器、不动 UI 与契约主干"的判据来做。现在要建的两块能力本质上都是**带适配器的通用件**：

| 通用件 | 接口 | B站 | 网易云 | QQ 音乐 | 酷狗 | 酷我 | 抖音 |
|---|---|---|---|---|---|---|---|
| 扫码登录 | `QrLoginAdapter`：`generate / poll / verify` | ✅ 已做（实测通过） | ❌ 试过被平台拒（8821），仍走 Edge | 未做（需 ptqrtoken，复杂度高） | 无登录 | 无登录 | 无登录需求 |
| 列表入口 | `CollectionAdapter`：`fetch(page, pageSize)` | ✅ 收藏夹/合集（合集 2026-11-17 实测：接口忽略 pn/ps，已改本地切片） | ✅ 歌单（2026-11-11）/ 专辑 | ✅ 歌单（2026-11-11）/ 专辑 | ✅ 歌单（2026-11-11）/ **专辑（2026-11-16）** | ❌ 歌单（接口要 csrf + kw_token，首页不下发） | ❌ 合集/主页（探测后不做） |

**阶段**

- **M3（进行中）**：B站 单平台打透 —— N19 扫码登录（含 19a 续期 / 19b 能力自检 / 19c 失败可诊断）、
  N20 分析页、N21 剪贴板、N22 地址过期重取、N23 收藏夹入口。
- **M4**：把上面两块抽成适配器接口，接**网易云**（它的接口最公开、没有 wbi、验证成本最低）：
  扫码登录 + 歌单/专辑入口。**歌单入口已完成（2026-11-11）**：专辑与歌单共用 `/api/album`
  与同一套 `planAlbum` 分页（`kind` 区分），CLI 加 `--playlist`，界面零新组件；
  网易云扫码登录已确认为平台侧拒绝（见 §2.9 表），维持 Edge 登录。
  **2026-11-16 收口「共用件」而不是「统一接口」**：三处真正重复的东西抽进
  `core/collection.ts` —— `bareNumericId()`（三个 `parsePlaylistId` 的第一句）、
  `emptyCollection()`（码 + 文案 + 下一步，且分开「空列表」与「有 ID 但详情全空」）、
  `detailsByIds()`（网易云那种 trackIds 两段式的分批补详情 + 按 ids 还原 + 缺失报数）。
  **不再做一个统一的 `CollectionAdapter` interface**：B站 是服务端分页 + 失效条目语义、
  网易云是两段式、QQ / 酷狗是「每页 N 条 + 声明总数」，硬套一层只会让每处多一层无意义适配；
  分页循环本身已经收在 `core/paging.ts`（同样的取舍）。
  顺带修掉一处抄错的文案：酷狗那段照抄了「登录后重试」，而酷狗没有登录态，已改由调用方给提示。
  仍缺：QQ / 抖音 列表入口（后者探测后不做，见 M6）。
- **M5**：QQ 音乐——先只做**歌单只读**。✅ 已完成（2026-11-11）：探测确认
  `musicu.fcg` 的 `srfDissInfo.aiDissInfo / uniform_get_Dissinfo` 匿名可用（`song_num=100` 一次给整单），
  而旧的 `fcg_ucc_getcdinfo_byids_cp` 回 `subcode=4000 check privacy error`；实现与网易云同形
  （`kind` + `planAlbum` 分页），CLI/服务端/界面/Android 四处都通。
  登录是否换扫码仍未定（ptqrtoken 未实测）。
- **M6**：抖音——合集/主页列表。❌ **暂不做（2026-11-11 探测结论）**，三条证据：
  ① `/aweme/v1/web/mix/aweme` 与 `/aweme/v1/web/aweme/post` 无签名一律 403 `Blocked by ArgusSecurityPlugin`；
  ② 带上现有的 `x-secsdk-web-signature` 后 HTTP 200，但不存在的 `mix_id` 回 `status_code=4` +
  `aweme_list:null`，而 `aweme/detail` 对不存在的视频回 `status_code=0` + 无 detail ——
  两者形态不同，**无法判断** `status_code=4` 是「合集不存在」还是「还缺 `a_bogus`」；
  ③ `douyin.com/collection/<id>` 返回 JS 挑战页（`jsvmprt`），拿不到 SSR 数据；两个已知真实视频的
  `mix_info` 都为空，**没有真实 mix_id 可用于验证**。
  因此本轮只做了一件事：把「合集/主页链接」的错误从「识别不出视频 ID」改成 `unsupported` +
  「接口需要额外签名参数，尚未验证」，并给出下一步。重启条件：拿到一条真实合集链接。

**落地顺序统一为「CLI 先通 → Web 渲染 → Skill 文档」**，避免为每个平台写一套界面；
Android 壳复用同一批 HTTP 接口，不再单独实现。

**未验证前置（不写死）**：网易云二维码登录接口、QQ ptqrtoken 流程、抖音合集接口今天是否可用，
每个阶段开工前先做一次接口探测，把结果写进对应能力基线文档。
| D4 | 单 P 是否也回 `parts[1]` | 是 / 否 | **是**（与唧唧 一致），但要同步 UI 与既有测试 |

---
## 3. 设计存档（已归档）

> 2026-10-19 的架构讨论（目标 A–D、分层取舍、重构点、当年 P0–P5 顺序）已整体下沉到
> [`docs/archive/plan-design-2026-10.md`](docs/archive/plan-design-2026-10.md)。
> **那是当年的取舍记录，不是待办**；当前计划只看 §2.4–§2.9。

---

## 4. 变更记录

- 2026-11-12：**B站 Hi-Res FLAC / 杜比音轨优先**（真实稿件 `BV1nutz6mEgY` 驱动）。
  实测（大会员登录）：`dash.flac = {display:true, audio:{id:30251, codecs:'fLaC', bandwidth:1434259}}`
  是**对象**，`dash.dolby = {type:2, audio:[{id:30250, codecs:'ec-3', bandwidth:1665173}]}`
  是**数组**；匿名访问同一稿件 `display` 仍为 true 但 `audio` 为空、`dolby.type=0`——
  判据必须是「有没有可用的 audio」，不能看 display/type。
  取舍：FLAC > 杜比 > 带宽最大的 AAC；容器按音轨定（flac/eac3 → mkv，否则 mp4），
  并在结果里说明「为什么是 mkv」。仅音频侧另加 `audio-flac` 档（实测落成 74,240,791 字节原生 flac）。
  顺带修两处长传输的健壮性：**416**（续传起点落在文件末尾，B站 的 416 不带 content-range，
  要退回探测到的总字节判定「其实已经下完」）与 **ECONNRESET/连接中断自动续传**（2 次）。
  实测：480P + FLAC → 92,366,771 字节 mkv（ffprobe：h264 + flac 48kHz 立体声，414.2s）。
  同一批把**弹幕转 ASS** 补齐（唧唧Down 有、我们原来只有 XML）：新增 `core/danmaku.ts`
  （解析 `<d p>` → 轨道分配 → ASS），`--danmaku` 现在同时落 `.danmaku.xml` 与 `.danmaku.ass`；
  滚动/顶部/底部三类还原、颜色转 BGR、同一时刻多条分轨；**高级(7)/代码(8)弹幕跳过并计入
  `danmakuSkipped`**。实测 `BV1GJ411x7h7`：1200 条 → 1190 条进 ASS（133,779 字节）/ 跳过 10 条，
  ffprobe 认作 `ass`。杜比视界视频轨维持「默认兼容」选 avc（不改成 hvc1）。
  测试基线 **310 pass / 0 fail**。
- 2026-11-11：**网易云歌单入口**（§2.9 M4 的「歌单」部分落地）。实测口径：
  `playlist/detail?id=X&n=N` 的 `n` 只截内联曲目、`trackIds` 恒为全量；
  `playlist/track/all` 匿名已 `code=404`。实现走 `trackIds` + 每批 100 条 `song/detail`、
  按 id 顺序还原；缺失曲目与 `trackCount`/`trackIds` 不符全部进 `warnings`。
  入口：CLI `--playlist`、`POST /api/album`（`kind`）、界面复用专辑列表卡（标签 PLAYLIST）。
  实测热度榜 3778678 200 首 / 419–610ms、浏览器端到端通。
  同日四件收尾：① **`163cn.tv` 短链**跟一次跳转（只接受 `music.163.com` / `y.` / `www.`，
  落在 `st.music.163.com` 活动页要明确报错，无效码 403 给「重新复制」下一步）；
  ② **Android 引擎移植** `playlistTracks`（网易云 trackIds 批量 + QQ musicu），
  `entry.albumAny` 增加 `kind`，界面复用专辑卡；`bun selftest.mjs` 新增 11 条歌单断言全过；
  ③ **QQ 歌单（M5）**：`musicu.fcg` 的 `srfDissInfo.aiDissInfo` 匿名可用（旧 fcg 接口回
  `subcode=4000 privacy error`），66 首实测 85–102ms；
  ④ **B站 音频单独下载（N20b）**：probe 多一条 `audio` 档，`--format audio` 只下 DASH 音频轨、
  转封装 m4a，界面 chip 从禁用改为可点；实测 4,981,362 字节 / aac 48kHz / 228.3s。
  抖音合集（M6）探测后**不做**（见 §2.9 M6 的三条证据），只把错误提示改准确。
- 2026-11-11（第三批 · 三件「有外部条件」的验收）：
  ① **真实收藏夹**（用户提供的 `fid=3473916881`）形状全对，顺手修两个真 bug：
  翻过末页（`medias: null + has_more: false`）被误判成 `collection_shape`、第 2 页把 `total` 覆盖成 0
  （界面会显示「已列 20 / 0」）。合集（`season`）仍无真实 `sid`。
  ② **Android 真机复测**（realme RMX5200 / Android 16）：用 `%LOCALAPPDATA%\vdacc-tools` 的工具链
  重新 `assembleDebug`（1,073,116 字节）并安装，分享 intent 送入两条链接后截图取证——
  网易云「热歌榜 PLAYLIST 20 / 200 曲目」、QQ「甜度爆表 PLAYLIST 20 / 66 曲目」，均带「之后还剩 N」。
  顺带补齐 `assets/ui/app` 与源码的 632 行欠账。
  ③ **真实 infOS 宿主**（`D:\infOS`，0.9.12）：装包 → 授权 → 启用 = `active`，
  `integrations/installed` 有投影，用安装目录那份代码真调 `vdl_probe` 成功（详见 §2.6.3 N18）。
  测试基线 **278 pass / 0 fail**。
- 2026-11-11（市场复核 + 两项暂停）：读完 `Astrmira/infOS-Market` 的 README / `CONTRIBUTING.md` /
  `catalog/README.md`，确认**尚未开放正式收录协议**——仓库 2 个 commit、`catalog/` 只有占位说明、
  条目格式/字段/分类规则全部未定义、客户端未接入（本机 0.9.12 里 `integration-market-card`
  只是「拓展功能」页的样式类名，不是市场入口）。市场收的是 **Package / Skill / 角色包 / 桌宠资源**，
  不是 `application`；当前唯一可执行的动作是**先开 Issue**（用途/来源/属性/截图）。
  用户决定：**Android 开发暂停**（手机拔走；代码已过 `selftest.mjs` 与真机两平台歌单验证）、
  **合集跳过**（没有真实 `sid`）。
- 2026-11-11（第四批 · B/C）：① **分页器抽象**：新增 `ts/src/core/paging.ts` 的 `collectPages`
  （去重 / 按声明总数收敛 / 上限**真截断** / 三条停止条件），QQ 与酷狗共用；
  **不**把 B站（服务端 pn/ps）与网易云（trackIds + 批量补详情）塞进同一接口——语义不同，强并只会多一层适配。
  ② **酷狗歌单接入**：`special/info` + `special/song`，实测 51 首 / 第 1 批 20 首；
  `--playlist`、`/api/album`、界面 PLAYLIST 卡都验过（当时服务端对酷狗专辑是**明确拒绝**；
  2026-11-16 已补上专辑批量，见 §2.9 表与 §4 最后一条）。
  ③ **酷我歌单如实不做**：接口要 `csrf` + `kw_token` 而首页不下发（另试了 SSR 430 / 压缩 NUXT /
  移动端 404），只给明确原因。测试基线 **292 pass / 0 fail**。
- 2026-11-11（第五批 · B站 / 抖音 下载体验）：
  ① **B站 预览有声音**：DASH 双轨下 `<video>` 只有画面，`/api/preview` 多回一个 `audioUrl`，
  前端用隐藏 `<audio>` 跟随 `<video>`（播/停/跳/倍速，偏差 >250ms 才纠偏）。
  途中抓到真 bug：`streamUrlAllowed` 拒绝**所有**非默认端口，而 B站 mcdn 是
  `xxx.mcdn.bilivideo.cn:8082` —— 这类地址的预览一直 403。现在只额外放行 8082，其它端口仍拒。
  ② **B站 双轨并行下载**：不限速时两条流同时下（进度 = 两者之和 / 探测总和）；
  **设了限速自动退回串行**，否则总带宽会变成限速的两倍。实测 480P：25,283,896 字节 / 228.3s / 约 2 秒。
  ③ **抖音图文作品**明确报 `unsupported`（「N 张图」+ 替代路径），不再掉进「没有解析到档位」。
  测试基线 **298 pass / 0 fail**。
- 2026-11-09：**N11 桌面分析面板**（A1 从 CLI 接到界面）；infOS 集成结论复核（见
  `integrations/infos/README.md`：子应用仍是宿主编译期内置，第三方可走 Package 的 tool/skill，
  Application Adapter 等 SDK）。测试基线 `bun test ts/tests` **178 pass / 0 fail**。
- 2026-11-06：**M4 三条收尾**（N08 端上二期 / N09 番剧 4K 对齐 / N10 A1 分析落地），详见 §2.6.3。
  测试基线：`bun test ts/tests` **176 pass / 0 fail**（+19 分析、+1 `preview-url`）；
  端上自检 75 + 落盘 8 + 标签 8 + 专辑 16；真机用 realme RMX5200 复核专辑、预览、打开、账号区。
  QQ 320K/无损只完成了**登录通道**，档位仍需真实账号验证（未验证前不写进结论）。

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
- 2026-11-10：**新增 §2.7 B站 体验专项**。动因：用户反馈登录经常卡网页。根因落在我们自己代码上——登录要弹 Edge、要 `node`+`playwright-core`、要抢 `%LOCALAPPDATA%\vdl\profile` 单例，失败还只写一行 console。竞品唧唧Down（Tauri 2 + Rust）用**纯 HTTP 扫码**完成登录，全程零浏览器；其证据（依赖清单、日志、实测接口）落在 `docs/design/reference-jijidown-notes.md`，该文档同时写明本轮**没有反编译**（本机无 Ghidra/Hopper/IDA）与未解前端 JS 的边界。计划 N19 扫码登录（P0）/ N20 分析页（P0）/ N21 剪贴板即分析（P1）/ N22 播放地址过期重取（P2），并有 4 个待决策（D1 二维码渲染方式 / D2 剪贴板默认开关 / D3 收藏夹 / D4 单P 是否回 parts）。同日补装 **Ghidra 12.2 + JDK 25**（D 盘）做二轮静态取证：三轮迭代定位到 12 个函数，确认「cookie 取自 Set-Cookie」「它没有登录态续期」「字幕没签名（不抄）」，据此加 N19a 续期 / N19b 登录后能力自检 / N19c 失败可诊断（§2.7.7）。同时更正一处事实：唧唧Down **确实做了**收藏夹 + 合集（`get_favorite_detail`、`x/space/fav/season/list`），我们不做是范围决定，不是「对手也没做」。IDA 未配置——Pro 需商业授权不能自动下载，Free 不支持插件。同日再补 §2.8/§2.9：收藏夹改为「做，但只做批量选择入口」（对手也是分页列表 + 逐条下载，`x/v3/fav/resource/list` + `x/space/fav/season/list`，无批量 IPC），并给出平台泛化路线 M4–M6（网易云 → QQ → 抖音，统一"CLI 先通 → Web 渲染 → Skill 文档"）。（§2.7 / §2.8 已于 2026-11-16 归档到 `docs/archive/plan-2026-11-bilibili-experience.md`。）
- 2026-11-02：**目标 C 解冻（范围收窄）**。确认生成用 **MiniMax H3**（提示词必须遵循官方三字段格式：`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`，时长 4–15s）、视觉理解用 **DeepSeek**、目标为「同风格新内容」。新增 `docs/style-transfer-plan.md`（A0–A5，约 6 个工作日，含每阶段验收与风险表）。其中两个关键设计：① **能算的不要问模型**——镜长/饱和度/对比度/颗粒/响度由 ffmpeg 直算，VLM 只负责内容、情绪、构图意图与风格命名；② 评估走「代理指标 + 人评」双轨，代理指标含色调直方图距离、镜长差、饱和度差。人物三视图仍不排期。
- 2026-11-16：**复原审计 + 发行收口 + 酷狗专辑**。① **审计**：快照复原后磁盘 266 个文件与 `origin/main`
  逐字节一致，没有丢代码；缺的全是 `.gitignore` 掉的东西（Bun / ffmpeg / `ts/node_modules` / `venv` /
  登录凭据 / Android 产物），而当时连 winget 都不在，`README` 里那几行命令一条都跑不了。
  ② **`scripts/setup.ps1`**：装 Bun 1.4.4 + ffmpeg（官方 zip 解到用户目录，不依赖 winget）→ `bun install`
  → `doctor` 汇总；脚本必须 UTF-8 with BOM（PowerShell 5.1 按 ANSI 读无 BOM 脚本会把中文当语法错误），
  认到工具后要补进当前进程 PATH（否则子进程 doctor 仍报缺失）。③ **3.6.0 收口**：版本号四处对齐 +
  版本一致性用例 + 重算体积基线（exe 110.0 MB / zip 52.2 MB）+ CHANGELOG 收口；本地分支 `master` 改名
  `main` 并绑定上游，删掉落后 38 个提交的 `feat/android-standalone`。④ **列表共用件**：`core/collection.ts`
  的 `bareNumericId` / `emptyCollection` / `detailsByIds`，三平台不再各写一份；不做统一 interface 的理由见 §2.9。
  ⑤ **酷狗专辑批量**（匿名可下，实测 12 首 / 124ms）：`album/info` 的 `songcount` **恒为 0**，总数只认
  `album/song` 的 `total`。⑥ **修 bug**：CLI 批量里每首都被交给 QQ 引擎，酷狗歌单批量下载 0 成功——现在按平台分派，
  同一条 36 首歌单里匿名免费的 3 首正常落盘；付费曲报错带平台原话「需要付费」。测试 **336 pass / 0 fail**。
- 2026-11-17：**环境补齐 + B站 合集实测**。① 复原后 `venv/` 是空的（legacy 连解释器都没有），
  已重建（3.12.10 + playwright 1.65.2 + yt-dlp 2026.10.26，legacy doctor 8/8）；为此给 `setup.ps1`
  补了 Python 检查/安装与 `-WithLegacy`（venv + pip + legacy doctor），并处理两个坑：Store 版 `python.exe`
  占位别名必须真跑一次 `--version`；子进程 Python 要 `PYTHONUTF8=1`，否则中文输出在控制台成乱码。
  ② **B站 合集的「未验证」已关闭**：`x/space/fav/season/list` **忽略 pn/ps**（实测 163 条在
  pn=1/2 × ps=5/20 下都回全量、无 `has_more`），以前按服务端分页用，界面会一次铺满几百条且
  「加载下一页」消失；现在合集改本地切片，收藏夹（真服务端分页）不动。实测 `season_id=4137556`
  p1=20 / p2=20 / p9=3 / p10=空，标题与 UP主 正确。③ 把「平台 → 下载引擎」收成
  `engines/downloaders.ts` 一张表（上一条酷狗批量 bug 的根因就是单条与批量各写一份三元表达式），
  单条/批量共用并有用例守着。④ 「系列」(`seriesdetail?sid=`) 不再当合集查——两者是两套 id、
  都是纯数字会撞车，硬查可能返回另一个合集；现在明确回 `unsupported`。测试 **343 pass / 0 fail**。
- 2026-11-20：**登录态实测 + 一批体验补齐（3.7.0）**。① **三站凭据在线有效**（B站/网易云 晨星成焰、
  QQ 星成焰），据此重核会员能力：B站 `BV1nutz6mEgY` 4K 882MB / Hi-Res FLAC 71MB；网易云热歌榜抽样
  三首全是 lossless 30–63MB；番剧 `ep397051` 4K 1,478MB（SSR 的 `id=122`），而同账号柯南 `ep321808`
  最高 720P —— **登录 ≠ 每部番都有 4K**。② **QQ `104003` 定性**：12 首样本里 4 首放行 128K/96K
  （说明 cookie 生效），8 首整曲被拒，320K/FLAC 一次未放行；账号无绿钻，`104003` 已翻成
  「当前账号无此档位权益」并给出下一步。③ **A3 风格卡进界面**（面板「生成风格卡」，落
  `style-card.{json,md}`，纯本地不花额度）；运镜改成「描述时勾选」（camera 是模型字段）。
  ④ **CLI 未知参数告警**（实测 `--out` 被静默吞掉）；**酷狗批量文件名**改「歌手 - 歌名」。
  ⑤ **Android**：端上 `albumAny` 补酷狗（离线自检 +9 条断言）；JDK 17 / Gradle 8.7 / SDK 34 装到
  `C:\tools`，`assembleDebug` 出 **1.05MB APK** 并在雷电模拟器装上启动——但该模拟器 adb 不通，
  **真机流程未验收**。⑥ CI 恢复 `push`/`PR` 自动触发。测试 **344 pass / 0 fail**。
- 2026-11-23：**真机回归 + 签名包 + 错误码统一 + 文档拆档**。① **模拟器回归**（adb 仍不通，
  用 `ldconsole installapp/runapp` + PrintWindow 截图 + 鼠标/键盘自动化）：release 包装上并启动，
  真实酷狗歌单解析出 **20/36 首**；顺手抓到两个**端上独有**的问题——任务卡显示内部 id
  （`mmwt04ayr20`）、失败文案缺「平台原话：需要付费」。已修并在设备上复验：标题变成
  `G.E.M.邓紫棋 - GLORIA`，文案带上原话。② **release 签名**：`keystore/` + `keystore.properties`
  （均不入库），`assembleRelease` 出 **822 KB** 签名包，`apksigner verify` 通过（`CN=VDACC`）。
  ③ **错误码统一**：新增 `core/hints.ts`，六个引擎与收藏夹的接口错误都带解释；**搞不清的码返回空串**。
  ④ **文档拆档**：`Plan.md` 108→67 KB、`AGENTS.md` 35→16 KB，平台事实表下沉
  `docs/verified-facts.md`（40+ 条，唯一事实来源）。⑤ **任务显示名**：`/api/jobs` 接受 `name`，
  专辑/歌单/分P/收藏夹入口都带上，桌面与端上同口径。⑥ **DSH 插件方案**：
  `docs/design/dsh-plugin-plan.md`——不迁移只加壳，与 infOS 共用中立工具描述。
  测试 **353 pass / 0 fail**。
- 2026-11-23（下午）：**Agent 入口改 MCP，删掉 Skill**。① **结论先行**：DSH 市场已有 MCP 桥插件
  （`dsh-mcp-servers`，把 stdio/HTTP/SSE 的 MCP server 暴露成原生工具），所以「DSH 插件」不必自研——
  一个 MCP server 同时喂 Claude / Codex / DSH。② **`ts/src/mcp.ts`**：stdio + 行分隔 JSON-RPC，
  四个工具 `probe`/`get`/`album`/`jobs`；默认自拉起 `server.ts`（`--port 0` + 随机 token，退出即关），
  也可用 `VDACC_BASE_URL`/`VDACC_TOKEN` 复用已开实例；`get` 支持 `wait_ms`，超时回 `job_id` 不假装成功。
  实测握手 / `tools/list` / `tools/call probe`（真实 B站 稿件）全通，`mcp.test.ts` 17 条离线用例。
  ③ **删 `ts/skill/`**：那份 SKILL.md 已把 QQ/酷我/酷狗 写成不支持、还写着「不含 yt-dlp 兜底」，
  属于**会主动误导外部 Agent** 的过期文档；`build_skill_ts.py` 改为生成 `README.txt`，
  独立包只剩 `vdl.exe` + 一页纯文本，基线相应刷新（2 个文件 / 110.0 MB / zip 52.2 MB）。
  ④ infOS 上架暂停（市场尚未上线）。测试 **370 pass / 0 fail**。
- 2026-11-23（晚）：**粗剪清单（A1 的可执行产物）**。① `analyze/cutlist.ts`：把分镜边界与静音段翻成
  `cutlist.csv`（切点/删除段 + 时间码 + 理由）与 `cutlist.edl`（CMX3600 保留段，剪辑软件直接导入）。
  ② **只删 ≥1s 的静音**——黑场/口头语/闪白要靠模型判断，猜错就是删正片，宁可不做；阈值可用
  `--cut-min-silence` 调，过短的保留缝（<200ms）会被合并，避免 EDL 全是碎片。③ 接入面：
  `analyzeFile({cutlist:true})`、CLI `--cutlist`、`/api/analyze` 的 `cutlist` 字段、面板「生成粗剪清单」
  （纯本地不花额度，产物可直接「打开 EDL」定位）。④ 验证：纯函数 12 条用例 + 真 ffmpeg 端到端
  （自造 2–5s 静音片，删 2.36s、保留 2 段、记录时间连续）+ 服务端路由断言。测试 **383 pass / 0 fail**。
- 2026-11-23（发版 3.8.0）：**MCP 单文件化 + 覆盖率补盲 + 可选本地 ASR**。
  ① `server.ts` 的 `Bun.serve` 抽成导出的 `startServer({port,token,lan,open})`，末尾用
  `import.meta.main` 保持「直接跑」的行为不变；`mcp.ts` 改为**本进程内**起后端（不再 spawn），
  于是 `bun build --compile` 出的 `vdacc-mcp.exe`（115 MB）真的能跑：握手 / tools/list /
  probe / jobs 全通，服务器日志被引到 stderr（stdout 只有协议）。
  ② **覆盖率** 78.3% → 79.8%：`sniff.ts` 46% → 78.6%（接管范围 / master playlist / CODECS 逗号 /
  变体排序 / HEAD·Range 探长 / 类型拒绝），`mcp.ts` 71% → 86.2%（token 头、复用实例、日志改道、轮询超时）。
  ③ **ASR**（`analyze/asr.ts`）：`--asr` 时若没有字幕则调本机 whisper.cpp（抽 16k wav → `-osrt` →
  读回 srt），`transcript.source='asr'`；**不内建模型**，没装只记 warning。测试 **400 pass / 0 fail**。
