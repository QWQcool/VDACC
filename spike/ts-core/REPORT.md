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
