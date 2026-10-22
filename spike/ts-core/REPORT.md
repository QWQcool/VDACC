# TS 可行性验证报告（spike/ts-core）

> 结论先行：**解析层可以等价替换，但不建议现在整体重写。**
> 单文件 exe 体积 91.9MB、冷启动 + probe 3.9s、B站 probe 慢 3.3 倍——这三项是硬伤。

## 环境

| 项 | 值 |
|---|---|
| 系统 | Windows 11 26200 |
| Bun | 1.4.3（`%TEMP%` 解压，未全局安装） |
| yt-dlp | **2026.10.21 独立 exe**（17.9MB，无系统 Python 依赖） |
| 对比基准 | 仓库 venv 的 `python -m vdl`（Python 3.12） |
| 数据 | 2026-10-22，同一网络 |

## Q1 四个引擎能否等价实现

**已验证 3 个（抖音 / 网易云 / B站），逐字段一致。**

| 平台 | Python 档位 | TS 档位 | 结果 |
|---|---|---|---|
| 抖音 | 3（1080P/720P/540P） | 3 | 媒体字段 + 每档 `bytes/bitrate/编码/帧率` 全部相同 |
| 网易云 | 2（lossless/exhigh） | 2 | 时长/码率/体积相同（体积走 HEAD 真实值） |
| B站 | 5（4K→标清） | 5 | 档位、体积、编码、帧率相同；`bitrate = tbr + abr` 已对齐 |

下载验证（抖音 1080P）：

```
Python: 6,281,768 bytes
TS    : 6,281,768 bytes   ← 字节完全一致
```

复跑命令：`python spike/ts-core/scripts/parity.py`

## Q2 yt-dlp 怎么用

- 用**独立 `yt-dlp.exe`**，`spawnSync` 调 `-J`，解析 stdout JSON；
- **不依赖系统 Python**（已验证：exe 直接跑通 `-J`）；
- 代价：B站 probe 从 **1,627ms 涨到 5,316ms（3.3×）**，主要是 exe 启动 + 每次重新初始化提取器。
- 进度只能解析 `--progress-template` 文本，本轮未实现下载（probe 已覆盖解析问题）。

## Q3 运行时能力

| 能力 | 状态 |
|---|---|
| HTTP / cookie 容器 | ✅ 手写 CookieJar（fetch 不自带） |
| 流式下载 + `.part` | ✅ 抖音实测 |
| Range 续传 | 代码已写（未做断网实测） |
| SSE / 本地服务 | ❌ 未移植（本轮不在范围） |
| ffmpeg 调用 | ❌ 未接（网易云标签/封面未验证） |
| 文件名清洗 | ✅ 与 Python 行为一致 |

## Q4 登录设施

未在本轮实现。但有一项有利证据：Playwright 的 `storage_state` 是**跨语言统一 JSON**，
现有 `%LOCALAPPDATA%\vdl\auth\*.json` 可直接读；Node 版 Playwright 的导出格式相同。
风险主要在浏览器分发（仍需 msedge/chromium），不在格式。

## Q5 打包

| 指标 | 结果 |
|---|---|
| `bun build --compile` | 成功，8 个模块 |
| exe 体积 | **91.9 MB** |
| exe 冷启动 + 抖音 probe | **3,932 ms** |
| 对比 Python | `python -m vdl` 冷启动 + probe ≈ 1,057 ms |

按事先定的失败条件：**「exe 启动 > 3s」已触发**（3.9s），体积 91.9MB 也逼近 100MB 上限。

## 延迟对比

| 站点 | Python | TS | 差异 |
|---|---|---|---|
| 抖音 | 1,057ms | **549ms** | TS 快约 2×（纯 HTTP + 轻量运行时） |
| 网易云 | 707ms | **449ms** | TS 快 |
| B站 | 1,627ms | 5,316ms | **TS 慢 3.3×**（子进程 + exe 启动） |

## 结论

**不建议现在整体重写。** 理由按权重排序：

1. **打包反而更差**：92MB / 3.9s，而 Python 用便携包（现有 370KB，依赖系统 Python）
   或 PyInstaller（约 20–30MB）都更轻；
2. **B站 变慢 3.3 倍**：yt-dlp 从「库」降级为「进程」，每次 probe 都要付启动成本；
3. **服务端/SSE/auth/ffmpeg 未验证**，整体重写仍需 2–3 周，且所有平台签名要重新回归；
4. TS 的真实优势只在「抖音/网易云这类纯 HTTP 引擎更快」和「前后端同语言」，
   不足以抵消上面三项。

## 如果将来仍要走 TS

建议**只做引擎侧、不做整体重写**：

- 保留 Python 的 `serve` / 任务队列 / auth / Skill 入口；
- 把抖音、网易云这类纯 HTTP 引擎用 TS 实现，作为独立子进程，按平台路由；
- B站 继续留在 Python（进程内 yt-dlp 明显更快）；
- 等桌面壳（Electron/Tauri）成为硬需求时，再考虑整体迁移。

## B+ 验证：常驻 Python helper

同一进程内复用 `yt_dlp.YoutubeDL`，避免每次启动 exe：

| 方式 | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| `yt-dlp.exe` 子进程 | 3,520ms | 3,416ms | 3,391ms |
| 常驻 helper（stdio JSON） | 1,417ms | **862ms** | **646ms** |

- 首调用含 Python 启动 + import（约 0.7s），之后稳定在 0.65–0.86s；
- 比纯 Python CLI（1.34–1.59s）还快，因为省掉了进程重启；
- 比 exe 快 **4–5 倍**。

