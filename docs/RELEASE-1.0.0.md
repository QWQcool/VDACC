# VDACC 1.0.0

首个可用版本：一个能在桌面、命令行和 Agent 里跑的媒体下载内核。

## 能力

| 平台 | 引擎 | 说明 |
|---|---|---|
| 抖音 | `douyin-http` | 纯 HTTP 签名，无需浏览器/cookie，3 档 |
| B站 | `bilibili-ytdlp` | yt-dlp + 登录 cookie，5 档，音视频合并 |
| 网易云 | `netease-api` | 免签名，无损 FLAC / 320K，标签+封面+歌词 |
| 其它 | `ytdlp-generic` | 任意 http(s) 链接交给 yt-dlp 兜底 |

## 三种用法

```bash
# 命令行 / Agent
python -m vdl probe "<url>" --json
python -m vdl get   "<url>" --json -o 下载

# 桌面界面
python -m vdl serve            # 或双击 VDACC.bat

# Skill（给其它 Agent）
python tools/build_skill.py --zip   # dist/video-acquire.zip
```

## 这一版包含

- 统一 JSON 契约（`schema=1`）与可指导下一步的错误码
- 扫码登录设施（独立 profile，凭据不进仓库、不回显）
- Web 界面：画质 chips、多选、预览、SSE 进度、明暗主题
- 本地服务：固定 8765 + token、Origin 校验、路径 jail
- 任务历史持久化（重启保留最近 100 条，中断任务标记明确）
- 局域网模式与文件回传（手机遥控）
- 28 个离线单元测试 + CI
- `video-acquire` Skill（23 文件 / ~90 KB）

## 已知限制

- B站 分P / 番剧只取第一个分P
- 无 L2 通用嗅探；`blob:`/MSE 页面不支持
- 音乐只支持单曲，不展开歌单
- 移动端只有浏览器访问，没有独立 App
- 平台接口随时可能变；失效时错误码会明确指向「引擎需要更新」

## 校验

```bash
python -m unittest discover -s tests -t .
python -m vdl doctor --json
```
