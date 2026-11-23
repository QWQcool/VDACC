# Plan.md §2.1–2.3 归档（历史版本与 TS 可行性验证）

> 从 `Plan.md` 整体平移过来（2026-11-23），**内容未改写**，只加了这个头。
> 这几节记的是 3.0–3.3 的完成盘点和 `spike/ts-core` 的可行性验证，
> 属于「当年怎么定下来的」，不是待办。逐版本改了什么看 `docs/CHANGELOG.md`。

---

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
| 网易云歌单 | ✅ 已完成（2026-11-11，含真实接口实测）：`--playlist` / `/api/album` / 界面复用专辑列表卡（标签变 PLAYLIST）。`playlist/detail` 的 `n` 只控制内联曲目、`trackIds` 全量，`playlist/track/all` 匿名已 404，所以走 `trackIds` + 每批 100 条 `song/detail`。热度榜 3778678 实测 200 首 / 419–610ms / 0 warnings，CLI 与浏览器端到端均通。`163cn.tv` 短链同批补上（跟一次跳转，落在 `st.music.163.com` 活动页要明确报错）；Android 引擎已移植 |
| QQ 音乐歌单 | ✅ 已完成（2026-11-11，含真实接口实测）：`musicu.fcg` 的 `music.srfDissInfo.aiDissInfo / uniform_get_Dissinfo`（匿名可用，`song_num=100` 一次给整单）；`fcg_ucc_getcdinfo_byids_cp` 对同一歌单回 `subcode=4000 check privacy error`，**不可用**。实测 66 首歌单 4 批 / 85–102ms。入口同上（`--playlist` / `kind=playlist` / 界面 PLAYLIST 卡），Android 同步移植 |
| B站 音频单独下载 | ✅ 已完成（2026-11-11）：probe 多一条 `audio` 档（体积只按音频带宽算、不抢推荐），`get --format audio` 只下 DASH 音频轨并转封装 m4a；界面「音频」chip 从禁用改为可点。实测 `BV1SknF6KE5g`：4,981,362 字节 / aac 48kHz 立体声 173kbps / 228.3s，ffprobe 确认只有一条音轨 |
| 酷我 / 酷狗 | ✅ 已完成（2026-10-23）：公开接口 probe + 下载 + 标签/封面（酷我还有 `.lrc`），已接路由。实测酷我 128kbps 3,368,054 字节 / 酷狗 128kbps 4,631,150 字节；320K/FLAC 需会员，接口拒绝时如实报试听档 |
| 酷狗歌单 / 酷我歌单 | ✅ 酷狗已接（2026-11-11，真实实测）：`special/info` + `special/song?page=&pagesize=`，51 首歌单第 1 批 20 首，歌手歌名从 `filename` 拆分。❌ 酷我**不可用**：网页 API 要 `csrf` + `kw_token` 而首页不下发、桌面歌单页 430、移动页是压缩 NUXT 表达式（不 eval）；搜索接口只给歌单名不给曲目。两处都给出明确原因，不说「识别不出 ID」 |

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