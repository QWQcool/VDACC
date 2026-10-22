# Plan.md —— 计划、架构与决策（唯一计划来源）

> 状态：**v2.1.0 已发布**；下一步是 `spike/ts-core` 的 TS 可行性验证（见 §3.3），
> 主线 v2.2 暂停到该结论出来。硬性约束见 `AGENTS.md`，使用说明见 `README.md`，
> 逐版本历史见 `docs/CHANGELOG.md`。

## 文档地图

| 想知道 | 看哪里 |
|---|---|
| 接下来做什么、为什么 | **本文**（§3 版本路线） |
| 每个版本改了什么 | `docs/CHANGELOG.md` |
| 不能违反的红线、已验证事实 | `AGENTS.md` |
| 怎么用（安装、命令、界面） | `README.md` |
| 给其它 Agent 的契约 | `skill/SKILL.md` |
| UI 参考、视觉基线、概念图 | `docs/design/` |
| 第三方来源与授权 | `NOTICE` / `THIRD_PARTY.md` |

---

## 3. 版本路线

### 3.1 已完成

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

### 3.2 v2 详细计划

| 版本 | 范围 | 验收 | 工期 | 依赖 |
|---|---|---|---|---|
| **spike** | TS 可行性验证（§3.3，不入主线） | Q1–Q5 有数据结论 | 5d | — |
| **v2.2** | 设置与登录态：`/api/settings`、`/api/auth`、4 页签面板 | cookie 过期时 UI 明确提示，不是下载失败 | 3–4d | spike 结论 |
| **v2.3** | 抽 `_music.py` + QQ 音乐 | probe 出档位，下载带标签 | 3–4d | v2.2 |
| **v2.4** | 酷我 + 酷狗 | 同上，逐平台 | 3–4d | v2.3 |
| **v2.5** | 限速/传输调优（`concurrent_fragments`、`ratelimit`、archive） | 限速到 2MB/s 实测生效 | 2d | — |
| **v2.6** | Vue 3 迁移 + i18n（**功能等价**，不改视觉） | 现有功能全部回归通过；中英切换 | 5–6d | — |
| **v2.7** | 设置页 + 批次多选（分P/合集，全选/半选）+ 任务详情 | 选 3 集 → 3 个任务；批次进度聚合 | 4–5d | v2.6 |
| **v2.8** | 番剧 + 弹幕 | 番剧先验证是否已可用，再决定写不写 | 3–4d | v2.5 |
| **v2.9** | 移动细节 / 打包（单文件 exe） | 手机上完成任务并取回文件 | 3d | v2.6 |

批次设计约束（已确认）：**清晰度整批统一**；默认上限 20、硬上限 50；必须 dry-run 预览；
只做「该视频所在的分P/合集」，**不做收藏夹抓取**。

### 3.3 TS 可行性验证（`spike/ts-core`）

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

### 3.4 暂缓与明确不做

**暂缓**（技术未成熟，不排期）：视频分析、人物三视图、提示词反推。
重启条件见 `AGENTS.md` 顶部；不要因为它们出现在 §4 设计里就当成待办。

**明确不做**：DRM / 付费绕过 / 私密视频 / 直播；站点广度竞赛；收藏夹批量抓取；
端上跑 B站（依赖 yt-dlp，不可移植）；QQ/酷狗/酷我之外的音乐平台。

### 3.5 TS 主线（3.0，2026-10-22）

**决策：后端主线切到 TypeScript（Bun），`vdl/` 冻结为 legacy。**

