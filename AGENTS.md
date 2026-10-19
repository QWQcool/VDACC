# AGENTS.md —— 给后续 AI / 协作者的上下文

这个仓库是一个**视频下载工具**，起点是抖音，正在向「多平台 + 视频分析」扩展。
动手前先读 `Plan.md`（路线图与待决策）。本文只写**不能违反的红线**和**已验证的事实**。

## 一、红线（踩过的坑，不要再走回头路）

1. **不要提议换回 yt-dlp 下抖音。**
   抖音 `aweme/detail` 要求每请求带 `a_bogus` 签名，只有浏览器 JS 算得出。
   yt-dlp 的 `DouyinIE` 发裸请求，`extractor/tiktok.py` 里那行
   `# TODO: Run verification challenge code` 至今未完成。
   报错是误导性的 `Fresh cookies needed`，不是真的缺 cookie。

2. **不要提议安装任何第三方 GUI**（ytDownloader / Open Video Downloader / Stacher / BBDown 之类）。
   全部基于 yt-dlp 或需要额外环境，且失去可控性。

3. **不要试图读取用户正在使用的浏览器的 cookie。** 三道墙实测无解：
   - 文件锁：Edge 运行时独占 `Network\Cookies`，只读都 PermissionError
   - 后台复活：关掉 Edge 后几秒自己又拉起
   - App-Bound Encryption：Chromium 127+ 密钥绑死浏览器进程，离线解密报
     `Failed to decrypt with DPAPI`

   **正确姿势**：用我们自己 `browser_profile` 起的独立 Edge，通过
   `context.storage_state()` 导出**明文** cookie。我们是进程内合法持有者，
   不涉及任何解密，也不碰用户的浏览器。这是唯一被认可的路。

4. **不做 DRM。** Widevine / Netflix / 付费点播无合法解法，直接判定不支持。

## 二、已验证的事实

| 项 | 值 |
|---|---|
| 抖音截流方案 | 可用，能拿 `normal_1080_0` 最高档，不依赖用户关闭浏览器 |
| yt-dlp 版本 | 2026.8.19，**1752** 个提取器 |
| yt-dlp 的 B站支持 | 完整（BiliBili / Bangumi / Playlist / Live / Intl） |
| yt-dlp 的抖音支持 | **坏的**，唯一失效的提取器 |
| ffmpeg | **缺失**，PATH 和 venv 都没有 —— 这是当前最大阻塞 |
| Playwright | 1.64.0，用 `channel=msedge` 复用系统 Edge，不下载 chromium |
| venv | Python 3.13.4，必须带 tkinter |

ffmpeg 为什么是硬前提：B站/YouTube 全是 DASH 音视频分离，yt-dlp 下完会得到
`.fXXX.mp4` + `.fXXX.m4a` 两个文件然后警告 ffmpeg 不存在，结果是**无声视频**。
抖音那套能跑通，纯粹因为抖音返回单文件 mp4。

## 三、目录与运行

```
├─ dy_dl.py          核心逻辑（Playwright 借浏览器签名）+ 命令行入口
├─ dy_gui.pyw        tkinter 界面，worker 在子线程调 download()
├─ 抖音下载器.bat    start pythonw 启动 GUI，无命令行窗口
├─ browser_profile/  独立 Edge 配置（不入库，删了会自动重建）
├─ 下载/             输出目录（不入库）
└─ venv/             独立 Python 环境（不入库）
```

```bash
venv\Scripts\python.exe dy_dl.py "https://v.douyin.com/xxxx/"
venv\Scripts\python.exe dy_dl.py 7601899463951770978 --force
venv\Scripts\python.exe dy_dl.py 链接 --headful    # 显示窗口排错
```

## 四、工程约定

- **代码里不写绝对路径。** 一律用 `pathlib.Path(__file__).resolve().parent` 派生，
  输出目录可用参数覆盖。
- **GUI 与 CLI 共用同一后端。** 不许把业务逻辑写进 `dy_gui.pyw`。
  这个后端未来要给 agent 调用，输出必须是结构化数据而非只给人看的日志。
- **单例约束**：`browser_profile` 同时只能被一个进程使用，并发会崩。
  多任务必须串行或加文件锁。
- **提交前脱敏**：确认没有 cookie / 密钥 / 绝对路径 / 机器名进入 diff。
  `browser_profile/`、`cookies.txt` 已在 `.gitignore` 里，不要用 `-f` 强加。
- 中文注释，函数级说明写清「为什么这么做」，而不只是「做了什么」。
