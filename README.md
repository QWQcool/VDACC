# DYDownload —— 抖音视频下载器

把抖音上看到的视频存到本地，1080p 原画质、无水印。粘贴分享口令就行。

## 怎么用

**双击 `抖音下载器.bat`**，弹出窗口后：

1. 把抖音里「复制链接」得到的**整段文字**直接粘进去（不用挑链接，脚本自己抠）
2. 多个视频就一行一个
3. 点「开始下载」

文件存到 `下载\`，命名格式 `视频ID_标题.mp4`。同一个视频重复下载会自动跳过。

## 为什么不用 yt-dlp / 那些 GUI

抖音的视频详情接口要求每个请求都带 `a_bogus` 签名，这个签名只有浏览器里的 JS 算得出来。yt-dlp 的抖音提取器发的是裸请求，源码里那行 `# TODO: Run verification challenge code` 至今没做完——所以 ytDownloader、Open Video Downloader、Stacher 这些套壳工具全都下不了抖音，报错永远是 `Fresh cookies needed`。

更不能靠"读浏览器 cookie"这条路，实测有三道墙：

| 墙 | 现象 |
|---|---|
| 文件锁 | Edge 运行时会独占 `Network\Cookies`，连只读都 PermissionError |
| 后台复活 | 关掉 Edge 后几秒它自己又拉起来（"关闭后继续运行后台扩展"） |
| App-Bound Encryption | 就算抢到文件 + Local State，Chromium 127+ 的密钥绑死在浏览器进程，报 `Failed to decrypt with DPAPI` |

**所以本工具换了个思路：不自己发请求，让浏览器去发，我在旁边截响应。**

```
Playwright 起一个独立 Edge（独立 profile，不碰你正在用的）
  → 打开视频页，浏览器自己算签名、自己请求 detail
  → 截下 detail JSON（含 24~30 档清晰度）和视频 CDN 地址
  → 按码率排序，逐个试下，实际比字节数取最大的
  → 用浏览器上下文下载（自动带 cookie + Referer）
```

## 目录说明

```
DYDownload\
├─ 抖音下载器.bat     双击启动图形界面
├─ dy_gui.pyw         界面代码（tkinter）
├─ dy_dl.py           核心逻辑，也能命令行直接用
├─ venv\              独立 Python 环境（playwright + yt-dlp）
├─ browser_profile\   独立浏览器配置（58MB，删了会自动重建）
└─ 下载\              输出目录
```

## 命令行用法

```bash
venv\Scripts\python.exe dy_dl.py "https://v.douyin.com/xxxx/"
venv\Scripts\python.exe dy_dl.py 7601899463951770978
venv\Scripts\python.exe dy_dl.py "链接1" "链接2" --force
venv\Scripts\python.exe dy_dl.py 链接 --headful    # 显示浏览器窗口，排错用
```

`--force` 强制重下（默认跳过已存在的）。

## 常见问题

**换了新视频下不动了？**
抖音不定期改接口。先跑 `--headful` 看浏览器里能不能正常播放：
- 能播放但脚本报错 → 接口字段变了，检查 `collect_candidates()` 里的 `bit_rate` / `play_addr` 路径
- 浏览器里也播不了 → 视频本身被限（私密/已删/地区限制）

**文件只有几百 KB 正常吗？**
正常。抖音竖屏短视频码率本身就低（这条 9 秒 1080×1440 只有 731kbps / 0.8MB）。脚本已经取了最高档，不是压缩过。

**能下别的平台吗？**
这个工作空间专治抖音。B 站、YouTube、小红书等可以直接用 venv 里的 yt-dlp（它是好的，只有抖音的提取器坏了）：

```bash
venv\Scripts\python.exe -m yt_dlp -F "视频链接"
venv\Scripts\python.exe -m yt_dlp "视频链接"
```

**下载的文件没有水印吗？**
没有。取的是抖音自己发布的播放流，不是后期裁剪去水印。
