# VDACC for infOS（Package 形态）

这是 infOS 的 **Package**（Manifest V2），不是子应用。它做三件事：调用本机 VDACC 服务解析链接、
提交下载、查询任务；外加一份 `skill` 告诉主 Agent 该怎么用。

> 为什么不是子应用：`packages/apps/*` 是宿主编译期内置，第三方上传声明 `application` 贡献
> **会激活失败**。详见 [`../README.md`](../README.md)。

## 装之前

1. **本机要有 VDACC 在跑**：双击 `VDACC.bat`，或
   `bun ts/src/server.ts --port 8765 --token <自定>`（不传 `--token` 会随机生成并打印）。
2. 记下启动输出里的 **token** 和端口。

## 安装

把本目录整个压成 ZIP（`manifest.json` 在 ZIP 根目录）：

```powershell
Compress-Archive -Path integrations/infos/package/* -DestinationPath dist/vdacc-infos-package.zip -Force
```

在 infOS 的「Package / 扩展」里上传这个 ZIP，安装后**启用并授权**（`runtime:execute`）。
授权是「本机代码信任授权」，不是沙箱——这点 infOS 的原话如此，我们照抄，不美化。

装好之后，在 **Package 数据目录**（infOS 卡片上能看到路径）建 `config.json`：

```json
{ "baseUrl": "http://127.0.0.1:8765", "token": "<VDACC 启动时打印的 token>" }
```

token 每次重启 VDACC 都会变，换过就更新这个文件。也可以临时用环境变量
`VDACC_BASE_URL` / `VDACC_TOKEN`（调试用，不建议长期）。

## 三个工具

| 工具 | 入参 | 行为 |
|---|---|---|
| `vdl_probe` | `{url}` | 只读解析：标题/作者/时长/档位（`formats[].id`、`bytes`、`available`、`reason`） |
| `vdl_get` | `{url, formatIds?, subs?, danmaku?, cover?}` | 提交任务，**立即返回任务 id**，不等下载 |
| `vdl_jobs` | `{id?, status?, limit?}` | 查任务：状态/进度/最终路径/字幕行数/错误原因 |

返回值都是**字符串形式的 JSON**（A06 的示例返回字符串，这里保持一致）。

## 边界（写在包里的部分）

- 不启动、不重启 VDACC 进程——服务由用户启动，包只调用；
- 不代用户登录、不读浏览器 cookie；
- `available:false` 的档位会带 `reason`（如 `need_login`），**不会**偷偷换档；
- 包内没有任何依赖（`dependencies: {}`），只有 `.mjs`，符合「只收已编译 ESM、拒绝 node_modules」的安装规则。

## 已知未做

- **没有镜头分析工具**：`POST /api/analyze` 已存在，但一次分析要跑 ffmpeg（2 分钟片子约 14 秒）
  且默认写入输出目录，是否适合作为 Agent 工具还没定，先不暴露。
- **没有 web-ui 贡献**：thin page（`../MediaDownloader.vue`）仍是参考实现，未打包。
- 兼容性按 Manifest V2 写，`packageId` 固定 `vdacc.media-acquire`；升级时要重新审核（infOS 的规则）。
