# B站能力基线（ReversePlan 工作包 1–2，第四批）

> 状态：**仅离线验证**。方法沿用 [`qq-capability-baseline.md`](qq-capability-baseline.md)。
> B站与音乐引擎的结构不同：DASH 双轨（视频流 + 音频流），`ffmpeg -c copy` 合并，
> 还有番剧（PGC）与分P两条分支。

## 1. 数据流

```
普通视频：parseTarget(BV/p) → /x/web-interface/view（标题/分P/cid）
          → /x/player/playurl?qn=120&fnval=4048&fourk=1 → dash.video[] + dash.audio[]
          → foldDash：按**宽度**分桶（3840/2560/1920/1280/854），同桶取 avc 优先 + 带宽最高
番剧：    /pgc/view/web/season → episodes[] → /pgc/player/web/v2/playurl → 同一套 foldDash
下载：    chooseFormat（指定档位必须命中，否则 no_stream）
          → Range 探测两条轨总字节 → 分别 streamTo(.m4s) → ffmpeg -c copy → rename .mp4
```

B站已经做对的两件事（本批保留、加用例守）：

- `chooseFormat` 对显式档位**不静默降级**（音乐引擎到本批才补齐）；
- `parseContentRangeTotal` + `aggregateProgress` 用两条轨的真实总字节做进度分母。

## 2. 改前的问题

| # | 问题 | 后果 |
|---|---|---|
| 1 | `apiJson` 把所有接口错误记成 `download_failed` | 还没开始下载就说「下载失败」；`code=87007`（大会员专享）、`-404`（稿件不存在）分不出来 |
| 2 | `dash.audio` 为空时照常合并，`warnings` 恒为 `[]` | 得到**无声视频**，但流程报成功、界面无任何提示 |
| 3 | 下载后不校验两条轨的实际字节 | 截断的重试被当成功 |

## 3. 改后

| 项 | 行为 |
|---|---|
| 接口 HTTP 错误 | `http_<status>`（不是 `download_failed`） |
| 接口返回 HTML（风控页） | `api_error` + 「返回的不是 JSON（可能被风控）」 |
| `code=-404` | `not_found` |
| 其它业务码 | `api_error`，消息里带 **`code=…` + 平台原话**（如「大会员专享限制」），不替用户解释 |
| 无音轨 | probe `warnings` 明确「下载结果会是无声视频」（仅提示，不阻断——确实存在无音轨稿件） |
| 未登录 | `warnings` 提示「清晰度以匿名放行为准（4K/1080P 通常需要登录）」 |
| 下载完整性 | 每条轨实际字节 < Range 探测值 × 95% → `incomplete_media`，**在合并之前**判定 |

最后一处是关键：合并成功只说明 ffmpeg 跑通了，不说明内容完整；校验必须放在 `ffmpeg` 之前。

## 4. 未做 / 已知边界

- 番剧弹幕仍不支持（代码里如实返回 `danmakuSupported=false`，本批未动）；
- `chooseFormat` 不检查 `available`——B站的 formats 全部来自实际返回的轨道，没有「不可用档位」这一说；
- 4K 需要登录 + 大会员，本批只保证如实提示，不涉及任何权益绕过。

## 5. 交付记录（2026-10-27）

| 文件 | 变更 |
|---|---|
| `ts/src/engines/bilibili_api.ts` | `apiJson` 错误分类；`dashWarnings()`（无音轨/未登录）；两条轨下载后截断判定 |
| `ts/tests/bilibili-probe.test.ts` | 6 条合成响应用例（含 2 条防误杀守卫） |

```
bun test ts/tests/bilibili-probe.test.ts → 6 pass / 0 fail（改前 2 pass / 4 fail）
bun test ts/tests                        → 145 pass / 0 fail（上一批后 139 + 6）
```

**脱敏**：全部合成 JSON + 临时目录；未访问真实账号，未下载真实视频。**仅离线验证**。

至此 ReversePlan 工作包 1–2 覆盖的引擎：QQ、网易云、酷我、酷狗、B站。
