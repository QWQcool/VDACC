# Android 独立端方案（C 路线）

> 状态：设计稿，未开工。日期 2026-10-27。目标版本待定（建议 4.0）。
> 参考实现：`C:\Users\v_chchsli\Desktop\MediaGrabber 媒体下载器 1.0.0\HarmonyOS-NEXT\MediaGrabber-1.0.0-harmony-source`
> 及其 `Android/MediaGrabber-1.0.0-android.apk`（只有包，无源码，已解包核对）。

---

## 1. 目标与非目标

### 目标

1. **不依赖电脑**：手机自己解析、下载、合并、落盘；
2. 覆盖现有内置平台：抖音、B站（含分P/番剧、字幕/弹幕）、网易云、QQ 音乐、酷我、酷狗；
3. 下载在**前台服务**里跑，锁屏/切后台不中断；
4. 文件落在系统「下载/VDACC」或用户选的 SAF 目录，卸载不丢；
5. 与桌面端共享**解析与命名规则**（同一个引擎源码，两套运行时），避免两端行为漂移。

### 非目标（这一版明确不做）

- 不做 yt-dlp 长尾站点（端上没有 Python，也不该塞）；
- 不做 HLS 直播/长视频（M5 再评估，见 §11）；
- 不追求与桌面端 100% 功能对齐（桌面端仍负责长尾、批量、大文件）。

---

## 2. 参考实现给我们的四个结论

| 结论 | 证据（文件 / 数字） |
|---|---|
| 端上可以跑完整 JS 引擎 | 鸿蒙 `rawfile/vendor/mg-core.bundle.js` 1.0 MB，含 bilibili/douyin/kuwo/kugou/qq 实现；`Index.ets` 用 ArkWeb 加载本地页面 |
| 原生只提供「能力」，不做业务 | `PlatformBridge.ets` 只有 16 个方法：`fsAppendChunk/fsWriteFile/fsExists/fsMkdirp/fsRemove/fsRename/fsStat/fsReadChunk/fsList/fsToRealPath/httpRequest/cryptoAes128CbcDecrypt/Encrypt/cryptoMd5Hex/getPaths/getMeta` |
| 没有 ffmpeg，用 JS remux + 体积阈值 | `core/mobile-download.js`：`REMUX_LIMIT_BYTES = 120MB`，超限拆「视频轨 + 音频轨」两个文件，注释写明「整文件读入内存，峰值≈2×体积，300MB 会 OOM」 |
| 安卓端不是原生重写，而是 Capacitor + 同一套 JS | APK 内 `assets/public/core/platform-capacitor.js`；WebView fetch 优先，CORS/自定义头失败退回原生 HTTP，且**用 Range 8MB 分片**（整包 base64 会把 49MB 撑成 66MB 直接 OOM） |

### 与我们现有实现的差异

| 维度 | MediaGrabber | VDACC（当前） |
|---|---|---|
| 引擎 | 自带 JS core（含自己的 http/下载层） | TypeScript 引擎 ~2,500 行，依赖 `node:fs/path/crypto/child_process/async_hooks` |
| 合并 | JS remux，120MB 上限 | ffmpeg 子进程（桌面） |
| 音乐标签 | 自有实现 | ffmpeg + 封面缩放 |
| UI | 单页 app.js | Vue 3 已拆 i18n/api/format/jobs/overlays |
| 后台 | WebView 页面（有被系统冻结风险） | 不涉及 |

---

## 3. 架构总览（Android）

```
┌──────────────────────────── App 进程 ────────────────────────────┐
│  MainActivity (Kotlin)                                           │
│   ├─ WebView  ← assets/ui/（复用 web/vue，注入 local-api.js）      │
│   │      ↕ window.VDACC_BRIDGE（@JavascriptInterface，JSON+reqId） │
│   ├─ Bridge (Kotlin)                                             │
│   │    fs / transfer / crypto / paths / notify / media           │
│   ├─ DownloadService (foreground, 通知栏进度)                     │
│   └─ MediaPipeline (Media3 Transformer / jaudiotagger)            │
└──────────────────────────────────────────────────────────────────┘
```

