# DSH（DeepSeek Harness）插件计划

> 状态：**调研完成，方案待拍板**（2026-11-23）。本文只写结论、依据与取舍，不写待办清单式空话。
> 相关：`integrations/infos/`（已有的 infOS Package）、`ts/skill/SKILL.md`（Agent Skill）、`Plan.md` §2.6 infOS 条目。

## 1. 调研结论：生态存在，而且很大

| 事实 | 数据 | 来源 |
|---|---|---|
| DSH 是什么 | DeepSeek 开源的 Agent 框架，MIT，"一切皆插件"（Cordis） | 官方文档 / 多个二手报道 |
| 社区规模 | GitHub 约 **28.4 万 star**；第三方插件约 **3.5 万个**（带 `dsh-plugin` topic 的仓库 34,499 个） | 2026-11 报道 |
| 使用量 | 日活约 **154 万**，日消耗约 920 万亿 tokens；约 60% 用户装过至少一个第三方插件 | Gate 报道（官方口径） |
| 已有市场 | `dsh-market`（第三方插件市场，日活 10 万）、`awesome-deepseek-harness`（181 个项目 / 11 类） | 社区项目 |

**所以「如果没有生态，我们转成 DSH 插件」这个前提不成立**：生态不但有，而且比 infOS 大两三个数量级。
正确的问题不是「要不要转过去」，而是「要不要**多挂一个宿主**，以及用什么形态挂」。

## 2. 三个宿主的定位（不是二选一）

| 宿主 | 形态 | 我们已有的东西 | 定位 |
|---|---|---|---|
| **CLI / 本地服务** | `bun ts/src/cli.ts` + `server.ts`（Bun） | 六平台引擎、ffmpeg 合并、A1–A3 分析 | **内核**：唯一实现，别的宿主都只是壳 |
| **infOS Package** | `integrations/infos/package/`（Manifest V2，`createContribution(host)`） | `vdl_probe` / `vdl_get` / `vdl_jobs` 三个 tool，走本地 HTTP | **一个宿主**（已落地，未上架） |
| **DSH Plugin** | Cordis 插件（`apply(ctx)` + `defineTool`） | —— | **另一个宿主**（本计划） |

结论：**不迁移，只加壳**。引擎继续留在 Bun + 本地服务里，两个宿主各自把「能力」翻译成对方的工具格式。
这同时解释了「infOS 计划保留」：两者是并列的两个壳，不是替代关系。

## 3. DSH 插件的技术事实（官方文档 + 二手文章交叉核对）

