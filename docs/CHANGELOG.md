# CHANGELOG

> 只记「用户可感知的变化」与「验证结论」。设计与取舍见 `Plan.md`。
> 每个版本的 GitHub Release 从这里摘取。

## v2.1.0 — 2026-10-22

**附属文件**

- `--cover`：封面存成同名图片（按 `Content-Type` 定 `.jpg/.png/.webp`），B站/抖音共用
- Web 界面：有缩略图时出现「封面」勾选框，默认勾上
- `tests/test_sidecar.py`：本地 HTTP 桩端到端验证「字幕 JSON → SRT → 落盘」
- 实测：抖音封面 438×330、B站 480P 封面 1600×900；测试 33 → 37

## v2.0.0 — 2026-10-22

**跨端入口**

- 手机/新浏览器首次打开显示「连接本机 VDACC」，粘贴 token 一次即可
- token 失效自动清除并回到连接页
- 移动布局 390×844 实测通过
- `integrations/mobile/README.md`：三种移动路线与「端上只跑纯 HTTP、B站必须遥控」的边界
- **原生壳未构建**：本机无 JDK / Android SDK / DevEco

## v1.3.0 — 2026-10-22

**入口**

- PWA：manifest + service worker（只缓存外壳，不缓存 `/api`）+ 192/512 图标
- Chrome/Edge MV3 扩展：右键转发链接，只做导航打开，不需要 host 权限
- `tools/build_portable.py`：便携包（40 文件 / 481KB，不打包 Python 本体）
- i18n 延期

## v1.2.0 — 2026-10-22

**内容完整性**

- 契约 `schema=2`：`media.parts[]`、`formats[].subtitles[]`（只增不改）
- B站 多P/合集：pagelist 取分P，`?p=N` 只解析该分P；UI 分P下拉
- `--subs` 落同名 `.srt`（中文优先）
- 实测：`BV1SknF6KE5g` 四P，P1 145MB / P2 89MB
- 边界：排行榜前 12 个视频均无 CC，字幕端到端只验证到「无字幕静默跳过」

## v1.1.0 — 2026-10-21

**可靠性**

- Range 断点续传（`.part` + 来源 URL sidecar，换候选不拼错）
- 网络/5xx 自动重试 3 次
- 任务取消（保留 `.part`）与重试；任务状态新增 `cancelled`
- `doctor --live` 三站点真解析；`--bundle` 脱敏诊断包
- `serve --concurrency 1~4`
- 实测：480P 取消于 39.8% 后重试完成；并发下抖音+网易云同时完成

## v1.0.0 — 2026-10-21

**首个可用版本**

- 四个引擎：抖音（纯 HTTP 签名）、B站（yt-dlp + 合并）、网易云（免签名 lossless）、
  `ytdlp-generic` 兜底
- `vdl serve`：token、SSE、任务队列、路径 jail、局域网、文件回传
- `vdl auth`：独立 profile 扫码，凭据不入库、不回显
- Skill：`video-acquire`（23 文件 / 90KB）
- 28 个离线测试 + CI
- Apache-2.0 + NOTICE
