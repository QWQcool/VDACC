# 移动端：三种路线与边界

先说结论：**手机端不跑 B站引擎**。B站 依赖 yt-dlp（Python + ffmpeg），端上跑不起来；
抖音、网易云是纯 HTTP，理论上可移植，但那是第二套实现。

## 路线 A：浏览器直连（现在就能用）

```bash
vdl serve --lan
# 本机:   http://127.0.0.1:8765/?token=xxxx
# 局域网: http://192.168.x.x:8765/?token=xxxx
```

手机与电脑同一网段时，用局域网地址打开：

- 第一次打开如果没带 token，会看到「连接本机 VDACC」输入框，粘贴一次即可（存在浏览器本地）；
- 解析、选档、下载、进度都可用；
- 任务卡上的「下载」走 `/api/files/<jobId>`，把文件取回手机；
- 「打开」按钮只在桌面有效（`/api/reveal` 调的是资源管理器）。

**注意**：`--lan` 会把服务暴露到局域网，公共 WiFi 下别开。

## 路线 B：添加到主屏幕

- iOS Safari：分享 →「添加到主屏幕」，会以独立窗口打开；
- Android Chrome：因为局域网是 `http`，浏览器不允许注册 Service Worker，
  所以只能得到快捷方式（不是真正的 PWA）。用 `localhost` 或 https 时才可"安装"。

## 路线 C：原生壳（需自行构建，本机无工具链）

本机现状：**没有 JDK / Android SDK / DevEco**，所以仓库里不提供能直接安装的包，避免给假承诺。

两条壳的形态相同：壳里只放一个 WebView，指向 `http://<电脑IP>:8765`。

| 平台 | 技术 | 需要 | 约束 |
|---|---|---|---|
| Android | Capacitor / 原生 WebView | JDK 17 + Android SDK + Gradle | 只做遥控；端上不跑引擎 |
| Harmony | ArkWeb（`Web` 组件） | DevEco Studio + 签名 | 同上；ArkTS 桥只用于打开外部链接 |

如果真要做端上引擎（离线可用），只有抖音和网易云可行，且必须重写成 TS/ArkTS，
并与 Python 版保持同一份契约（`schema=2`）——这是另一个项目的工作量。

## 与 infOS 的关系

infOS 的移动端是它自己的 remote client；我们不需要并入。
`integrations/infos/` 里的薄页面已经覆盖「宿主内嵌」的场景。
