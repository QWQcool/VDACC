# infOS 集成参考（薄页面）

目标：在 infOS 里放一个页面，调用本机的 `vdl serve`，**不改 infOS 任何后端代码**。

## 为什么是「薄页面」而不是子应用

infOS 当前只有编译期注册的 application adapter（`packages/apps/{arca,pictoria,social}`），
新增一个要走 5 处改动 + 随宿主重编译；而它的 MOD/插件体系是 Python 时代的遗产，TS 重构时已移除。
所以最稳的接入方式是**外部 HTTP 服务 + 一个 Vue 页面**。

## 启动服务

```bash
# infOS 的开发源通常是 http://localhost:5173，打包后是 app:// 或 file://
vdl serve --lan --allow-origin http://localhost:5173 --allow-origin app://infos
```

- `--lan` 只在手机/其它设备需要时加；infOS 与桌面同机时省略。
- token 在启动输出里，复制进 infOS 的设置页（不要写进代码或仓库）。
- `--allow-origin` 必须与实际 Origin 一致，否则会被 403（见 `server.py` 的 `_origin_ok`）。

## 页面用到的接口

| 用途 | 请求 |
|---|---|
| 解析 | `POST /api/probe` `{url}` → `ProbeResult` |
| 下载 | `POST /api/jobs` `{url, formatIds:[...]}` → `{jobs:[...]}` |
| 进度 | `GET /api/events?token=...`（SSE，`{"type":"job","job":{...}}`） |
| 取文件 | `GET /api/files/<jobId>?token=...` |
| 打开目录 | `POST /api/reveal` `{path}`（仅桌面，手机无效） |

所有 `/api/*` 都要带 `X-VDL-Token` 头（SSE 用查询参数，因为 EventSource 不能设头）。

## 文件

- `MediaDownloader.vue` —— 可直接拷进 infOS 的页面组件（Vue 3 `<script setup>`）。
  只依赖 `fetch` 与 `EventSource`，不含样式，交给宿主主题。

## 注意

- 不要把 token 写死在组件里；从 infOS 的设置/密钥存储传入。
- 手机端只做「遥控 + 收件」：解析和下载仍在桌面执行，`/api/files` 负责回传。
- 本目录只是参考实现，**不会**自动改 infOS 仓库。
