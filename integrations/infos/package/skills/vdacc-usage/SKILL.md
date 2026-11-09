# VDACC 媒体获取（本机服务）

本技能只讲**怎么用本机 VDACC 服务**，不重复它的完整文档（完整版在 VDACC 仓库 `ts/skill/SKILL.md`）。

## 什么时候用

- 用户给了一个**媒体链接**（抖音、B站含分P/番剧、网易云、QQ音乐、酷我、酷狗、m3u8 或直链），
  想**拿到文件**或**先看有哪些档位**；
- 用户想查「刚才那个下载到哪了」；
- 用户想把本机已下好的成品做镜头分析（分镜/运镜/响度/风格卡）。

## 顺序

1. `vdl_probe {url}` —— 只读。看 `formats[].id`、`available`、`bytes`。
2. `vdl_get {url, formatIds:[id], subs?, danmaku?}` —— 立即返回任务 id，**不等下载**。
3. `vdl_jobs {id}` —— 轮询到 `done` / `failed`，取 `path`。

## 必须照做的三条

1. **不要传自己编的 formatId**：只能传 `vdl_probe` 返回过的 id；缺档位服务端会报 `no_stream`，
   并且**不会**悄悄换成别的清晰度。
2. **`available:false` 的档位不要硬下**：`reason` 会写清楚（多数是 `need_login` 或会员限制）。
   如实转告用户，不要去猜 cookie。
3. **失败要照抄 `error.code`**：`need_login` / `no_stream` / `incomplete_media` / `ffmpeg_missing`
   分别对应完全不同的处置，不要统一说成「下载失败」。

## 不要做

- 不要试图在 Package 里启动 VDACC 进程（服务由用户自己启动，包只管调用）；
- 不要把 token 写进提示词或日志；
- 不要在没探测的情况下批量提交几十个任务。
