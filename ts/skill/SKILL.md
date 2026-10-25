---
name: video-acquire
description: 下载抖音、B站（含分P/番剧）、网易云的单条视频或音乐，返回稳定 JSON。用户给出链接并希望保存到本地时使用；不做搜索、不做批量收藏夹。
---

# video-acquire（TS 版）

单文件 Windows 可执行程序，**不需要 Python / Node / yt-dlp**。
支持：抖音视频、B站 视频（分P / 番剧）、网易云单曲。

## 前置检查

```bash
vdl.exe probe "https://www.douyin.com/video/6961737553342991651"
```

返回 `ok: true` 即环境可用。B站 4K/1080P+ 与网易云无损依赖本机已登录的 cookie
（`%LOCALAPPDATA%\vdl\auth\`）；没有登录也能用，但档位会降级。

## 用法

```bash
vdl.exe probe "<url>"                 # 只解析，输出 JSON
vdl.exe get   "<url>" -o "<目录>"      # 下载推荐档（B站 默认 1080P）
vdl.exe get   "<url>" --format bili-854 -o "<目录>"
```

- 成功后 `path` 是绝对路径，`bytes` 是真实体积；重复下载会返回 `skipped: true`。
- B站 视频/音频两条流会在本地用 ffmpeg 合并；**ffmpeg 必须在 PATH 里**。
- 分P / 番剧：`probe` 返回 `media.parts[]`，用 `parts[].url` 重新 probe/get 指定集。

## 契约（schema=2）

```json
{
  "schema": 2, "ok": true, "platform": "bilibili", "engine": "bilibili-api",
  "media": { "id": "BV...", "title": "...", "author": "...", "duration_ms": 1,
             "thumbnail": "...", "source_url": "...", "platform": "bilibili",
             "parts": [{ "index": 1, "title": "...", "duration_ms": 1,
                         "url": "...", "selected": true }] },
  "formats": [{ "id": "bili-1920", "label": "1080P", "width": 1920, "height": 1080,
                "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a", "fps": 24,
                "bytes": 85498884, "bitrate": 3312883, "watermark": false,
                "recommended": true, "available": true, "reason": null,
                "subtitles": [] }],
  "warnings": [], "error": null
}
```

## 错误码 → 下一步

| code | 含义 | 下一步 |
|---|---|---|
| `bad_input` | 识别不出 ID | 让用户给完整页面链接 |
| `no_stream` | 没有可用流 | 可能需要登录，或该集受限 |
| `filtered` | 内容被过滤/下架 | 换一条链接 |
| `need_login` | 需要登录/会员 | 在桌面端运行 `vdl auth <site>` 扫码 |
| `http_404` | 页面不存在 | 让用户确认链接 |
| `ffmpeg_missing` | 找不到或无法启动 ffmpeg | 安装 ffmpeg 并加入 PATH，或设置 VDL_FFMPEG |
| `ffmpeg_failed` | 音视频合并失败 | 检查磁盘空间后重试，分离流会保留 |
| `unsupported_url` | 不支持的站点 | TS Skill 不含 yt-dlp 兜底，告知用户 |

## 时间预期

- probe：0.3–1.5s（B站 305ms 左右）
- 下载：取决于体积；抖音 6MB 约 3s，B站 480P 127MB 约 16s

## 红线

- 只下用户自己有权访问的内容；不做 DRM、直播、私密、批量收藏夹。
- 不打印 cookie 值；凭据只在 `%LOCALAPPDATA%\vdl\auth\`。
