# VDACC 移动端（Android）

同一个 APK 里有两种模式，右下角按钮切换：

| 模式 | 说明 | 数据在哪 |
|---|---|---|
| **本地引擎**（默认，M0 起） | 加载 `file:///android_asset/ui/*.html`，TS 引擎打成 bundle 跑在 WebView 里，文件直接落手机 | 手机本地 |
| **连电脑** | 加载电脑上的 `http://<IP>:8765/?token=...`，解析与下载都在 PC 上跑 | 电脑 |

本地引擎模式是 M0 的技术验证页（自检 + 落盘探针），产品界面从 M1 开始接。
连电脑模式的用法与验收记录见文末，两者互不影响。

## 一、构建

构建分两步：**先打引擎 bundle，再打 APK**。引擎产物在仓库里有一份（`app/src/main/assets/engine/engine.bundle.js`），
改了 `ts/src/core/*` 或 `mobile/android/engine/*` 之后必须重新打，否则装进 APK 的是旧引擎。

```bat
rem 1) 引擎 bundle（Bun 自带 bundler，无第三方依赖）
cd mobile\android\engine
bun build.mjs
bun selftest.mjs          rem 无设备自检：15 条纯函数/桥断言 + 8 条落盘探针断言

rem 2) APK
set JAVA_HOME=%LOCALAPPDATA%\vdacc-tools\jdk17
set ANDROID_HOME=%LOCALAPPDATA%\vdacc-tools\android-sdk
%LOCALAPPDATA%\vdacc-tools\gradle-8.7\bin\gradle.bat -p mobile\android assembleDebug
```

产物：`mobile/android/app/build/outputs/apk/debug/app-debug.apk`（M0 实测约 830 KB）。

工具链（本机已装，均不入库）：

| 组件 | 版本 | 位置 |
|---|---|---|
| JDK 17（Temurin） | 17.0.20.1 | `%LOCALAPPDATA%\vdacc-tools\jdk17` |
| Android SDK | platform-tools / platform-34 / build-tools 34.0.0 | `%LOCALAPPDATA%\vdacc-tools\android-sdk` |
| Gradle | 8.7 | `%LOCALAPPDATA%\vdacc-tools\gradle-8.7`（用腾讯镜像下载，官方源超时） |
| Kotlin 插件 | 2.0.21 | Gradle 首次构建联网下载（约 50MB），之后走缓存 |

> `JAVA_HOME` 必须指向**一个真实的 JDK 目录**。历史上这里写过
> `C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot`，本机已不存在，按上表为准。

## 二、M0 验收（真机）

```bat
set ADB=%LOCALAPPDATA%\vdacc-tools\android-sdk\platform-tools\adb.exe

rem 安装（realme/OPPO 上直接 install -r 可能报 Failure [-99]，用下面这条更稳）
%ADB% install -r mobile\android\app\build\outputs\apk\debug\app-debug.apk

rem 打开 App（默认就是本地引擎模式）；-e probe 1 自动跑落盘探针，-e probe net 自动跑网络探针
%ADB% shell am start -n com.vdacc.app/.MainActivity -e probe 1
%ADB% shell am start -n com.vdacc.app/.MainActivity -e probe net

rem 看结果
%ADB% shell ls -l /sdcard/Download/VDACC/
%ADB% shell md5sum /sdcard/Download/VDACC/m0-probe.txt
%ADB% exec-out screencap -p > shot.png
```

2026-10-27 实测（realme RMX5200 / Android 16 / API 36）：

| 项 | 结果 |
|---|---|
| `assembleDebug` | BUILD SUCCESSFUL，APK 846,793 字节 |
| 引擎自检 | 15/15 通过（含「JS 纯 JS MD5」与「桥 MessageDigest MD5」对同一中文串一致） |
| 落盘探针 | 4 个 16KB 分块 → 53,131 字节 → `Download/VDACC/m0-probe.txt` |
| 一致性 | 页面显示的 md5 与设备 `md5sum` **完全相同**（`0e7a2690…`） |
| 暂存清理 | publish 成功后 `.part` 已删除（`files/staging/` 为空） |
| 局域网模式 | 回归通过：`adb reverse` + `-e url http://127.0.0.1:8765/?token=...`，桌面界面正常、可切回本地 |

2026-10-28 M1-a 实测（同机同版本）：网络探针 `-e probe net` → HTTP **200**、`ttwid 已拿到`、
响应 69 字节、**190 ms（走桥）**——一次覆盖 POST + JSON body + 多值 `Set-Cookie` 解析；
落盘探针回归仍是 4 分块 / 53,132 字节，页面 md5 与设备 `md5sum` 一致。

## 三、桥与目录（M0 已实现的部分）