要点：

- **UI 不用重写**：`web/vue` 已经拆出 `api.js`，端上把它替换成 `local-api.js`，把原来的 `/api/*` 调用映射到 `window.VDACC_ENGINE.*`；
- **引擎不进主线程**：JS 引擎跑在 WebView 的独立 world（或专用 WebView），下载字节由原生 `transfer` 负责，JS 只算 URL、进度、命名；
- **前台服务持有下载**：WebView 只做控制面，页面被杀也不影响下载；完成后从通知点回 App；
- **不引入 Capacitor**：现有壳是零依赖 Java WebView，继续用 `@JavascriptInterface` 即可；Capacitor 只是参考它的 Range 分片策略。

---

## 4. 模块划分

| 模块 | 职责 | 关键文件 |
|---|---|---|
| `engine` | 解析、档位、命名、进度聚合、任务状态机（纯 JS，无 Node API） | `ts/src/engines/*`、`ts/src/core/{naming,platform,album,dest,rate,progress,jobmatch}.ts` |
| `engine-shim` | `node:fs/path/crypto/async_hooks/os` 的浏览器实现，走 bridge | `mobile/android/engine/shims/*` |
| `bridge` | 16+ 个原生能力方法，统一 `{reqId, method, payload}` 协议 | `app/src/main/java/com/vdacc/app/bridge/*` |
| `transfer` | 原生下载器：Range/断点/限速/取消/进度回调 | `bridge/Transfer.kt`、`service/DownloadService.kt` |
| `media` | DASH 合并、封面/标签、体积阈值决策 | `media/Muxer.kt`、`media/Tagger.kt` |
| `store` | 任务持久化（JSON）、输出目录、SAF 权限 | `store/JobStore.kt` |
| `ui` | 复用 Vue 页面 + `local-api.js` 适配 | `assets/ui/*`（构建产物） |

---

## 5. 桥接口（草案）

协议：JS 调 `window.VDACC_BRIDGE.call(method, payloadJson)` 返回 `reqId`；原生完成后 `evaluateJavascript("__VDACC_BRIDGE_RESOLVE__('reqId', json)")`。只对 `file:///android_asset/` 授权（对齐参考实现的 `PERMISSION` 思路）。

| 方法 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `fs.stat` / `fs.mkdirp` / `fs.remove` / `fs.rename` / `fs.list` | 路径 | 元数据 | 走 app 私有目录或 SAF 映射 |
| `fs.openWrite` / `fs.writeChunk` / `fs.closeWrite` | 路径、base64/ArrayBuffer | bytes | 分块写，避免整文件进内存 |
| `fs.readChunk` | 路径、offset、len | base64 | 续传/校验用 |
| `transfer.start` | `{url, headers, dest, resume, limitBytesPerSec}` | `{id}` | 原生 OkHttp 流式写盘 |
| `transfer.cancel` | `{id}` | ok | 立即停 |
| `transfer.progress` | — | 事件 | 每 300ms 推一次（`onProgress`） |
| `crypto.md5Hex` / `crypto.aes128Cbc` | bytes/key/iv | bytes | B站 wbi、抖音签名、酷狗 md5 |
| `paths` | — | `{tmp, out, cache}` | 与桌面 `outDir` 语义对齐 |
| `media.mux` | `{video, audio, out, title}` | `{path, bytes}` | Media3 Transformer |
| `media.tag` | `{path, tags, cover}` | warnings | jaudiotagger |
| `notify.update` | `{id, title, percent}` | ok | 通知栏 |
| `openFile` / `shareFile` | 路径 | ok | 完成后打开/分享 |

> 关键取舍：**下载字节不走 JS**。参考实现用 Range 8MB 分片 + base64 回传是为了兼容 CapacitorHttp；我们直接原生 OkHttp 写文件，内存占用与文件大小无关。

---

## 6. Media3 方案

