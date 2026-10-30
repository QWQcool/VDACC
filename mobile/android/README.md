# VDACC 移动端（Android）

同一个 APK 里有两种模式，右下角按钮切换：

| 模式 | 说明 | 数据在哪 |
|---|---|---|
| **本地引擎**（默认，M0 起） | 加载 `file:///android_asset/ui/*.html`，TS 引擎打成 bundle 跑在 WebView 里，文件直接落手机 | 手机本地 |
| **连电脑** | 加载电脑上的 `http://<IP>:8765/?token=...`，解析与下载都在 PC 上跑 | 电脑 |

本地引擎模式默认进产品界面（`web/vue` 产物 + `local-api.js` 顶掉 `api.js`）；
带 `-e probe xxx` 启动时进 M0/M1 验证页（自检 + 各条探针）。
连电脑模式的用法与验收记录见文末，两者互不影响。

## 一、构建

构建分两步：**先打引擎 bundle，再打 APK**。引擎产物在仓库里有一份（`app/src/main/assets/engine/engine.bundle.js`），
改了 `ts/src/core/*` 或 `mobile/android/engine/*` 之后必须重新打，否则装进 APK 的是旧引擎。

```bat
rem 1) 引擎 bundle（Bun 自带 bundler，无第三方依赖）
cd mobile\android\engine
bun build.mjs
bun selftest.mjs          rem 无设备自检：75 条纯函数/桥断言 + 8 条落盘 + 8 条标签写入

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

2026-10-28 M1-b 实测（`-e probe douyin`）：整段分享文案 → 标题 = 抖音原配文、封面「有」、
五个档位 `normal_1080_0 / adapt_lowest_4_1 / normal_720_0 / adapt_lowest_1440_1 / low_540_0`、
**473 ms**。档位集合与顺序和桌面端 `bun ts/src/cli.ts probe` 的输出**完全一致**——
同一份引擎源码跑在两个宿主上，这是契约一致的第一个真机证据。

引擎包体积随入口扩大：M0 8.5KB → M1-a 11.4KB → M1-b 21.1KB → M1-c1 **23.5KB**（gzip 11.1KB）。

2026-10-28 M1-c1 实测（`-e probe download` / `-e probe cancel`）：

| 项 | 结果 |
|---|---|
| 下载 | `Download/VDACC/7698929587975146788_…_1080P.mp4`，**5,596,795 字节**，与桌面端下的同一文件**逐字节同大小** |
| 产物校验 | 拉到电脑 `ffprobe`：42.03s / 1080×1440 / h264+aac，与桌面结果一致 |
| 进度 | 页面显示 `5.34 MB / 5.34 MB（100%）`，事件间隔 200ms |
| 续传 | 手工造 2,000,000 字节的 `.part` → 页面显示「续传起点 **1.91 MB（续传）**」→ 补全到 5,596,795，`.part` 被 publish 删除 |
| 取消 | 50MB 测速文件下 800ms 后取消：`已取消`、事件 `cancelled（809 ms）`、已写 20.15MB/50MB，`.part` 保留 22,392,827 字节 |

2026-10-28 M1-c2 实测（`-e probe slow`，100MB 限速 1MB/s）：

| 项 | 结果 |
|---|---|
| 前台服务 | 下载期间 `dumpsys activity services` 有 `DownloadService`；结束后自动停止（计数 0） |
| 通知栏 | 「speed-probe.bin　3.9 MB / 100.0 MB」+ 进度条（需要 POST_NOTIFICATIONS，`pm grant` 被 realme 拒绝，改由 App 首次启动弹窗授权） |
| **锁屏 30 秒** | 熄屏前已写 **19,437,038** 字节 → 亮屏后 **53,343,726** 字节，**30 秒内增长 33,906,688**（≈1.13 MB/s，与限速吻合） |
| 完成 | `Download/VDACC/speed-probe.bin` = **104,857,600** 字节，暂存 `.part` 已清，服务退出 |
| 限速 | 新增 `transfer.start` 的 `limitBytesPerSec`（原生按实际读速节流，设计稿 §9 的「限速移到 bridge」） |

至此 M1 的下载链路（抖音 1080P / 进度 / 取消 / 续传 / 前台服务 / 锁屏）全部有真机证据。

2026-10-28 M1-d 实测（默认启动，不带任何参数）：

| 项 | 结果 |
|---|---|
| 界面 | 直接就是 `web/vue` 的产品界面（标题「解析」+ 粘链接 + 档位 + 队列 + 运行状态），右上角「已连接」为绿 |
| 解析 | 粘 `https://www.douyin.com/video/7698929587975146788` → 封面 / 标题 / 作者 / 0:42 / 五个档位 |
| 下载 | 选 1080P → 「已提交 1/1」→ 队列卡片 `normal_1080_0 5.34 MB / 5.34 MB 100%` 标「完成」 |
| 产物 | `Download/VDACC/…_1080P.mp4` = 5,596,795 字节（与桌面端同一文件同大小） |
| 历史 | 杀掉进程重开，任务卡片还在（localStorage），上次没跑完的会标「上次中断」 |