| 项 | 状态 |
|---|---|
| 引擎 | ✅ 抖音、网易云解析、B站（分P / 番剧，playurl + DASH + ffmpeg） |
| 服务 | ✅ `ts/src/server.ts`：probe / jobs / SSE / files / 静态页，现有 `vdl/web` 零改动可用 |
| 性能 | B站 probe 305ms（Python 1.6s）；分P 下载与 Python 字节一致 |
| 入口 | 根 `package.json`：`bun run serve` / `probe` / `get` |
| yt-dlp | 降为**可选组件**：未知站点按需下载，不内置 |
| 推荐档 | B站 批量/分P 默认 **1080P**，避免默认 1.4GB/集的 4K |
| 已补（alpha.2） | 网易云下载（标签/封面/歌词）、`auth`（Node Playwright）、设置、取消/重试、任务持久化 |
| 已补（alpha.3） | Skill 切 TS：单文件 `vdl.exe`（91.9MB）+ `SKILL.md`，zip 42.6MB |
| 已补（alpha.4） | TS 测试 16 个 + CI `test-ts`；平台识别抽成 `core/platform.ts` |
| 已补（beta.1） | yt-dlp 可选组件（安装 + `allowGeneric` + 通用引擎）、设置面板 UI |
| 已补（beta.2） | Vue 3 切片（`/vue/`，解析/多选/分P/下载/SSE/取消重试/主题）+ 中英 i18n |
| 待补 | 设置/预览/批量迁 Vue、旧版切默认入口、番剧 4K 选流对齐 |
| 已知边界 | SSE 百分比按单条流；番剧 4K 选流与 yt-dlp 有差异 |

契约不变：仍是 `schema=2`，`ts/src/core/types.ts` 与 `vdl/core/models.py` 字段一致。

---

## 4. 设计存档（2026-10-19 讨论）

> 以下为当时的架构探讨，部分前提已被 2026-10-21 的实测推翻（见各节批注）。
> 保留它是为了记录「为什么这么设计」，**不要按它排期**。

---

## 0. 起点：现状盘点

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

## 1. 目标拆解

用户提出三件事，复杂度差异极大，建议**按依赖顺序推进，不要并行**：

| # | 目标 | 性质 | 风险 |
|---|---|---|---|
| A | 支持 B站 | 工程，路径清晰 | 低 |
| B | 通用网页视频下载 | 工程，边界要划清 | 中 |
| C | ~~下载后自动分析 → 三视图 / 视频提示词~~ | 半研究性质 | **高 —— 已暂缓** |
| D | 整体封装成 Skill | 形态重构 | 低（但依赖 A-C 稳定） |

**2026-10-21 决策：目标 C 暂不列入开发计划。** 理由：三视图的跨视角一致性、视频生成提示词的可复刻性都还依赖尚未稳定的能力，现在做只能得到"看起来像"的中间产物，投入产出比不成立。等技术成熟（角色一致性可控、视频模型提示词语义稳定）再重启。
设计探讨仍保留在 §4，作为将来重启时的输入，**但不要按它开始排期**。

---

## 2. 目标 A：B站 —— 加"第二个引擎"，不是新写提取器

### 2.1 问题定性（2026-10-21 更正）

抖音的病**不是**"签名算不出来"：签名是 `x-secsdk-web-signature = md5(uifid_timestamp_SALT_query)`，
纯 HTTP 可算，见 §0 更正。「必须借浏览器」这条判断不成立。
B站的病是**要不要登录**（WBI 签名 yt-dlp 已经实现）。

两者性质不同，所以 B站不该复刻截流方案。

### 2.2 方案对比

| 方案 | 能拿到 | 代价 | 结论 |
|---|---|---|---|
| A1. yt-dlp 裸跑 | 最高 720P（未登录） | 零成本 | 起步够用 |
| A2. yt-dlp + 自有 profile 导 cookie | 1080P / 部分 4K | 需登录一次 | **推荐主线** |
| A3. Playwright 截 `playurl` 响应 | 同 A2 | 复刻抖音那套 | 冗余，不做 |

### 2.3 核心洞察：三道墙其实可以合法绕开

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

### 2.4 待办

- [ ] 实现 `auth.py`：headful 打开目标站 → 用户手动登录 → 导出 `cookies.txt`
- [ ] B站 engine 接入 yt-dlp，格式选择 `bv*+ba/b`（最高画质优先）
- [ ] 验证 1080P 是否真的拿到（对比 `-F` 列表里的分辨率）

---

## 3. 目标 B：通用化 —— 分层，别指望一个万能的

### 3.1 三层结构

| 层 | 手段 | 覆盖 | 可靠性 | 备注 |
|---|---|---|---|---|
| L1 | yt-dlp | 1752 站点 | 高 | 社区维护，优先 |
| L2 | 通用嗅探（拦 m3u8/mp4/DASH） | 任意网页 | 中 | 复用抖音那套拦截思路 |
| L3 | 逆向站点签名 | 抖音这类 | 低 | 易失效，逐个加 |

路由原则：**域名命中 L3 → L3；否则先试 L1；L1 报 unsupported → 降级 L2。**

