# 酷我 / 酷狗能力基线（ReversePlan 工作包 1–2，第三批）

> 状态：**仅离线验证**。方法沿用 [`qq-capability-baseline.md`](qq-capability-baseline.md)，
> 本文只写这两个引擎特有的部分。两家共用 `core/audio.ts`（`.part` 续传 + 限速 + 标签）。

## 1. 数据流（两个引擎结构几乎一样）

```
酷我：parseRid → songInfo(3 次重试 + 歌词兜底) → mobi / antiserver 两个候选
      → probeAudio(Range 0-15，看 content-type + content-range 总字节) → labelOf
酷狗：parseHash → getSongInfo(公开档 url) → searchQualities(拿 sq/320 的 hash + pay_type)
      → trackercdn 取址 → probeAudio → formats
```

两家的共同点：

- **都没有登录能力**（注释里写明「不逆向签名、不做 .kgm 解密」）；
- 候选地址先 `probeAudio` 验一遍（非音频 content-type 直接判不可用），比 QQ/网易云更早发现问题；
- `get` 只挡 `< 100KB`，之后直接 `renameSync` 落盘。

## 2. 改前的问题（都有证据）

| # | 问题 | 后果 |
|---|---|---|
| 1 | 全部候选不可用时报 `need_login`，文案让用户「登录后再试」 | **本引擎根本没有登录入口**，用户被指进死胡同 |
| 2 | 显式 `--format` 不存在时静默换成别的档 | 用户以为拿到自己选的档 |
| 3 | 下载只挡 <100KB，不跟探测到的总字节比 | 截断的下载被报「完成」 |
| 4 | 酷狗把公开档称作「试听档」，并断言「付费曲或账号未登录」 | 实测那个档通常是**整首** 128kbps（4,631,150 字节），文案既错又误导 |
| 5 | 酷狗把「搜索接口失败」和「平台标记付费」混成一句话 | 原因不明时说成结论 |
| 6 | 酷我把低码率候选的原因写成「正片可能需要会员」 | 用「可能」包装猜测，仍是在给原因 |

## 3. 改后

| 项 | 行为 |
|---|---|
| 全档不可用 | `filtered` + 说明「公开通道只放行部分曲目 / 本引擎不支持登录」，**不再指向登录** |
| 显式档位不可用 | `no_stream` + 列出可用档位，绝不换档 |
| 下载完整性 | 实际字节 < 探测总字节 × 95% → `incomplete_media`（`.part` 保留可续传） |
| 酷狗档位说明 | 三态分开：`获取失败（搜索接口异常）` / `搜索没命中` / `接口标记付费（pay_type≠0）`；**不再出现「试听档」** |
| 酷我片段提示 | 只说「可下载的只有 Nkbps，不像整首——正片可能受限」，不点原因 |

## 4. 未做（本批不动）

- **B站**：同类的「显式档位静默降级」也存在（`bilibili_api`），但它有 DASH 双轨与番剧分支，
  单独一批更合适；
- 酷狗 `.kgm` 加密格式：本批不碰，也不声称支持；
- 两家都没有 `available:false` 的"档位列表"——它们的失败对象是**候选地址**而非平台档位，
  强行造档位会给用户凭空多出「不存在的画质」，因此仍用 `warnings` 说明。

## 5. 交付记录（2026-10-27）

| 文件 | 变更 |
|---|---|
| `ts/src/engines/kuwo.ts` | `urlCache` 存 `expected`；全档失败改 `filtered`；`get` 不换档；新增 `incomplete_media`；片段提示去掉原因断言 |
| `ts/src/engines/kugou.ts` | `searchQualities` 返回 `status/paid`；三类 warning 分开；全档失败改 `filtered`；`get` 不换档；新增 `incomplete_media` |
| `ts/tests/kuwo-probe.test.ts` | 5 条合成响应用例 |
| `ts/tests/kugou-probe.test.ts` | 6 条合成响应用例 |

```
bun test ts/tests/kuwo-probe.test.ts ts/tests/kugou-probe.test.ts
  → 11 pass / 0 fail（改前 3 pass / 8 fail）
bun test ts/tests → 139 pass / 0 fail（上一批后 128 + 11）
```

**脱敏**：全部合成 JSON + 临时目录；未访问真实账号、未下载真实音频。**仅离线验证**。

**下一批条件**：B站（`bilibili_api`）的档位降级与试听判定需要先弄清 DASH 双轨下
「一条轨缺失」与「整档不可用」的区别，再写用例。