界面代码**一行没改**：`web/vue/api.js` 换成了 `engine/ui/local-api.js`（同一层
`VDACC_API.request`），由 `engine/build-ui.mjs` 把 `web/vue` 搬到 `assets/ui/app/`
并把桌面用的绝对路径改成相对路径。未支持的接口（账号 / 组件 / 诊断 / 专辑 / 打开文件夹 /
预览）返回 `unsupported` 并显示原因，不假装成功。

顺带修了共享样式：抖音的 `adapt_lowest_*` 档位标签在窄屏会互相压字，
改为「档位 chip 给 96px 下限 + 换行 + 文本省略」（桌面 12 组布局回归仍全过）。

2026-10-29 M1-e 实测（网易云 + 端上写标签，引擎 `0.1.0-m1e`）：

| 项 | 结果 |
|---|---|
| 解析（m0 页） | `?probe=netease`：雨爱(钢琴版) / Ben George / `lossless 9.82 MB` + `standard 3.93 MB` |
| 解析（产品界面） | 粘 `https://music.163.com/song?id=2007983648` → 封面 / 标题 / 作者 / `netease` 徽章 / 4:17 / 两档 chips |
| 下载（产品界面） | 「下载选中 (1)」→ 任务卡 `2007983648_雨爱(钢琴版)_320K` 完成 9.85 MB / 9.85 MB 100% |
| **mp3 标签** | `ffprobe`：`title/artist/album` 正确 + `mjpeg 600x600` 封面，257.39 s / 129 kbps，`ffmpeg -f null` 解码通过 |
| **flac 标签** | 真机端到端探针（下面说明）：`ffprobe` 读出 `TITLE/ARTIST/ALBUM/DATE` + `mjpeg 600x600`，`fLaC` 仍可解码 |
| 歌词 sidecar | 该曲 `lyric` 为空（纯音乐），因此**没有** `.lrc` —— 这是正确行为，不是失败 |
| 引擎体积 | 21.1 KB → **38.6 KB（gzip 17.3 KB）**，自检 32/32 |

端上没有 ffmpeg，标签是**自己拼字节**：新增 `engine/src/audiometa.ts`（mp3 → ID3v2.3，
纯 ASCII 用 latin1、中文用 UTF-16；flac → 重建 metadata 块链，保留 STREAMINFO、
写入 VORBIS_COMMENT + PICTURE）。桥为此补了三个原语：

- `transfer.start` 新增 `publish:false`：下完先停在 staging，**补完标签再 publish**
  （否则用户会看到「先出现无标签文件、再被替换」，而 publish 会删掉 `.part`）；
- `fs.readHead`：读暂存文件头（上限 4 MB），mp3 要靠它认出旧 ID3 标签的长度以免叠加、
  flac 要靠它遍历块链算出音频帧起点；
- `fs.rewrite`：用「新前缀 + 原文件 [skip, EOF)」原子替换（临时文件 + rename，
  不会出现半截文件）。

**FLAC 分支怎么验的**：匿名网易云只给 mp3（实测热歌榜整批 `br=320000`），所以
产品流程暂时走不到 flac。用 `adb reverse tcp:8899 tcp:8899` + 电脑上的静态服务
提供真实样本，`?probe=tagflac` 走「下载 → 写标签 → publish」全链路，
拉回来 `ffprobe` 验标签与封面（`probe-flac.flac` 104,484 字节）。

**顺带修了一处「文件名撒谎」**（桌面端同源问题一起修）：网易云请求 `999000`（无损）档时，
接口可能返回 `br=320000 / type=mp3` 而**不报错**（实测免费曲 2007983648），
原实现照抄请求档位当标签，文件名会写着「无损 FLAC」而文件是 320K mp3。
现在按接口给的实际码率标注（`320K`）并给 warning「请求无损 FLAC 档，接口实际返回 320K」；
档位 id 仍是 `lossless`，显式指定它的调用不受影响。桌面端加了对应用例（测试 154 → 155）。

2026-10-30 M2 实测（B站：DASH 两轨 + 原生合并 + 拆轨 + 弹幕，引擎 `0.1.0-m1e` → 51.5 KB）：

| 项 | 结果 |
|---|---|
| 解析 | `BV1SknF6KE5g`：标题/作者正确、`4 个（当前 P1）`、档位 `bili-sd 852×480`；与桌面端同档位 id/标签一致（桌面登录态另有 `bili-1920/bili-1280`，端上匿名只到 480P，已如实警告） |
| 合并 | `…_P1_852×480.mp4` 25,227,500 字节：`ffprobe` 双轨（h264 852×480 228.29 s / aac 228.31 s，5479 视频帧 / 10702 音频帧） |
| 与 ffmpeg 对拍 | 同一视频桌面 `-c copy` 产物：抽取第 100/1000 帧解码 MD5 **完全相同**、`-ss 100` 与 `-ss 180` 取帧也完全相同、逐包 PTS 序列一致 |
| 拆轨（`maxMuxBytes:0`） | `.video.mp4` 20,229,955 + `.audio.m4a` 4,985,395 = 25,215,350，各自单轨可解码 |
| 弹幕 | `.danmaku.xml` 107,748 字节 / **1200 条**（与桌面端记录一致） |
| 字幕 | 匿名 `player/v2` 的 `subtitles` 为空（B站字幕要登录），界面提示「没有可用字幕，主文件已保留」 |

