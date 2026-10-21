# VDACC 路线图

> 定位：**桌面可编程下载内核 + 可选 GUI + Agent Skill**。
> 差异化在 Agent 原生契约、中文平台签名/登录态、本地零配置；不参与站点广度竞赛。

## 已完成

| 阶段 | 版本 | 内容 | 提交 |
|---|---|---|---|
| M1 | 0.1 | core 契约层（models / errors / router / engines） | `c061013` |
| M2 | 0.1 | `vdl serve` + SSE + token + 路径 jail + Web 界面 | `7710bca` |
| M2.5 | 0.1 | `vdl auth` 扫码登录（B站 / 网易云） | `14bef16` |
| M3 | 0.1 | 界面按设计稿重做（chips / 多选 / 预览 / 角色） | `cf40734` |
| M4 | 0.1 | 网易云引擎（免签名 lossless + 标签封面歌词） | `0c6d95b` |
| M5 | 0.1 | B站引擎（yt-dlp + 合并 + 进度聚合） | `93de338` |
| M6 | 0.1 | Skill 打包（`video-acquire`） | `0f1a79c` |
| R1 | 0.3 | 测试骨架（23→25）+ 三引擎界面验收 + 版本统一 | `248fcde` |
| R2 | 0.3 | 配置持久化、任务历史、`doctor --fix`、一键启动、CI | `4777618` |
| R3 | 0.3 | `_ytdlp` 基类 + 通用兜底引擎 | `6d18508` |
| R4 | 0.3 | 局域网、文件回传、infOS 接入参考 | `247676d` |
| R5 | 1.0.0 | Apache-2.0、NOTICE、发布与 Skill 资产 | 本次 |

## 待办（1.x）

| 优先级 | 项 | 说明 |
|---|---|---|
| 高 | B站 分P / 番剧 | 需要契约加 `parts[]`，会升 schema |
| 中 | 字幕 / 封面 sidecar | B站字幕、外挂封面，opt-in |
| 中 | 失效探测 | 连续 N 次 `sign_rejected` 自动降级并提示升级 |
| 低 | L2 通用嗅探 | 仅直链/m3u8，blob/MSE 明确不支持 |
| 低 | 音乐专辑批量 | 显式 `--album`、上限 20、默认不勾选 |
| 低 | 移动端壳 | Android/Harmony，遥控模式，端上只跑纯 HTTP 引擎 |

## 明确不做

- DRM、付费内容、私密视频、直播
- 站点广度竞赛（交给 yt-dlp）
- 播放列表/歌单自动展开
- 端上跑 B站（依赖 yt-dlp/Python，不可移植）

## 维护节奏

- 每次改动：`python -m unittest discover -s tests -t .` 必须全绿
- 每周：对三个引擎各跑一次 `probe` 冒烟；平台改版时先看 `sign_rejected` 是否上升
- 发版：`tools/build_skill.py --zip` → 打 tag → Release 附 zip