实现：`helper/ytdlp_helper.py`（按行 JSON）+ `src/core/helper.ts`；
`VDL_TS_HELPER=1` 启用。B+ 可行，但**仍然需要 Python**。

## 参考实现：鸿蒙版的 B站 是纯 JS，没有 yt-dlp

| 项 | 事实 |
|---|---|
| 架构 | ArkTS 壳 + WebView；`app.js`(UI) + `mg-core.bundle.js`(逻辑，CommonJS) + ArkTS 桥，**没有独立后端进程** |
| B站模块 | `src/platforms/bilibili.js`（在 bundle 内） |
| 普通视频 | `api.bilibili.com/x/player/playurl?bvid&cid&qn&fnval&fourk=1` |
| 番剧 | `api.bilibili.com/pgc/player/web/playurl?ep_id=...` |
| 清晰度 | `qn`：720P=64 / 1080P=80 / 2K=112 / 4K=120 |
| 合并 | DASH 音轨 `fnval=16`，用 **mp4box.js** 在 JS 里 remux（`src/core/remux.js`，上限 1.5GB） |
| yt-dlp | **完全没有**（bundle 里 0 处引用） |
| WBI | **没有**（`wbi` 只出现在构建工具 `hvigorw.js`） |

含义：**B站 完全可以在 TS 里自实现，不需要 Python，也不需要 yt-dlp。**

## 结论更新

- B+ 证明「TS + 常驻 helper」可行，B站 甚至比纯 Python 快，但它**仍需要 Python**；
- 参考实现证明 B站 可以**纯 TS**（playurl + DASH + mp4box/ffmpeg 合并）。

所以如果走 TS，优先级应是：

| 方案 | 内容 | B站 | 是否要 Python | 体积 |
|---|---|---|---|---|
| A | 纯 Python | 1.6s | 要 | 20–30MB |
| B+ | TS + 常驻 helper | 0.65–0.86s | **要** | 92+20MB |
| **B++** | B站 也纯 TS（playurl + DASH + 合并） | 预期 0.3–0.6s | **不要** | ~92MB |

**推荐 B++**（若确定走 TS）：B站 用 `playurl` + `ffmpeg` 合并（桌面）或 `mp4box.js`（移动端），
彻底去掉 Python 依赖；B+ 只作为过渡方案。

## B++ 验证：B站 纯 TS（无 Python、无 yt-dlp）

| 指标 | 结果 | 对比 |
|---|---|---|
| probe | **305–319ms** | Python 1,627ms / yt-dlp.exe 3,400ms / helper 646–862ms |
| 档位 | 5 个，与 yt-dlp 逐字段一致 | 体积允许 2% 估算误差 |
| 480P 下载 | **21,154,992 字节** | 与 Python **完全相同** |
| 产物 | h264 854×362 + aac，206.464s | ffprobe 校验可播放 |
| 下载耗时 | 1.6s | — |
| 依赖 | 无 Python、无 yt-dlp、无 WBI（带 cookie 直接调 playurl） | — |

实现 `src/engines/bilibili_api.ts`：

1. `x/web-interface/view` → cid / title / pages / season；
2. `x/player/playurl?fnval=4048&qn=120&fourk=1` → DASH 视频 18 条 + 音频 3 条；
3. 按宽度桶挑「avc 优先、再比带宽」，体积用「码率 × 时长」估算（与 yt-dlp 的 filesize_approx 同源）；
4. 视频/音频分别下载（支持 Range），ffmpeg `-c copy` 合并。

未覆盖：番剧（`pgc/player/web/playurl`）、分P 选择、字幕、WBI 兜底。

## B++ 扩展：分P 与番剧

| 场景 | 结果 |
|---|---|
| 分P `BV1SknF6KE5g?p=2` | 4 个分P，selected=2；4 档与 Python **逐字节一致**（±1 字节估算误差） |
| 番剧 `ep733316` | 197 集，selected=1；1080P/720P/480P 与 Python 一致 |
| 番剧下载 480P | **127,096,266 字节**，15.7s，h264 852×480 + aac，1203s |

番剧 4K 档与 Python 有差异：TS 1.47GB vs Python 1.89GB。两者都是 3840×2160，
差异来自 `fnval=12240` 与 yt-dlp 选流的 codec 偏好不同（TS 优先 avc）。已记录，不影响可用性。

**踩到的坑（重要）**：把 `storage_state` 里 64 条 cookie 全拼进请求头（8,989 字节）时，
番剧接口直接返回 **400**；按「域名 + 未过期」过滤到 27 条 / 1,734 字节后恢复正常。
普通视频 `x/player/playurl` 能容忍大包头，番剧 `pgc/.../v2/playurl` 不能。
实现里已统一改为过滤后的 cookie。

## 能否完全抛弃 Python / yt-dlp

- **三个平台（抖音/网易云/B站）在 TS 里都已跑通**，Python 不再是引擎的必需；
- 仍留在 Python 的只有外围：`serve`/SSE/任务队列、`auth`（Playwright）、网易云标签写入、Skill 入口、37 个测试；
- **yt-dlp 只剩「未知站点兜底」一个用途**，可以做成可选依赖（不打包、按需下载）；
- 打包：Bun 单文件 92MB（含运行时）；Python 便携包 370KB + 系统 Python。

## 复现

```powershell
# 工具（%TEMP%，不入库）
bun.exe                      # %TEMP%\vdacc-ts\bun\bun-windows-x64\bun.exe
yt-dlp.exe                   # %TEMP%\vdacc-ts\yt-dlp.exe

# 对等性
python spike/ts-core/scripts/parity.py

# 单文件
bun build --compile --outfile vdl-ts.exe spike/ts-core/src/cli.ts
```
