# 引擎与站点差异

## 抖音（`douyin-http`）

- **不需要 cookie，也不需要浏览器**。签名是 `x-secsdk-web-signature = md5(uifid_timestamp_SALT_query)`，
  `ttwid` 自己注册，`aid=6383` 决定能拿到 1080p。
- 档位来自 `video.bit_rate[]`，按 gear 归并后通常 3 档（1080P / 720P / 540P）。
- 带水印的 `download_addr` 不展示；只有在完全没有干净档时才兜底。
- 体积取 `play_addr.data_size`，是真实的。
- 失效特征：`sign_rejected` / `HTTP 403`。平台改算法时只能等引擎更新；
  桌面版还有 Playwright 兜底（`--engine browser`），Skill 版没有。

## B站（`bilibili-ytdlp`）

- 解析与下载都交给 yt-dlp，我们只做档位归并与音视频合并。
- **清晰度按宽度归档**：3840/2560/1920/1280/854。B站 很多 MV 是 2.35:1，
  1920×816 是 1080P、4096×1740 是 4K——按高度会整体错一档。
- 所有格式都是 video-only + audio-only，必须成对合并；合并靠 ffmpeg。
- 带 cookie 才看得到 1080P+；4K 通常需要大会员。
- 体积是 `filesize + filesize_approx` 的估算，实际文件可能略有出入；
  进度百分比封顶 99.9，完成时才 100。

## 网易云（`netease-api`）

- **不需要 eapi/weapi 加密**：`GET /api/song/enhance/player/url?ids=[id]&br=999000`
  带 `MUSIC_U` 直接返回 `level=lossless` 的 FLAC；无 cookie 对免费曲返回 320K。
- 默认 `lossless`；拿不到时如实降级，并在 `warnings` 里说明。
- 落盘用 ffmpeg 写 title/artist/album/年份 + 800px JPEG 封面；歌词另存 `.lrc`。
- 数字专辑 / 单曲购买 / 地区限制 → `filtered`，不要尝试绕过。

## 未接入

- 快手、小红书、微博、YouTube：走 yt-dlp 或等 L2 通用嗅探。
- 直播、图文、歌单、播放列表：不做。
- DRM（Widevine / Netflix / 付费点播）：明确拒绝。

## 常见失效模式

| 现象 | 判断 | 处理 |
|---|---|---|
| 抖音 `403` + `ArgusSecurityPlugin` | 签名算法变了 | 报 `sign_rejected`，等更新 |
| B站 只有 720P | 未登录 | `vdl auth bilibili` |
| B站 下载完没有声音 | ffmpeg 缺失 | `doctor` 检查 |
| 网易云 `url: null` | 无版权 / 需购买 | 报 `filtered`，换曲 |
| 音乐标签没写 | ffmpeg 缺失 | 文件仍可用，但无标签/封面 |