```
app/src/main/java/com/vdacc/app/
├─ MainActivity.java          两种模式的壳（本地 / 连电脑）
└─ bridge/
   ├─ Bridge.kt               @JavascriptInterface 入口：同步 post + 异步回投
   ├─ Fs.kt                   staging 分块写 + publish 到 Download/VDACC
   ├─ Paths.kt                目录语义（staging / out / cache）
   └─ BridgeException.kt      带错误码的异常
```

已实现的桥方法：`paths`、`crypto.md5Hex`、`http.request`、`fs.openWrite`、`fs.writeChunk`、
`fs.closeWrite`、`fs.publish`、`fs.stat`、`fs.mkdirp`。通道与字段形状见
`docs/design/android-standalone-plan.md` §5。

`http.request` 是 M1-a 加的：页面在 `file:///android_asset/` 下是不透明来源，
直接 `fetch('https://www.douyin.com/...')` 会被 CORS 拒（对方不会给我们
`Access-Control-Allow-Origin`）。所以端上把全局 `fetch` 换成走桥的实现
（`engine/shims/fetch.ts`），引擎源码一行不用改。返回字段：
`{status, url, headers, setCookie[], bodyBase64, bytes}`；`setCookie` 单独给数组，
否则多条 cookie 会被合成一条、只解析到第一条。上限 24MB —— **媒体必须走 `transfer.*` 流式写盘**。

两条硬约束（写新方法前必须知道）：

1. **写文件分两段**：先写私有 `files/staging/<name>.part`，完成后 `fs.publish` 才落到公共
   `Download/VDACC`。Android 10+ 直接 `File` 写公共目录会失败，必须走 MediaStore；
   而 MediaStore 条目没法按偏移续写，所以 `.part` 只能留在私有目录。
2. **桥只信任本地 asset 页面**：Android 的 `@JavascriptInterface` 没有来源白名单，
   `Bridge` 每次调用都在 UI 线程读 `web.url` 判断前缀。远程页面（连电脑模式）调用一律拒绝。

## 四、连电脑模式（原有用法，最小要求不变）

```bash
bun ts/src/server.ts --port 8765 --token <随便一串> --lan
```

`--lan` 会绑 `0.0.0.0` 并打印可用的局域网地址；首次运行 Windows 可能弹防火墙授权，
要允许「专用网络」。手机与电脑需在同一 Wi-Fi；服务端是 `http://`，所以 `usesCleartextTraffic=true`。

USB 联调（不需要同网段）：

```bat
%ADB% reverse tcp:8765 tcp:8765
%ADB% shell am start -n com.vdacc.app/.MainActivity -e url "http://127.0.0.1:8765/?token=xxx"
```

不带 `-e url` 启动就是本地引擎模式；进入连电脑模式后地址会存在 App 里，下次切过去自动加载。

## 五、历史验收记录（2026-10-26，连电脑模式）

设备：realme `RMX5200`，Android 16（SDK 36），USB 调试已授权。

| 项 | 结果 |
|---|---|
| 安装 | `adb install -r` 报 `Failure [-99]`（realme 限制流式安装）；改用 `adb push` + `adb shell pm install -r -t` **成功** |
| 连接 | `adb reverse tcp:8765 tcp:8765` → `http://127.0.0.1:8765/?token=...`，V2 界面正常渲染 |
| 解析 | 抖音 `7698929587975146788`：封面、标题、时长 0:42、`douyin` 标签、画质档位均正常 |
| 下载 | 1080P → job `完成`，5.34 MB（5,596,795 字节），SSE 实时出现在「进行中」 |
| 预览 | 点 ▶ 在 WebView 内播放，画面正常 |
| 取消 | 限速 256KB/s 后取消：`已取消` + 「用户取消」+ 进度冻结 35.1% |
| 重试 | 点重试重新入队，从 `.part` 续传（35.1% → 37.6%），未从零重下 |
| 错误 token | 顶栏变「未连接」，页面提示「缺少 token：请用启动时打印的 ?token=... 打开」 |
| 电脑离线 | 壳子自己的错误页（说明 + 错误码 + 重试），不再是 Chromium 默认页 |
| 切前后台 | 回前台会重新加载页面（解析结果清空），任务列表由服务端恢复 |

局域网路径本轮**未打通**（按要求没有加防火墙规则）：手机 Wi-Fi `30.29.200.41/24`、
电脑以太网 `30.29.97.48/24` 不同网段，PC→手机可通、手机→PC 不通。真机验收走的是 USB 反向代理。

## 不做的部分

- 不打包 ffmpeg、不在端上跑 yt-dlp（长尾站点仍归桌面端）；
- 不用 Capacitor / AndroidX：壳子是零运行时框架的 WebView（Kotlin 只是语言插件）；
- HarmonyOS NEXT（HAP）等拿到华为开发者账号再做。
