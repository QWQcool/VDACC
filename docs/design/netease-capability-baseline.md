# 网易云能力基线（ReversePlan 工作包 1，第二批）

> 状态：**仅离线验证**。方法与判定原则沿用
> [`qq-capability-baseline.md`](qq-capability-baseline.md)，本文只写网易云特有的部分。
> 线上行为仍以 `docs/music-channels.md` 的手工记录为准，未重新验证。

## 1. 数据流

```
输入 → extractId()                        ts/src/engines/netease.ts:43
        │  裸数字 id / `?id=` / `/song/<id>`，其它域名不认
        ▼
 probeNetease = scopedOperation(probeNeteaseImpl)   :123
   ├─ cookieHeader()                     :26  → %LOCALAPPDATA%/vdl/auth/netease.json
   │     └─ 只拼 `name=value`，**不检查 expires**（过期 cookie 照样发出去）
   ├─ getJson(`/api/song/detail/?id=…`)  :130
   │     ├─ 非 2xx → VdlError('network')   ← 网易云已经有独立的网络错误码
   │     └─ songs 为空 → VdlError('filtered', '查不到这首歌')   ← 码用错了，是 not_found
   ├─ 逐档位取地址（4 档，2026-10-27 补低档）
  │     LEVELS = [999000 lossless, 320000 exhigh, 128000 standard, 96000 low]
   │     ├─ `code≠200` 或 `url` 为空 → **直接 continue 丢弃**
   │     └─ 放行 → headSize(url) 覆盖 item.size 后进 formats
   ├─ formats 为空 → filtered（有 cookie）/ need_login（无 cookie）  :151
   └─ 产出：formats + **warnings 恒为空数组**

 getNeteaseImpl                           :206
   ├─ probeNetease() 重新探测
   ├─ 选档：formatId 命中 → recommended → formats[0]（**静默降级**）
   ├─ streamTo(url, part)                 :173   Range 续传 / 限速 / 取消
   ├─ 实际 < 100KB → bad_payload
   ├─ 歌词 → .lrc（失败不影响音频）
   ├─ 封面 1920×1920 → ffmpeg 缩到 800px → 内嵌
   └─ ffmpeg 合并失败 → 保留音频 + warning
```

## 2. 与 QQ 那批的差异

| 维度 | QQ | 网易云 |
|---|---|---|
| 档位数 | 4（320K/128K/96K AAC/FLAC） | **2**（无损/320K） |
| 全档被拒的码 | 恒 `need_login` | **已区分** `filtered` / `need_login` |
| 网络错误 | 落到 `internal` | **已有 `network`** |
| 试听判据 | 只有 `part < 100KB` | 同左（更危险：无损档片段也可能 >100KB） |
| `warnings` | 有内容 | **恒为空**（用户看不到任何解释） |
| 声明大小 | 从 detail 的 `size_*` 取，未被覆盖 | 被 `headSize()` 覆盖，**丢失整曲参照** |

## 3. 未知（不得推断）

| 未知项 | 说明 |
|---|---|
| `code=404` / `url=null` 的含义 | 可能是无权益、地区限制、下架或风控，没有证据区分 |
| cookie 过期与「无权益」的区别 | 平台响应相同，只能从**本地** cookie 的 `expires` 判断「凭据可能已过期」 |
| 无损档是否总能拿到 | 取决于账号（`docs/music-channels.md` 只记录过 MUSIC_U 直接返回 FLAC） |

## 4. 本批要验证的断言（工作包 2 的靶子）

| # | 断言 | 改前 | 现在（2026-10-27） |
|---|---|---|---|
| N0 | 两档都放行时都进 `formats`，推荐无损 | ✅ | ✅ |
| N1 | 未放行档也出现，`available:false` + `reason` 带真实 `code` | ❌ 被丢弃，`warnings` 恒空 | ✅ `接口未放行（code=404）`，warnings 有内容 |
| N2 | 全档被拒 + 有 cookie → `filtered`，且**消息里带 code** | ⚠️ 码对、消息无 code | ✅ |
| N3 | 全档被拒 + 无 cookie → `need_login` | ✅ | ✅ 下一步给 `auth netease` |
| N4 | 详情里查不到歌 → `not_found` | ❌ 用了 `filtered` | ✅ |
| N5 | 显式指定不可用档位 → `no_stream` | ❌ 静默降级 | ✅ 报错并列出可用档位 |
| N6 | 实际字节远小于接口声明 → 不报「完成」 | ❌ 只挡 <100KB | ✅ `incomplete_media`（阈值 60%，`.part` 保留） |
| N6b | 字节数与声明相符时正常完成 | ✅ | ✅ 防误杀回归 |
| N7 | 接口 5xx → `network` | ✅ | ✅ |