| 场景 | 方案 | 备注 |
|---|---|---|
| B站 DASH 视频+音频 | `Transformer` + `EditedMediaItemSequence`（video + audio） | 输出 MP4；失败时保留两轨（与桌面「合并失败保留分离流」一致） |
| 纯视频（抖音） | 直接落盘，不转码 | 避免无谓 CPU |
| 音乐 mp3/m4a/flac | 原样落盘 + `jaudiotagger` 写 ID3/Vorbis | 封面 ≤800px，沿用桌面规则 |
| 大文件（>150MB） | **不合并**，输出 `_视频.mp4` + `_音频.m4a`，提示原因 | 参考实现是 120MB；我们取 150MB（Media3 是流式，不整文件入内存） |
| HLS | M5 评估：Media3 `HlsPlaylistParser` 拉分片 + Muxer 拼接 | MVP 不做 |

体积与内存：Media3 是流式处理，峰值 ≈ 缓冲区；仍需在 2GB 内存机型上实测 500MB 文件。

---

## 7. 目录结构（新增）

```
mobile/android/
├─ app/src/main/
│  ├─ java/com/vdacc/app/
│  │  ├─ MainActivity.kt              # 现有 MainActivity.java 迁移/扩展
│  │  ├─ bridge/Bridge.kt             # @JavascriptInterface 入口
│  │  ├─ bridge/Transfer.kt           # OkHttp 下载器
│  │  ├─ bridge/Fs.kt                 # 私有目录 + SAF
│  │  ├─ service/DownloadService.kt   # 前台服务 + 通知
│  │  ├─ media/Muxer.kt               # Media3 Transformer
│  │  ├─ media/Tagger.kt              # jaudiotagger
│  │  └─ store/JobStore.kt
│  ├─ assets/
│  │  ├─ ui/                          # web/vue 构建产物（i18n/api/format/jobs/overlays）
│  │  └─ engine/engine.bundle.js      # esbuild 打平的 TS 引擎
│  └─ res/…
├─ engine/                            # 引擎构建工程（esbuild 配置 + shims）
└─ README.md
```

构建链：`bun build ts/src/mobile/entry.ts --target=browser --outfile .../engine.bundle.js`；shims 通过 alias 注入。

---

## 8. M1 最小可运行清单（验收即完成）

- [ ] 安装后打开就是现有 Vue 界面（无服务端，`local-api.js` 接管数据）；
- [ ] 粘贴**整段抖音分享文案** → 解析出标题/封面/档位；
- [ ] 选 1080P → 下载 → 系统「下载/VDACC」里能看到文件；
- [ ] 下载中通知栏显示进度，锁屏 30 秒后回来进度仍在走；
- [ ] 取消能立即停，重试从 `.part` 续传；
- [ ] B站 一个分P视频：视频+音频合并成功（或超限时拆轨并提示）；
- [ ] 网易云一首歌：落 mp3，标签/封面正确；
- [ ] 断网 → 任务失败并显示原因；恢复后重试成功；
- [ ] 进程被杀后重开：历史任务在，未完成的标「上次中断」；
- [ ] APK ≤ 15MB（不含用户数据），冷启动 ≤ 2s。

---

## 9. 复用 / 重写矩阵

