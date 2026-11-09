# infOS 集成参考

> **2026-11-09 复核**：下面第 2 节「只能薄页面」的结论**需要修正**——infOS 这一年补了
> Package（Manifest V2）与 Application 接入协议，虽然都不是「上传即成为子应用」，
> 但比当初的三选一多了两条可走的路。历史结论保留在 §6，先看新的判断。

## 1. 三条路，先分清「子应用」不是第三方能拿到的形态

| 形态 | 谁能做 | 现在的可用性 | 对我们的意义 |
|---|---|---|---|
| **子应用**（`packages/apps/{arca,pictoria,social}`） | 仓库内编译期注册，随宿主构建 | 只能由维护者在 monorepo 里加 | ❌ 我们不是维护者，**这条路不存在** |
| **Package**（Manifest V2，`tool` / `skill` 等贡献） | 用户上传 ZIP 到 `@data/packages` | 机制已实现（安装→审核→激活，逐贡献回滚） | ✅ **现在唯一能真跑的自助形态** |
| **Application Adapter**（三层：Foundation / Adapter / 应用侧桥） | 贡献者实现 Adapter | 协议已写（`.docs/A10`），**SDK 与 CLI 尚未发布**，文档自己也标注「设计契约」 | ⏳ 只能设计，不能实现 |

关键澄清（都来自 infOS 自己的文档，不是猜测）：

- 贡献类型联合里**有** `application`，但用户上传的包声明它 **会激活失败**——
  `runtime-adapter` / `application` / `policy` 属于「仅受控入口接入」。
- Package 的跨进程通道是 `PackageProcessTransport`（逐行 JSON-RPC stdio），
  **不是 MCP**；MCP 在 infOS 里是「已安装列表」中的一个独立分类，
  以及第三层 Adapter 可选的「被集成应用暴露能力」手段。
- 权限是默认拒绝：`安装 ≠ 激活 ≠ 授权`，`runtime:execute` 是**本机代码信任授权**，
  不是 OS 沙箱；`@data/packages` 里的包拥有服务进程的真实权限。

## 2. 因此推荐路线（按可交付顺序）

**Phase 1 · 现在能做：Package（skill + tool），调本机服务**

- `skill` 贡献放我们已有的 `ts/skill/SKILL.md`（什么时候该用、错误码怎么读）。
- `tool` 贡献放 2–3 个薄函数：`vdl_probe` / `vdl_get` / `vdl_jobs`，
  handler 里 `fetch('http://127.0.0.1:8765/api/...')`，token 从 Package 数据目录读用户填的值。
- 硬约束（来自 infOS 安装器，必须照做，否则装不上）：
  - ZIP 根目录或**唯一**顶层目录里有 `manifest.json`；
  - 只收**已编译 ESM** `.mjs`（或 `type: module` 的 `.js`）——**服务端不隐式构建 TypeScript**；
  - 上限 **20 MiB ZIP / 64 MiB 解包**，拒绝预装 `node_modules`、`file:`/`workspace:`/Git/URL 依赖；
  - 入口不许越出 Package Root；依赖只允许注册表版本，安装强制 `--ignore-scripts`。
- 这条路的**代价**：VDACC 必须在本机跑着（服务已启动），Package 只是「调用方」，
  不是把 91 MB 的 exe 塞进包里。

**Phase 2 · 等 SDK：Application Adapter**

等 `@infos/application-sdk` / `application-ui-sdk` 与 `validate/test/pack` CLI 真的发布，
再按 A10 的三层做：Backend Adapter（把 probe/get/jobs 映射成 `command` / `task` endpoint）、
Frontend Adapter（UI 插槽）、以及我们这侧的 Sidecar（其实就是现在的 `vdl serve`）。
在那之前动手等于对着草案写代码，返工概率极高。

**Phase 3 · 市场收录：等目录格式**

`Astrmira/infOS-Market` 目前只有 2 个提交、`catalog/` 是空骨架，
README 明说「目录格式、安装流程与工坊关联方式将在对应功能设计时确定」，客户端也尚未接入。
所以现在能做的只是准备元数据（介绍、版本、兼容范围、下载来源），不能提交条目。

## 3. 与「薄页面」的关系

薄页面（`MediaDownloader.vue`）仍然有效，但它解决的是「人在 infOS 里点按钮」；
Package 解决的是「主 Agent 调工具」。两者不冲突：

- 人用 → 薄页面（塞进 infOS 的 web-ui 或作为独立页面）；
- Agent 用 → Package 的 `tool` 贡献（返回结构化 JSON，人看的日志不进结果）。

## 4. 启动服务（薄页面 / Package 都需要的同一件事）

```bash
# infOS 开发源通常是 http://localhost:5173，打包后是 app:// 或 file://
vdl serve --lan --allow-origin http://localhost:5173 --allow-origin app://infos
```

- `--lan` 只在手机/其它设备需要时加；同机省略。
- token 在启动输出里，填进 infOS 设置或 Package 数据目录（**不要写进代码或仓库**）。
- `--allow-origin` 必须与实际 Origin 一致，否则 403。

## 5. 页面用到的接口

| 用途 | 请求 |
|---|---|
| 解析 | `POST /api/probe` `{url}` → `ProbeResult` |
| 下载 | `POST /api/jobs` `{url, formatIds:[...]}` → `{jobs:[...]}` |
| 进度 | `GET /api/events?token=...`（SSE，`{"type":"job","job":{...}}`） |
| 取文件 | `GET /api/files/<jobId>?token=...` |
| 打开目录 | `POST /api/reveal` `{path}`（仅桌面，手机无效） |
| 镜头分析（A1） | `POST /api/analyze` `{path}` → 分镜 / 帧 / 台词 / 指标 |
| 能力位 | `GET /api/health` → `capabilities.analyze`（缺 ffmpeg 时为 false） |

所有 `/api/*` 都要带 `X-VDL-Token` 头（SSE 用查询参数，因为 EventSource 不能设头）。

## 6. 历史结论（2026-10-21，已部分过期）

> 原文：infOS 当前只有编译期注册的 application adapter，新增要走 5 处改动 + 随宿主重编译；
> MOD/插件体系是 Python 时代遗产，TS 重构时已移除。所以最稳的是外部 HTTP + 一个 Vue 页面。

**现在仍然成立的部分**：第三方不能通过「上传」成为 `packages/apps/*` 子应用。
**已经过期的部分**：「没有任何扩展机制」——Manifest V2 Package 与 Application 协议都是之后补的。

## 7. 文件

- `MediaDownloader.vue` —— 可直接拷进 infOS 的页面组件（Vue 3 `<script setup>`）。
  只依赖 `fetch` 与 `EventSource`，不含样式，交给宿主主题。

## 8. 注意

- 不要把 token 写死在组件或 Package 里；从 infOS 的设置 / Package 数据目录传入。
- 手机端只做「遥控 + 收件」：解析和下载仍在桌面执行，`/api/files` 负责回传。
- 本目录只是参考实现，**不会**自动改 infOS 仓库。