## 5. 本批不做

- 不扩大到酷我/酷狗（留给第三批）；
- 不改 `schema=2` 字段，只复用 `Format.available/reason`；
- 不做任何账号权益的绕过（与 QQ 那批同一条边界）。

## 6. 顺带发现：预览「疑似取不到地址」——**核实后不成立**（2026-10-27）

初版文档怀疑 `previewNetease()` / `previewQQ()` 会在作用域外取地址。读代码核实：
`server.ts:305` 把**整个请求**包在 `runOperation(async () => …)` 里，`probeUrl()` 与随后的
`previewXxx()` 共用同一个作用域，`operationState` 的地址表在预览时仍然有效 —— **不是缺陷**。

证据：`ts/tests/netease-probe.test.ts` 新增两条
「同一作用域内 probe 之后仍能取到预览地址」/「作用域外会抛错（说明必须共用同一个 runOperation）」。
它们把「预览依赖请求级作用域」这个前提钉住了，任何人把 preview 挪出作用域都会立刻红。

## 7. 工作包交付记录（2026-10-27）

**改动范围**

| 文件 | 变更 |
|---|---|
| `ts/src/engines/netease.ts` | 两档全量进 `formats`（`available/reason`）；详情缺失改 `not_found`；全档被拒消息带 code；`warnings` 不再恒空；`formatUrls` 改存 `{url, declared}`；`get` 不再静默换档；新增 `incomplete_media` |
| `ts/tests/netease-probe.test.ts` | 新增 9 条合成响应用例 |
| `docs/design/netease-capability-baseline.md` | 本文 |

**运行命令与结果**

```
bun test ts/tests/netease-probe.test.ts  → 9 pass / 0 fail（改前 4 pass / 5 fail）
bun test ts/tests                        → 120 pass / 0 fail（QQ 批后 111 + 新增 9）
```

**脱敏证据**：全部为人工构造的 JSON 与临时目录；未访问真实账号，未下载真实歌曲。
**仅离线验证**，线上档位未复测。

**未覆盖**：`code=404` 的真实含义、cookie 过期与无权益的区分、无损档在真实账号下的表现。

**下一批条件**：酷我/酷狗 目前只记录「会员档被拒时如实报试听档」，没有独立测试；
若要继续，先按同一模板补它们的合成响应用例，再谈改代码。

## 8. 增补：补上 128K / 96K 低档（2026-10-27，真实环境驱动）

### 为什么补

真实 probe 发现：只探「无损 / 320K」时，**没有会员权益的账号会一首歌都下不了**，
连平台本来对免费曲开放的 128K/96K 也拿不到。这不是「绕过会员」，而是把平台**已经允许**的范围用上。

### 改了什么

| 项 | 变更 |
|---|---|
| `LEVELS` | 增加 `128000 standard 标准 128K`、`96000 low 较低 96K`（共 4 档，顺序由高到低） |
| 判重 | 实测 128K 与 96K 会返回**不同 URL 但字节完全相同**的文件；现在按「字节相同」判重并加一条 warning 说明，避免界面出现两个一样大的档位 |
| 别名 | 被判重掉的档位 id 仍登记在地址表里，`--format low` 依然可用（按别名命中） |

### 真实环境结果（2026-10-27）

免费曲《雨爱(钢琴版)》(id 2007983648) 的真实 probe / 下载：

```
lossless  无损 FLAC  14.62 MB  推荐
exhigh    极高 320K   9.82 MB
standard  标准 128K   3.93 MB
注意：较低 96K 接口返回的文件与已有档位字节相同，已合并为一条
```

下载 `--format standard` → 4,179,995 字节（含封面/标签），ffprobe：mp3 / 129,918 bps / 257.4s / 带 mjpeg 封面。
对比：会员专享曲（如《晴天》id 186016）四档仍然全部 `code=404` —— **补档位不会让 VIP 曲变得可下**。

### 测试

```
bun test ts/tests/netease-probe.test.ts → 13 pass / 0 fail（新增 N1b 低档可用、N1c 同字节判重）
bun test ts/tests                        → 147 pass / 0 fail
```
