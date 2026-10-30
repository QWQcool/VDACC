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

### 2.1 M0 实测结论（2026-10-27，realme RMX5200 / Android 16）

| 结论 | 证据 |
|---|---|
| 参考实现「md5 必须纯 JS」在 Android 上同样成立 | `node:crypto` 的 `createHash` 是同步 API，桥是异步；M0 用纯 JS MD5，并与原生 `MessageDigest` 交叉校验一致 |
| 鸿蒙的 `urlPermissionList` 在 Android 没有等价物 | `@JavascriptInterface` 由**渲染线程直调**，`onPageStarted` 记标志会漏（真机实测 `paths` 被误判 untrusted）；改为每次调用在 UI 线程读 `web.url` |
| 鸿蒙只能写沙箱，Android 可以进公共 Download | 鸿蒙映射 `${filesDir}/mg-out`；Android 走 `MediaStore.Downloads` + `RELATIVE_PATH`，但同时需要 staging 承接 `.part` 续传 |
| 引擎 bundle 体积远小于预估 | M0 只打纯函数：8.5KB（gzip 4.6KB）；APK 846KB |
| 分块写必须验到多块 | 141 字节的探针只走 1 块，等于没验分块；默认探针改成 ~52KB / 4 块，md5 与设备 `md5sum` 完全一致 |

---

## 3. 架构总览（Android）

```
┌──────────────────────────── App 进程 ────────────────────────────┐
│  MainActivity (Java)                                             │
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
- **不引入 Capacitor**：现有壳是零运行时依赖的 WebView，继续用 `@JavascriptInterface` 即可；Capacitor 只是参考它的 Range 分片策略。
  桥用 Kotlin（语言插件，非运行时框架），依赖清单仍为空。

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
| `fs.openWrite` / `fs.writeChunk` / `fs.closeWrite` | 文件名、base64 | `{handle}` / bytes / `{bytes,path}` | 分块写，避免整文件进内存；落**私有 staging 的 `.part`** |
| `fs.publish` | 文件名 | `{path, name, outKind, bytes}` | 把 `.part` 落进 `Download/VDACC`（29+ 走 MediaStore，26–28 走 File+权限） |
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
│  │  ├─ MainActivity.java            # 壳（本地引擎 / 连电脑 两种模式）
│  │  ├─ bridge/Bridge.kt             # ✅ M0：@JavascriptInterface 入口
│  │  ├─ bridge/Fs.kt                 # ✅ M0：staging 分块写 + publish
│  │  ├─ bridge/Paths.kt              # ✅ M0：staging / out / cache 语义
│  │  ├─ bridge/BridgeException.kt    # ✅ M0：带错误码的异常
│  │  ├─ bridge/Transfer.kt           # M1：OkHttp 下载器
│  │  ├─ service/DownloadService.kt   # M1：前台服务 + 通知
│  │  ├─ media/Muxer.kt               # M2：Media3 Transformer
│  │  ├─ media/Tagger.kt              # M3：jaudiotagger
│  │  └─ store/JobStore.kt            # M4
│  ├─ assets/
│  │  ├─ ui/m0.html                   # ✅ M0 验证页（M1 换成 Vue 产物）
│  │  └─ engine/engine.bundle.js      # ✅ 构建产物（入库，便于直接打 APK）
│  └─ res/…
├─ engine/                            # ✅ 引擎构建工程
│  ├─ build.mjs                       #   Bun.build：target=browser / format=iife / node:* → shims
│  ├─ selftest.mjs                    #   无设备自检（含内存假 fs）
│  ├─ src/entry.ts                    #   端上入口，挂 globalThis.VDACC_ENGINE
│  └─ shims/{bridge,path,crypto,md5}.ts
└─ README.md
```