端上将 `media.mux` 做成一个桥原语（`Media.kt`）：`MediaExtractor` 读两条流、`MediaMuxer`
按时间戳交错写一个 mp4，**不解码不重编码**。三个坑写在代码注释里：codec-config 帧不能当样本写
（会得到打不开的文件）、`KEY_ROTATION` 要传给 muxer（否则成片方向错）、合并成功后才删分离流
（失败时它们是重试/拆轨的唯一来源）。

**为什么没用 Media3**（设计稿 §9 写的是它）：设计稿要的是「合并 + 超限拆轨」，而 framework
的 `MediaMuxer` 在 API 26 就有，能把依赖清单继续留空；Media3 的 Transformer 面向「加特效/转码」，
纯封装场景会白解码一遍。代价是 framework muxer 不写 `ctts` 表：产物 `r_frame_rate` 被读成 21
而不是 24、`ffmpeg -f null` 会给 685 条 DTS 告警——但逐帧解码结果、PTS 时间轴与 seek 都与
ffmpeg 产物一致，所以按「可用但样本表不完美」如实记录，而不是藏着。真机上出现播放异常时，
第一优先是换 `androidx.media3:media3-muxer`（对外只有 `media.mux` 一个方法，替换面很小）。

**顺带修了一个真 bug**：B站弹幕接口 `x/v1/dm/list.so` 返回 `Content-Encoding: deflate`，
而桥的 `http.request` 原来只解 gzip，deflate 的响应被当二进制文本交给 JS——表现是「弹幕 0 条」，
看起来像「这个视频没有弹幕」。现在 gzip/deflate（zlib 包装与裸 deflate 两种）都处理。

2026-10-30 M3 实测（酷我 / 酷狗 / QQ 音乐，引擎 51.5 KB → 71.6 KB）：

| 平台 | 结果 |
|---|---|
| 酷我 `474678847` | 解析 `kuwo-mobi 128kbps 3.21 MB`；下载 3,368,106 字节 / 210.44 s / 128 kbps，`ffprobe` 读到 `title=花海 (DJ 阿若版)` `artist=周杰伦`，`.lrc` 45 行；**该曲接口本身没有专辑与封面**（桌面端同样为空，已核对原始响应） |
| 酷狗 `f8de1dfd…` | 三档全放行：`kg-flac 41.55 MB` / `kg-320 13.89 MB` / `kg-128 5.56 MB`；下载无损 43,616,452 字节 / 958 kbps / 364 s，`ffprobe` 读到 `TITLE=花海` `ARTIST=周杰伦` + `mjpeg 500×500` 封面，`ffmpeg -f null` 解码通过 |
| QQ `004OtIcv22ptDz` | 四档全部列出：`m500 128K MP3 3.21 MB`、`c400 96K AAC 2.45 MB` 可用，`m800/f000` 不可用且带真实 `result=104003`；下载 3,368,088 字节，`ffprobe` 读到 `title=花海` `artist=周杰伦`，`.lrc` 1,402 字节。该曲详情里专辑为空、封面地址 404（桌面端同样拿不到），所以**没有**内嵌封面，不是写失败 |
| 自检 | 60 → **75** 条（新增 rid/hash/songmid 解析、LRC 时间轴、m4a 拒写 ID3） |

三个引擎与桌面端同一套接口与判定：酷我用 `songinfoandlrc` + `mobi.s`/`antiserver` 双候选，
酷狗用 `getSongInfo` + 搜索拿 `sqhash/320hash` 再走 `trackercdn`（`key=md5(hash+kgcloud)`），
QQ 用 `fcg_play_single_song` + `vkey.GetVkeyServer`。

**端上与桌面端的三个差异（都是「端上没有的东西」）**：
1. **没有登录**：QQ 固定 `uin=0`，四档照列、未放行的带 `result` 代码并明说「端上未登录，仅匿名档」；
   全档被拒时报 `need_login` 并建议改用桌面端，而不是把用户指去一个不存在的登录入口。
2. **没有 ffmpeg**：标签由 `music-common.tagStaged` 自己拼字节（mp3 ID3v2.3 / flac Vorbis+PICTURE）。
   m4a（QQ 的 96K AAC、酷狗的 m4a 档）**不写标签**——`buildAudioTag` 认出 `ftyp` 就返回空前缀
   并说明原因，往 m4a 前面塞 ID3 会直接把文件写坏。
3. **截断判定按接口声明**：QQ 用「实际 < 声明 × 60%」，酷我/酷狗用探测到的总字节 × 95%，
   与桌面端各自的阈值一致（平台不同，证据强度不同）。

**仍未做**：进程被杀后的**自动**续传（现在标「上次中断」，手动「重试」会从 `.part` 续传）、
专辑批量、端上登录（所以 QQ 的 320K/无损、B站字幕与 1080P 以上档位都拿不到，只能如实报 `need_login`）。

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
