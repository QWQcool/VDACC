---
name: video-acquire
description: Downloads videos and songs from Douyin, Bilibili, and NetEase Cloud Music to local disk at the best quality the current account can access, returning structured JSON. This skill should be used when the user provides a share URL or asks to save, download, or fetch a video/audio from a supported platform. Not for DRM-protected, paid, private, or live content.
---

# video-acquire

把链接变成磁盘上的文件：先解析出**真实可选档位**，再按档位下载。

只做三件事：抖音视频、B站视频、网易云单曲。其它站点请用 yt-dlp 或通用嗅探（未实现）。

## 前置检查（每次会话第一次调用前跑一次）

```bash
# 可选依赖：抖音/网易云只用标准库；B站需要 yt-dlp，扫码登录需要 playwright
pip install -r scripts/requirements.txt

python scripts/vdl_run.py doctor --json
```

看三个字段：

| 字段 | 含义 | 缺失时 |
|---|---|---|
| `ffmpeg` | B站合并 / 音乐写标签需要 | 把 `ffmpeg.exe` 放进 `scripts/venv/Scripts` 或 PATH |
| `yt_dlp` | B站引擎依赖 | `pip install yt-dlp` |
| `auth` | 已登录站点列表 | 高画质需要 `vdl auth <site>`（需人工扫码，不要替用户做） |

抖音不依赖上面任何一项。

## 标准流程

```bash
# 1) 只解析，不下载：先让用户确认标题与档位
python scripts/vdl_run.py probe "<url>" --json

# 2) 下载推荐档
python scripts/vdl_run.py get "<url>" --json -o "<输出目录>"

# 3) 指定档位（id 来自上一步的 formats[].id）
python scripts/vdl_run.py get "<url>" --format bili-1920 --json -o "<输出目录>"
```

规则：

1. **先 probe 再 get**。用户没说清晰度时，把 `formats[]` 里的 `label` / `bytes` 报给用户选；
   不要默认下一个 250MB 的 4K。
2. `--json` 时 **stdout 只有 JSON**，日志在 stderr。解析失败也返回 JSON，不会抛栈。
3. 下载是幂等的：同视频同档位已存在会返回 `"skipped": true`，不要重复触发。
4. 单次调用建议 ≤ 3 个链接；B站 大文件可能要几十秒，超时就拆成多次。

## 输出契约（schema = 1）

```json
{
  "ok": true,
  "platform": "douyin",
  "engine": "douyin-http",
  "media": { "id": "...", "title": "...", "author": "...", "duration_ms": 19782,
             "thumbnail": "...", "source_url": "...", "platform": "douyin" },
  "formats": [
    { "id": "normal_1080_0", "label": "1080P", "width": 1080, "height": 1920,
      "ext": "mp4", "vcodec": "h264", "acodec": "aac", "fps": 30,
      "bytes": 6281768, "bitrate": 2540397, "watermark": false,
      "recommended": true, "available": true, "reason": null }
  ],
  "warnings": [],
  "error": null
}
```

- `bytes` 是真实体积；拿不到就是 `null`，**不要向用户编造数字**。
- `formats[]` 只包含当前账号真正可用的档位。
- `get` 返回 `{ok, path, bytes, format_id, skipped, media, warnings, error}`。

## 错误码 → 下一步

| code | 含义 | 该做什么 |
|---|---|---|
| `bad_input` | 链接不完整 / 认不出 ID | 让用户贴完整分享口令 |
| `unsupported_url` | 站点没接入 | 明说不支持，不要反复重试 |
| `not_implemented` | 引擎在排期 | 同上 |
| `need_login` | 需要登录态 | 让用户本人扫码：`python scripts/vdl_run.py auth <site>` |
| `filtered` | 已下架 / 私密 / 地区限制 / 需购买 | 换源；不要尝试绕过 |
| `sign_rejected` | 平台签名算法变了 | 报错并说明「引擎需要更新」，不要假装成功 |
| `no_stream` | 没解析到可下载流 | 让用户确认浏览器里能播放 |
| `network` / `http_error` | 网络问题 | 重试一次，仍失败就如实报 |
| `ffmpeg_missing` | 缺 ffmpeg | 见前置检查 |
| `engine_unavailable` | 缺 yt-dlp 等依赖 | 见前置检查 |

失败时把 `error.message` 和 `error.next_action` 一起转述给用户，**不要只说"下载失败"**。

## 时间与体积预期

| 平台 | 解析 | 下载 |
|---|---|---|
| 抖音 | ~1 秒 | 5~10 MB/条，1~2 秒 |
| B站 | 2~4 秒 | 体积 = 视频+音频，可能 20MB~260MB |
| 网易云 | ~1 秒 | 无损 20~50MB/首，320K 约 8MB |

超过 60 秒的任务要告知用户"在后台继续"，不要静默等待。

## 红线

- **不打印、不回显 cookie 内容**；`vdl auth` 的输出只含 cookie 名与数量。
- 不做 DRM、付费内容、私密视频；不做"绕过会员"。
- 下载仅供个人离线使用，不主动建议二次分发。
- 不替用户扫码登录（扫码必须人工）。

## 更多

- 站点差异与已知失效模式：`references/engines.md`
- 需要给用户排错时，先跑 `doctor`，再让用户加 `--engine browser`（仅抖音）对比。
