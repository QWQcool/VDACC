# 发布检查清单（N05 收口）

> 目标：把「发一个版本」从记忆变成步骤。**不产出结论的地方就不打勾**——
> 没跑过的项写「未做」，不要用「应该没问题」代替。

## 0. 版本号：四处必须一致

| 位置 | 内容 |
|---|---|
| `package.json` | `"version"` |
| `ts/package.json` | `"version"` |
| `ts/src/server.ts` | `/api/health` 返回的 `version`（约 328 行） |
| `ts/tests/server.test.ts` | 断言 `data.version`（约 70 行） |

四处任一不同步，`bun test` 会红——这是有意为之的护栏。

## 1. 必跑项（全绿才算候选）

```bash
# 1) 单测 + 服务端安全用例
cd ts && bun test tests          # 当前基线：154 pass / 0 fail

# 2) Skill 包：构建 + 逐文件校验
cd .. && python tools/build_skill_ts.py --zip
python tools/verify_skill_ts.py dist/video-acquire-ts

# 3) 体积基线（与上次发布对比，漂移 >25% 会失败）
node tools/release_baseline.cjs

# 4) （已取消）界面布局矩阵 + 减少动态效果
#    按 AGENTS.md 红线 4（2026-11-04），UI/UX 与体验数字类测试不再是发布门槛。
#    功能面只要求：页面能加载、按钮能触发请求、错误能显示。脚本保留但不维护。
```

历史脚本 `tools/ui_shots.cjs` / `tools/reduced_motion_check.cjs` 仍可用（需要
`cd ts && bun install`，复用系统 Edge，不下载浏览器），但**不再要求跑、也不作为发版依据**。

## 2. 体积基线怎么用

`docs/release-baseline.json` 只记**体积**，不记哈希：

- 完整性由 `dist/video-acquire-ts/manifest.json` + `SHA256SUMS` 负责（`verify_skill_ts.py` 逐个核对）；
- 基线是为了回答「这次发版比上次大了多少」，exe 是分发门槛（用户要下 40MB+ 的包）；
- 有意变更体积时执行 `node tools/release_baseline.cjs --update`，**在同一个提交里**说明原因；
- 阈值：合计漂移 ≥10% 提示、≥25% 失败；单文件 ≥20% 提示。

当前基线（2026-10-27，Bun 1.4.4）：exe **91.95 MB**、合计 91.95 MB、zip **42.58 MB**、3 个文件。
两次构建之间体积漂移为 0.0%（可复现）。

## 3. CI

CI 是**手动触发**（GitHub 免费额度，历史 49 次自动运行全失败后又改成手动）：

```bash
gh workflow run CI --repo QWQcool/VDACC --ref main
gh run list --repo QWQcool/VDACC --limit 3
```

- 只看**本次**运行的结论；不要把旧提交的失败当成本轮结果。
- 恢复自动触发的条件写在 `.github/workflows/ci.yml` 末尾。

## 4. 标签与 Release

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Release 说明从 `docs/CHANGELOG.md` 的对应段落摘取，附件只放
`dist/video-acquire-ts.zip`（42.58 MB）——不放解压后的 exe（体积翻倍且容易混版本）。

## 5. 仍未做（不要假装已通过）

| 项 | 状态 | 说明 |
|---|---|---|
| **干净机器验收** | ⏸ 决定跳过（2026-11-02） | 需要一台**没有** Bun / Python / ffmpeg 的 Windows，解压 zip 后跑 `vdl.exe probe/get`。本轮决定**不做**，改为等真实用户反馈来暴露环境问题（例如机器上没装 ffmpeg 时的提示是否够清楚）。这是 N05 唯一还缺的硬证据，**不要当成已通过** |
| 第三方站点在线可用性 | ⚠️ 部分 | 2026-10-30 复测：抖音下载、酷我/酷狗/QQ 解析下载、网易云 probe/download（含 VIP 无损）、B站 1080P 合并；**冷门站点与地区限制仍未覆盖** |
| Android 独立端 | ✅ M6 已验收 | 见 `mobile/android/README.md`；登录后 B站 1080P、网易云无损均实测落盘 |
| 自动 CI | ❌ 暂停 | 配额原因，恢复条件见 workflow 注释 |

## 6. 回滚

- 已发布的 tag 不删除、不移动：发现问题是发 `X.Y.(Z+1)`；
- Release 说明里写清「修了什么、影响范围、是否需要重新下载 Skill 包」。