### 3.2 L2 的真正难点（不是"截到地址"）

截到 URL 只是开始，后面的处理才是难点：

1. **m3u8 分片** —— 不要自己拼，把 m3u8 URL 直接交给 ffmpeg 吃
2. **DASH 分离流** —— 要挑 video + audio 两条，再 `-c copy` 合并
3. **候选选优** —— 页面里常有广告流 / 预览流 / 正片流混杂，不能只按字节数排序
4. **流式落盘** —— 现在的 `save()` 用 `resp.body()` 全量进内存，
   1GB 的文件直接爆。必须改成边下边写 + 边算大小

### 3.3 明确不做的

**DRM**（Widevine / Netflix / 付费点播）。没有合法解法，直接判定不支持并给出明确错误码。
建议写进 README 的 FAQ，避免以后反复纠结。

---

## 4. 目标 C：视频分析 —— 已暂缓（2026-10-21）

> ⚠️ **本节不排期。** 目标 C 已明确暂不列入开发计划，以下内容仅作将来重启时的设计输入。
> 重启前先确认两件事：① 是否有支持图像输入的模型可用（见 §8 决策 2 的遗留风险）；
> ② 角色一致性能否达到可用水平（现在只到"参考级"）。

### 4.1 三段式拆解（确定性依次下降）

| 段 | 内容 | 手段 | 确定性 |
|---|---|---|---|
| C1 | 抽帧 + 场景切换检测 + 语音转写 | ffmpeg `scdet` + faster-whisper | **确定，纯工程** |
| C2 | 画面内容理解 | VLM（本地 Qwen-VL 类 7B / 云端多模态 API） | 半确定 |
| C3 | 生成三视图 / 视频提示词 | 文生图 / 提示词工程 | **不确定** |

建议**先做 C1，C2 可做，C3 单独隔离**。别让高不确定性功能拖垮已经很稳的下载工具。

### 4.2 坑一：三视图不能"抽一帧直接生成"

单帧里压根没有背面和侧面的信息，模型只能瞎猜，出来是三张不同的脸。靠谱路径：

```
多帧采样（覆盖不同角度 / 景别）
  → VLM 提炼「角色设定卡」（结构化字段）
     发色 / 发型 / 瞳色 / 体型 / 服装 / 配饰 / 画风 / 年龄段
  → 逐视角独立生成（正面 / 侧面 / 背面，固定 seed + 同一设定卡）
```

**预期管理**：一致性是行业难题。能做到"参考级"三视图，做不到"可直接进 pipeline 的资产级"。
要资产级需上角色 LoRA 或 ControlNet，那是另一个量级的工程。

### 4.3 坑二：反推提示词不是"写一段描述"

视频生成模型吃的是**镜头级**提示词，结构大致：

```
主体 + 动作 + 运镜（推/拉/摇/移/环绕）+ 光线 + 风格 + 时长 + 情绪
```

一条长描述喂给 Seedance 只会得到平庸结果。必须**按镜头切分，一镜一条**。
而且各平台偏好不同（MiniMax 偏自然语言叙事、可灵支持结构化运镜参数），
需要一层「模板适配器」，不能一套提示词打天下。

### 4.4 合规红线

视频里是真实人物时，生成其三视图属肖像权高风险区。
默认走「风格化 / 二次元化」路径，或在 UI 上明确标注用途受限。

---

## 5. 目标 D：Skill 化 —— 值得做，但不是现在

### 5.1 三个判断

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

## 6. 现有代码的重构点

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

## 7. 推进顺序

| 优先级 | 任务 | 状态 | 验收标准 | 依赖 |
|---|---|---|---|---|
| **P0** | 装 ffmpeg | **完成**（本机 n8.1.2） | `yt-dlp -F` 不再警告 ffmpeg not found | — |
| **P0.5** | 抖音纯 HTTP 签名引擎（`dy_http.py`） | **完成 2026-10-21** | 无 cookie 拿 1080p，浏览器方案降为兜底 | P0 |
| **P1** | 引擎路由重构 + B站跑通 | **完成**（M1 + M5） | B站视频下有声音有画面，1080P | P0 |
| **P2** | 通用兜底 | **部分完成**：`ytdlp-generic` 已做（R3）；L2 通用嗅探（m3u8/直链）未做，见 §3.4 | 任找一个 yt-dlp 不支持的站点下成功 | P1 |
| ~~P3~~ | ~~分析链路（抽帧 + 转写）~~ | **暂缓 2026-10-21** | — | — |
| ~~P4~~ | ~~生成侧（三视图 / 提示词）~~ | **暂缓 2026-10-21** | — | — |
| **P5** | Skill 化封装（`video-acquire`） | **完成**（M6） | agent 能一句话调通 | P1 |

