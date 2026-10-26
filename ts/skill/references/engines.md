# 引擎差异（TS 版）

| 平台 | 引擎 | 关键事实 | 常见失败 |
|---|---|---|---|
| 抖音 | `douyin-http` | 签名 `md5(uifid_ts_SALT_query)`，需 ttwid + uifid（**不需要登录 cookie**）；Argus 会概率性 403 或回 200+空 body，已自动重试 3 次 | `blocked`：重试 3 次后仍被风控；换网络或关代理，必要时用浏览器兜底 |
| B站 | `bilibili-api` | `x/player/playurl` DASH；番剧走 `pgc/.../v2/playurl`；cookie 必须按域名/过期过滤（全量 8.9KB 会 400） | `no_stream`：未登录/会员/地区 |
| B站 番剧 | `bilibili-pgc` | 197 集实测；`media.parts[]` 给出每集 | 同上 |
| 网易云 | `netease-api` | 免签名；`br=999000` 返回 FLAC；落盘写标签 + 800px 封面 + `.lrc` | `need_login`：无 `MUSIC_U` 时只有 320K |

## 命名

- 视频：`{id}_{标题}_{档位}.mp4`；分P / 番剧额外带 `_P{n}` / `_EP{n}`
- 音乐：`{id}_{标题}_{档位}.flac|mp3`，歌词同名 `.lrc`

## 已知边界

- 不内置 yt-dlp：未知站点直接 `unsupported_url`
- 番剧 4K 的选流与 yt-dlp 不同（codec 偏好），体积可能有差异
- 进度只按单条流统计，视频+音频任务会提前接近 100%
