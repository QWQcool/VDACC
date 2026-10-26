# VDACC 移动壳（Android）

极薄的 WebView 壳：手机上只负责显示界面，解析与下载都在电脑端的 `ts/src/server.ts` 里跑。

## 一、电脑端准备

```bash
bun ts/src/server.ts --port 8765 --token <随便一串> --lan
```

`--lan` 会绑定 `0.0.0.0`，并把可用的局域网地址打印出来，例如：

```
⚠️  --lan：服务已绑定 0.0.0.0，同一局域网内的设备都能访问（仍需 token）。
手机访问: http://192.168.1.23:8765/?token=xxxx
```

首次运行 Windows 可能弹防火墙授权，要允许「专用网络」，否则手机连不上。

## 二、手机端

安装 `app-debug.apk`（构建产物在 `app/build/outputs/apk/debug/`），打开后把上面那条
`http://<电脑IP>:8765/?token=...` 粘进地址栏，点「连接」。地址会存下来，下次打开自动加载。

- 需要手机和电脑在**同一个 Wi-Fi**；
- 只支持 `http://`（服务端没上 TLS），所以 `usesCleartextTraffic=true`；
- 界面里所有操作（解析、下载、预览、设置）都走回电脑，手机只当屏幕。

## 三、联调接口（留给自测/自动化）

地址可以不带界面手输，直接由启动参数带进去：

```bat
adb install -r mobile\android\app\build\outputs\apk\debug\app-debug.apk
adb shell am start -n com.vdacc.app/.MainActivity -e url "http://192.168.1.23:8765/?token=xxx"
adb exec-out screencap -p > shot.png
```

`-e url` 会填进地址栏并立即加载；不传则用上次保存的地址。当前 APK **没有在这个开发机上安装过**
（连接的那台是别人的手机），等正式测试机接上再走上面三步。

## 四、自己构建

```bat
set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot
set ANDROID_HOME=%LOCALAPPDATA%\vdacc-tools\android-sdk
%LOCALAPPDATA%\vdacc-tools\gradle-8.7\bin\gradle.bat -p mobile\android assembleDebug
```

工具链（本机已装，均不入库；2026-10-24 实装并验证）：

| 组件 | 版本 | 位置 | 安装方式 |
|---|---|---|---|
| JDK 17（Temurin） | 17.0.20.1 | `C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot` | `winget install EclipseAdoptium.Temurin.17.JDK` |
| Android SDK | platform-tools / platform-34 / build-tools 34.0.0 | `%LOCALAPPDATA%\vdacc-tools\android-sdk` | cmdline-tools + `sdkmanager` |
| Gradle | 8.7 | `%LOCALAPPDATA%\vdacc-tools\gradle-8.7` | zip；**用腾讯镜像**（`https://mirrors.cloud.tencent.com/gradle/`，12s）而不是官方源（超时） |

换机复现：

```bat
winget install EclipseAdoptium.Temurin.17.JDK

rem 下载 commandlinetools-win-*_latest.zip，解压到 android-sdk 后必须再套一层
rem cmdline-tools 目录，最终是 android-sdk\cmdline-tools\latest\bin\sdkmanager.bat
rem （少了这层 sdkmanager 会找不到自己的 SDK 根）
%LOCALAPPDATA%\vdacc-tools\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat ^
  --sdk_root=%LOCALAPPDATA%\vdacc-tools\android-sdk ^
  --licenses
%LOCALAPPDATA%\vdacc-tools\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat ^
  --sdk_root=%LOCALAPPDATA%\vdacc-tools\android-sdk ^
  "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

实测构建：`BUILD SUCCESSFUL in 2m 43s`（首次含 AGP 8.5.2 下载），产物
`app/build/outputs/apk/debug/app-debug.apk` **9.2KB**。

## 五、真机验收记录（2026-10-26）

设备：realme `RMX5200`，Android 16（SDK 36），USB 调试已授权。

| 项 | 结果 |
|---|---|
| 安装 | `adb install -r` 报 `Failure [-99]`（realme 限制流式安装）；改用 `adb push` + `adb shell pm install -r -t` **成功** |
| 连接 | `adb reverse tcp:8765 tcp:8765` → 手机打开 `http://127.0.0.1:8765/?token=...`，V2 界面正常渲染 |
| 解析 | 抖音 `7698929587975146788`：封面、标题、时长 0:42、`douyin` 标签、画质档位均正常 |
| 下载 | 1080P → job `完成`，5.34 MB（5,596,795 字节），SSE 实时出现在「进行中」 |
| 预览 | 点 ▶ 在 WebView 内播放，画面正常 |
| 取消 | 限速 256KB/s 后取消：`已取消` + 「用户取消」+ 进度冻结 35.1% |
| 重试 | 点重试重新入队，从 `.part` 续传（35.1% → 37.6%），未从零重下 |
| 错误 token | 顶栏变「未连接」，页面提示「缺少 token：请用启动时打印的 ?token=... 打开」 |
| 电脑离线 | WebView 显示 Chromium 默认错误页（`ERR_EMPTY_RESPONSE`）；服务恢复后点「连接」即可恢复 |
| 切前后台 | 回前台会重新加载页面（解析结果清空），任务列表由服务端恢复（12 条） |

局域网路径本轮**未打通**（按用户要求没有加防火墙规则）：手机 Wi-Fi `30.29.200.41/24`、
电脑以太网 `30.29.97.48/24` 不同网段，PC→手机可通、手机→PC 不通。真机验收走的是 USB 反向代理。

已知待改进：长文案标题会撑满卡片（已加 3 行截断）、电脑离线时的错误页是浏览器默认样式、
「缺少 token」没有区分「没带 token」与「token 无效」。

## 不做的部分

- 不在手机上跑 ffmpeg / 解析引擎：那需要打包整套运行时，体积和权限都不合适；
- 不做后台下载/通知：任务在电脑上跑，手机锁屏也不影响；
- HarmonyOS NEXT（HAP）等拿到华为开发者账号再做。