**P0/P1 是地基**，且能验证"通用化"这个假设成不成立。
P3 之后的每一段都应能独立失败而不影响下载器。

---

## 8. 已决策（2026-10-21，原「待决策」已清空）

| # | 决策 | 影响 |
|---|---|---|
| 1 | **ffmpeg：优先便携版**，`ffmpeg.exe` + `ffprobe.exe` 放 `venv\Scripts\`；找不到再回落系统 PATH | 运行时查找顺序以 `vdl/core/env.py` 为准：`venv\Scripts` → `PATH` → 报 `ffmpeg_missing`。二进制不入库（venv 已 gitignore）。**本机现状**：n8.1.2 由 winget 安装、走 PATH 分支——功能等同，但不符合"不污染系统"的初衷；换机时按便携版放进 `venv\Scripts\` 即符合决策 |
| 2 | ~~分析侧走云端 API（DeepSeek key）~~ **暂缓（2026-10-21）** | 目标 C 整体暂缓，本决策随之搁置。原遗留风险仍未验证：DeepSeek 公开 API 是否支持**图像输入**。重启时第一步先验模型能力，再决定云端 VLM（Qwen-VL / GLM-4V / Gemini）或本地方案 |
| 3 | **B站 V1 就登录** | `vdl auth bilibili`：独立 profile 扫码 → `storage_state()` 导出 cookie → yt-dlp 用。不登录只到 720P |
| 4 | GUI 壳 = **本地 Web UI**（`vdl serve`），tkinter 仅过渡 | 端口固定 `8765` + 一次性 token；SSE 推进度 |
| 5 | 音乐默认 **lossless**，拿不到时如实降级并标注 | 单曲体积大，UI 必须先显示真实大小 |
| 6 | infOS **暂不集成**，UI 风格向它靠 | 等作者确认要不要子应用；我们的 `vdl serve` 已为其预留对接点 |

---

## 9. 变更记录

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
- 2026-10-21：**R2 完成（可交付）**。`vdl/core/config.py`（`%LOCALAPPDATA%\vdl\config.json`，`vdl config --set`）；任务历史落盘 `jobs.json`（最近 100 条，`running` 重启后标 `interrupted`）；`doctor --fix` 只补 pip 依赖（ffmpeg 不自动下载）；`VDACC.bat` 一键启动；`.github/workflows/ci.yml`（unittest + Skill 构建校验）。legacy `dy_dl.py`/`dy_gui.pyw` 冻结：不迁移 tkinter（浏览器兜底不在 vdl 里），新能力只加 vdl。
- 2026-10-21：**R3 完成（通用兜底）**。抽出 `engines/_ytdlp.py`：档位折叠（按宽度）、音视频成对合并、两条流进度聚合只写一处；`bilibili.py` 瘦身为 50 行薄封装（保留 `bili-*` 档位 id）；新增 `engines/generic.py`（`ytdlp-generic`，任意 http(s) 链接兜底，失败返回 yt-dlp 原始报错并清洗 `ERROR:` 前缀）。路由顺序固定为「专用引擎 → 通用兜底」。测试 26 个全绿。**分P 与字幕 sidecar 推迟**：前者要改契约（`parts[]`），后者价值低，留到有真实需求时做。
- 2026-10-21：**R4 完成（局域网与宿主接入）**。`vdl serve --lan` 绑 `0.0.0.0` 并打印局域网地址与风险提示；新增 `--allow-origin`（可重复）与配置里的 `allowedOrigins`；新增 `/api/files/<jobId>` 流式回传（仅 done 任务、仅输出目录内）；Web UI 的完成任务多一个「下载」按钮；`integrations/infos/` 提供薄页面参考（Vue 3 SFC + 接入说明），不改 infOS 仓库。测试 28 个。
- 2026-10-21：**R5 完成（1.0.0）**。补齐 Apache-2.0 `LICENSE`（官方原文）、`NOTICE`（infOS 角色素材、yt-dlp、FFmpeg、MediaGrabber 参考范围）、`docs/ROADMAP.md`、`docs/RELEASE-1.0.0.md`；版本号统一 1.0.0；构建 `dist/video-acquire.zip` 作为 Release 资产。
- 2026-10-21：**v1.1 完成（可靠性）**。`core/download.py` 与 `dy_http` 支持 Range 续传（`.part` + 记录来源 URL 的 sidecar，避免换候选拼错文件）、网络/5xx 自动重试 3 次；任务支持取消（`cancelled` 状态，保留 `.part`）与重试（新建任务）；`serve --concurrency 1~4`；`doctor --live` 三站点真解析（实测 531/436/1875ms）、`--bundle` 脱敏诊断包。实测：B站 480P 取消于 39.8%，重试后完成；并发下抖音+网易云同时下载完成。
- 2026-10-21：**目标 C 暂缓，路线收口**。视频分析 / 三视图 / 提示词反推暂不列入开发计划，等角色一致性与视频模型提示词语义稳定后再重启（§1、§4 已标注）。同步清掉两处文档不一致：① ffmpeg 决策改为「优先便携版、回退 PATH」并如实记录本机是 winget 装在 PATH 上；② 分析侧模型决策随目标 C 一并搁置，DeepSeek 图像输入能力仍未验证。§7 补齐 P0–P5 的实际完成状态（P2 只做了通用兜底，L2 嗅探未做）。
- 2026-10-22：**v1.2 完成（内容完整性）**。契约升到 `schema=2`（新增 `media.parts[]` 与 `formats[].subtitles[]`，均为新增字段）。B站 多P/合集：用公开 pagelist 接口取分P，`?p=N` 选中并只解析该分P（实测 BV1SknF6KE5g 四P，P1 145MB / P2 89MB，selected 正确）；UI 加分P下拉。字幕：`--subs` 落同名 `.srt`（中文优先），覆盖 to_srt 单测；**实测边界**：排行榜前 12 个视频均无 CC，端到端只验证到「无字幕时静默跳过」，有 CC 的真实样本待补。弹幕 XML 与音乐专辑批量延期到 1.2.x/1.3。测试 33 个。
- 2026-10-22：**v1.3 完成（入口）**。① PWA：manifest + service worker（只缓存外壳、不缓存 /api）+ 192/512 图标；token 首次带参数打开后存 localStorage，从桌面图标启动无需再带 token（实测 manifest/sw/icon 的 MIME 均正确）。② Chrome/Edge 扩展（MV3）：右键转发链接到本机，只做导航打开、不 fetch，因此不需要 host 权限与 Origin 白名单。③ 便携包 `tools/build_portable.py`（40 文件 / 481KB，zip 368KB，不打包 Python 本体避免杀软误报）。i18n 延期：当前 UI 仅中文，抽词条要动全部模板，收益低于入口建设。
- 2026-10-22：**v2.0 完成（跨端入口）**。手机首次打开无 token 时显示「连接本机 VDACC」输入框，token 存 localStorage，之后可直接从快捷方式进入（实测 390×844：门禁可见 → 输入 token → 主界面加载）。移动布局复核通过（任务卡、取消/重试、完成提示均正常）。**原生壳未构建**：本机无 JDK / Android SDK / DevEco，不提供安装包；Android(Capacitor)/Harmony(ArkWeb) 的构建前提与「端上只跑纯 HTTP 引擎、B站必须遥控」的边界写进 `integrations/mobile/README.md`。
- 2026-10-22：**v2.1 完成（附属文件）**。新增 `core/sidecar.py`：`--cover` 把封面存成同名图片（按 Content-Type 定 .jpg/.png/.webp），B站 与抖音共用同一实现；`--subs` 与 `--cover` 都遵守「附属文件失败不影响视频」。Web 界面在下载按钮旁增加「封面」勾选框（有缩略图时显示）。补 `tests/test_sidecar.py`：用本地 HTTP 桩端到端验证「取字幕 JSON → 转 SRT → 写同名文件」与封面落盘，补上 v1.2 遗留的字幕未验证缺口。实测：抖音封面 438×330、B站 480P 封面 1600×900 均正确落盘；测试 33 → 37。
