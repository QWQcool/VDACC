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
set JAVA_HOME=%LOCALAPPDATA%\vdacc-tools\jdk17
set ANDROID_HOME=%LOCALAPPDATA%\vdacc-tools\android-sdk
%LOCALAPPDATA%\vdacc-tools\gradle-8.7\bin\gradle.bat -p mobile\android assembleDebug
```

工具链（本机已装，均不入库）：

| 组件 | 位置 |
|---|---|
| JDK 17（Temurin） | `%LOCALAPPDATA%\vdacc-tools\jdk17` |
| Android SDK（platform 34 / build-tools 34.0.0） | `%LOCALAPPDATA%\vdacc-tools\android-sdk` |
| Gradle 8.7 | `%LOCALAPPDATA%\vdacc-tools\gradle-8.7` |

## 不做的部分

- 不在手机上跑 ffmpeg / 解析引擎：那需要打包整套运行时，体积和权限都不合适；
- 不做后台下载/通知：任务在电脑上跑，手机锁屏也不影响；
- HarmonyOS NEXT（HAP）等拿到华为开发者账号再做。