| 现有代码 | 处理 | 说明 |
|---|---|---|
| `core/naming` `platform` `errors` `types` `album` `jobmatch` `dest` | **直接复用** | 纯函数，无 Node 依赖 |
| `core/rate` | **改** | 基于时间片计算，改为 bridge 侧限速（OkHttp 读速） |
| `core/progress` | **改** | 事件改为 bridge `transfer.progress` 驱动 |
| `core/operation`（AsyncLocalStorage） | **重写 shim** | 单线程栈即可，不需要 ALS |
| `core/http`（CookieJar/request） | **改** | 底层走 `bridge.transfer` / `bridge.http`，保留 Cookie/Referer/重试 |
| `engines/bilibili_api` | **复用 90%** | 签名是纯 TS（wbi + digest），无 playwright；ffmpeg 调用改 `media.mux` |
| `engines/douyin` | **复用 90%** | 签名在 TS 内计算，不依赖 `node:vm`；分享文案抽取已有 |
| `engines/netease/qq/kuwo/kugou` | **复用 85%** | 下载与 tag 改 bridge；`music.ts` 直接复用 |
| `engines/sniff` | **暂缓** | HLS 依赖 ffmpeg，M5 再评估 |
| `engines/generic`（yt-dlp）、`bilibili.ts`（旧 yt-dlp 路径） | **不移植** | 端上无 Python |
| `core/ffmpeg.ts` `core/doctor.ts` `core/auth.ts`（playwright） | **不移植** | 桌面专属 |
| `web/vue/*` | **复用** | 只需替换 `api.js` 为 `local-api.js`，隐藏「组件/账号/诊断」等服务端功能 |
| `ts/src/server.ts` `cli.ts` `skill_cli.ts` | **不移植** | 桌面/Skill 保留 |

---

## 10. 里程碑与工时

| 里程碑 | 内容 | 估时 |
|---|---|---|
| M0 | 桥骨架 + 引擎打包 + 空 UI 跑通（`health` 由本地伪造） | 3–4 天 |
| M1 | 抖音单文件 + 网易云 + 前台下载 + 取消/续传（§8 清单） | 1 周 |
| M2 | B站（分P/字幕/弹幕）+ Media3 合并 + 超限拆轨 | 1 周 |
| M3 | QQ/酷我/酷狗 + 标签/封面 | 4–5 天 |
| M4 | 分享入口、通知、SAF 选目录、任务历史 | 3–4 天 |
| M5 | 稳定性：弱网/被杀/低内存机、HLS 评估 | 1 周 |
| M6 | 尝试绕过或者伪造会员认证下载付费内容 | 3天 |

合计约 **5–6 周**（单人、按现有节奏）。

---

## 11. 风险与取舍

| 风险 | 影响 | 对策 |
|---|---|---|
| 平台签名/风控变更 | 解析失效，需发版 | 引擎与 UI 分离，支持「引擎热更新」（下载新 bundle 并校验 SHA256） |
| WebView 内存 | 大文件合并 OOM | 原生流式 + 超限拆轨 + 低内存机型实测 |
| 后台被冻结 | 下载中断 | 前台服务 + WakeLock + 通知；不做「后台静默」 |
| 端上包体 | 下载安装门槛 | 引擎 bundle gzip 后 ~300KB；不打包 ffmpeg |
| 双端行为漂移 | 同一链接两端结果不同 | 共用引擎源码 + 共用命名/档位规则 + 共用测试样例 |

---

## 12. 测试计划

1. **引擎单测**：现有 101 个用例中，纯函数部分（naming/platform/album/jobmatch/dest/rate）直接复用；bridge 相关用 fake bridge；
2. **契约测试**：同一批链接，桌面 CLI 与端上引擎输出的 `{title, formats[], dest}` 必须一致（golden 文件）；
3. **验收脚本**：`adb` 驱动（安装 → 分享文案 → 下载 → `content query` 查文件 → 截图）。

---

## 13. 待你确认

1. **minSdk**：建议 26（Android 8），覆盖前台服务与 Media3；
2. **输出位置**：默认 `Download/VDACC`，是否要支持 SAF 自选目录（增加适配量）；
3. **UI**：直接复用现有 Vue 页面（推荐），还是为手机做一套更紧凑的布局；
4. **应用身份**：沿用 `com.vdacc.app`，与现有壳同一个包名（可覆盖安装）；
5. **是否接受**「超过 150MB 不合并、拆成两轨」的行为（与参考实现一致）。

---

## 14. 下一步

先做 **M0 技术验证**（不写业务）：把 `core/naming` + 一个最小引擎（如酷我取 URL）打包进 WebView，经 bridge 写一个文件到 `Download/VDACC`，验证「JS 引擎 + Kotlin 桥 + 前台服务」这条链能在真机跑通。M0 通过后再进 M1。