构建链：`bun mobile/android/engine/build.mjs` → `app/src/main/assets/engine/engine.bundle.js`。
`node:*` 通过 Bun.build 插件映射到 `engine/shims/*`，**未映射的模块直接构建失败**（不静默降级）。
入口刻意放在 `engine/src/entry.ts` 而不是 `ts/src/mobile/`：`ts/**` 保持零改动，桌面端回归风险为 0。

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
| M0 | ✅ **已完成（2026-10-27）**：引擎 bundle（Bun.build，iife，8.5KB/gzip 4.6KB）+ Kotlin 桥（paths/md5/fs 分块写/publish）+ 真机验证页 | 3–4 天 |
| M1 | ✅ **已完成（2026-10-29）**：抖音单文件（M1-b/c）、Vue 产品界面直上端（M1-d）、网易云 + 端上 ID3/Vorbis 标签与封面（M1-e，桥补 `publish:false`/`fs.readHead`/`fs.rewrite`）。**未做**：进程被杀后的自动续传（手动「重试」会从 `.part` 续传）、专辑批量、端上登录 | 1 周 |
| M2 | ✅ **已完成（2026-10-30）**：B站两轨 + 合并 + 超限拆轨 + 弹幕。合并用 framework `MediaExtractor`/`MediaMuxer` 而非 Media3（纯封装不需要解码，依赖清单仍为空；代价是不写 `ctts`，见 `mobile/android/README.md` 的对拍证据与已知差异）。字幕因端上无登录拿不到，如实提示 | 1 周 |
| M3 | ✅ **已完成（2026-10-30）**：酷我/酷狗/QQ 三引擎 + 端上标签（mp3 ID3v2.3 / flac Vorbis+PICTURE）；m4a 明确不写（会毁文件）；QQ 匿名只有 128K/96K，未放行档带真实 `result` | 4–5 天 |
| M4 | ✅ **已完成（2026-10-30）**：分享入口（`text/plain` → `?url=` 深链）、完成通知（JS 在 publish 后触发）、SAF 自选目录（持久授权，写失败回退 MediaStore 并透出原因）。任务历史自 M1-d 起在 `localStorage` | 3–4 天 |
| M5 | ✅ **已完成（2026-10-30）**：被杀后自动续传（上限 2 次）、修 416（完整 `.part` 被续传拒）、断网归类 `ENET` 且恢复后重试成功、内存不随文件增长；HLS 评估结论=**不移植**（需 playlist 解析 + AES-128 + 跨分片时间戳重排，属独立里程碑） | 1 周 |
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

## 13. 已确认决策（2026-10-27）

| # | 项 | 结论 |
|---|---|---|
| 1 | **minSdk** | **26**（`build.gradle` 已改；API 24–25 放弃） |
| 2 | **输出位置** | 默认 `Download/VDACC`；**落盘分两段**：私有 `files/staging/<name>.part` → `fs.publish` 进 MediaStore。SAF 自选目录推迟到 M4 |
| 3 | **UI** | 复用现有 Web 界面（M0 用独立验证页，M1 接 Vue） |
| 4 | **应用身份** | 沿用 `com.vdacc.app`（与现有壳同包名，可覆盖安装） |
| 5 | 150MB 拆轨 | 接受（与参考实现同向，阈值改 150MB） |
| 6 | **桥的语言** | **Kotlin**（2.0.21 语言插件；无 AndroidX/OkHttp/Room，运行时依赖仍为空）。理由是空安全 + 少样板，代价是首次构建联网下载约 50MB 插件 |

> 关于「能不能用 TS / Go / C++ 写桥」：Android 组件（Activity/Service）必须由 dex 里的 JVM 类实例化，
> WebView 也没有 NDK 绑定，`@JavascriptInterface` 只接受 JVM 对象。native（C++/Go/Rust）只能作为
> JNI 背后的库，替代不了这层壳；`nodejs-mobile` 可行但要把整个 Node 塞进 APK，而我们已经有 WebView
> 在跑 JS，属于重复投入。结论：**引擎是 TS，桥是宿主原生语言**。

---

## 14. 下一步

先做 **M0 技术验证**（不写业务）：把 `core/naming` + 一个最小引擎（如酷我取 URL）打包进 WebView，经 bridge 写一个文件到 `Download/VDACC`，验证「JS 引擎 + Kotlin 桥 + 前台服务」这条链能在真机跑通。M0 通过后再进 M1。