最小插件（官方 `Build a tool` 原文）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']          // 等工具注册表就绪

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {                         // 注意：不是 JSON Schema 的 properties 包裹
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) { return `Hello, ${args.name}!` },
  }))
}
```

加载：`dsh web --patch ./scratch-plugin/cordis.yml`；排查：`dsh --profile web --dump-config`。
包结构：`<plugin>/cordis.yml` + `src/*.ts`（bundle = 配置 + 挂载代码；profile 引用 bundle，patch 做局部覆盖）。

与我们的现状逐项对照：

| 维度 | DSH | infOS | 影响 |
|---|---|---|---|
| 参数 schema | **扁平 map**：`{ name: { type, required, description } }` | JSON Schema：`{ type:'object', properties, required }` | 需要一层「中立描述 → 两种格式」的编译 |
| 工具执行 | `execute(args)` 返回 canonical value，再由 `render` 转成 text 块 | `execute(args, ctx)` 直接返回字符串 | 逻辑可复用，包装层不同 |
| 依赖声明 | `inject = ['tools']`（Cordis 等注册表就绪） | manifest 里声明 `tool` 贡献 | 各自表述 |
| 权限/审批 | **没有显式权限字段**，靠「副作用可逆 + 作者自律」+ 工具流水线的 allow/deny/ask 策略 | 安装时 `authorize {digest, permissions}` | DSH 侧要更主动地自证安全 |
| 运行时 | Node + Cordis（in-process TS 模块） | infOS 宿主（Node） | 我们的引擎是 **Bun 专属 API**（`Bun.spawn`/`Bun.which`/`Bun.argv`），**不能直接 import 进 DSH** |
| 分发 | npm 包 + GitHub `dsh-plugin` topic；或 Git 仓库直接作为插件源 | ZIP（20 MiB / 解包 64 MiB） | DSH 侧发布更轻 |

## 4. 三种适配形态，选哪一种

| 形态 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 薄壳 + 本地服务**（推荐） | 插件只做 HTTP 客户端，调 `http://127.0.0.1:8765` 的 `/api/probe`、`/api/jobs` | 复用现成契约；插件 150–250 行；卸载干净；引擎不受 Node/Cordis 限制 | 用户要先起服务（或让插件代起） | ✅ **先做这个** |
| **B. 薄壳 + spawn CLI** | 插件 spawn `vdl.exe` / `bun ts/src/cli.ts`，解析 `--json` | 不占端口；单次调用即可 | 每次冷启动有开销；需要找 exe 路径 | 作为 A 的**降级路径**（服务没起来时用） |
| **C. 把引擎搬进 DSH 进程** | 直接 import `ts/src/engines/*` | 无外部依赖 | Bun API 要写 shim、ffmpeg 与磁盘仍在外、体积与卸载都变重 | ❌ 不做 |

**推荐 A + B 兜底**，与 infOS 包现在的做法一致（它也是走本地 HTTP），等于「同一套内核、两个壳」。

## 5. 插件设计（薄壳）

### 5.1 工具清单（先 4 个，不做多）

| 工具名 | 入参 | 返回（摘要） | 对应接口 |
|---|---|---|---|
| `vdacc_probe` | `url` | title / author / duration_ms / formats[]（id、label、bytes、available） | `POST /api/probe` |
| `vdacc_get` | `url`、`format_id?`、`subs?`、`danmaku?`、`cover?` | job id + 轮询到终态后的 path/bytes/warnings | `POST /api/jobs` + `GET /api/jobs/:id` |
| `vdacc_album` | `url`、`offset?` | 一批曲目（title/author/url），带 `hasMore/nextOffset` | `POST /api/album` |
| `vdacc_jobs` | `id?` / `all?` | 任务列表或单个任务状态 | `GET /api/jobs` |

**不给模型的东西**：整站批量、收藏夹一键全下（与红线一致：用户自己挑）。

### 5.2 关键实现细节

- **服务发现**：默认 `127.0.0.1:8765`，读环境变量 `VDACC_BASE_URL` / `VDACC_TOKEN` 覆盖；没有 token 时读 `%LOCALAPPDATA%\vdl\config.json` 之外**不猜**，直接报「先跑 `VDACC.bat`」并给出命令。
- **错误映射**：HTTP 401/403 → 「token 不对」；`error.code` 原样带出（我们已有 `next_action` 字段，直接拼进 tool 结果文本）。
- **长任务**：`vdacc_get` 内部轮询（默认 30s 超时，可配），超时返回 job id 而不是假装成功。
- **副作用可逆**：插件只注册 tool，不写全局状态；`cordis.yml` 里声明 `inject: ['tools']`。
- **安全自证**（DSH 没有权限字段，所以要自己说清）：README 与 tool 描述里写明「只连本机 127.0.0.1、不上传内容、下载落盘到本机输出目录」。

### 5.3 与 infOS 的「双向适配」

抽一份**中立工具描述** `integrations/shared/tools.json`：

```json
{ "name": "vdacc_probe", "description": "...",
  "parameters": [{ "name": "url", "type": "string", "required": true, "description": "..." }] }
```

两个生成器（都是纯函数，可单测）：

- `toInfosDefinition()` → `{ type:'object', properties, required }`（JSON Schema）
- `toDshDefinition()` → `{ url: { type:'string', required:true, description } }`（扁平 map）

这样「双向适配」不是口号：**改一处描述，两端同步**，并由一条用例断言两份生成结果与中立描述一致。

## 6. 里程碑（每步都有可执行的验收）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1** | `integrations/dsh/`：插件骨架 + 4 个 tool + `cordis.yml` + README | `dsh --profile web --dump-config` 能看到 `vdacc-*`；会话里 `vdacc_probe <B站链接>` 返回真实 title/format；卸载后工具消失 |
| **M2** | 服务未启动的降级：spawn `vdl.exe --json` | 关掉服务后同一句调用仍成功（走命令行），错误里带上「已回退到 CLI」 |
| **M3** | 中立描述 `integrations/shared/tools.json` + 两个生成器 + 用例 | `bun test` 里断言 infOS/DSH 两份定义都由同一份 JSON 生成 |
| **M4** | 发布：npm 包（或 Git 仓库直接装）+ 打 `dsh-plugin` topic + README 截图 | 在一台干净机器按 README 三步装好并调用成功 |
| **M5**（可选） | 若 DSH 支持原生 skill：把 `ts/skill/SKILL.md` 作为 skill 贡献，模型不必先读工具描述 | 待确认 DSH 是否有 skill 扩展点（见 §7） |

## 7. 风险与待确认（写清楚，不猜）

1. **沙箱是否允许插件 spawn 子进程 / 访问回环 HTTP**：DSH 有 `ctx.sandbox` 与 `ctx.shell`，但插件自己 `node:child_process` 是否被拦，官方文档没写死。M1 先用回环 HTTP（风险最低），M2 的 spawn 需要先验证。
2. **skill 支持情况**：官方 `develop-plugins` 页与架构页都**没有出现 skill**；二手文章说「技能也是插件」，但没给 API。M5 之前要先查 `reference/cookbook/adding-a-tool` 与扩展点清单。
3. **版本兼容**：DSH 仍在 v0.2.x（0.2.2 → 0.2.3-alpha 有破坏性变更）。插件要锁 peer 版本范围并在 README 写「适配到哪个 dsh 版本」。
4. **工具描述会进提示词**：4 个工具的描述加起来要短（目标 < 400 字），否则每次会话都多花 token。
5. **token 安全**：插件要读本地 token 才能调 `/api/*`。DSH 没有权限模型，所以 token 只能放插件自己的配置目录——**不写进日志、不回显**。

## 8. 明确不做

- **不把引擎迁进 DSH 进程**（Bun API + ffmpeg + 磁盘，收益低、风险高）。
- **不做「一键下整个收藏夹」这类工具**（与项目红线一致）。
- **不在 DSH 里重新实现 UI**（Web 界面继续由 `/` 提供；DSH 侧只暴露工具）。
- **不因为 DSH 火就砍掉 infOS**：两个壳共用一份中立描述，维护成本是线性的，不是翻倍。
