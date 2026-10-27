# QQ 音乐能力基线（ReversePlan 工作包 1）

> 状态：**仅离线验证**（合成响应 + 现有代码审阅）。没有任何线上探测结果被写进本文；
> 线上行为仍以 `docs/music-channels.md` 2026-10-23 的手工记录为准，未重新验证。
> 目的：把「已知 / 未知」分开，给工作包 2 的测试用例定靶，避免把猜测写进代码和文案。

## 1. 数据流

```
输入（裸 mid / 分享链接）
  └─ parseSongmid()                       ts/src/engines/qq.ts:56
       │  只认 *.qq.com + 14 位 base62；不认其它域名
       ▼
  probeQQ = scopedOperation(probeQQImpl)  :218
       ├─ fetchDetail(mid)                :124  → c.y.qq.com/fcg_play_single_song
       │     ├─ 非 2xx           → VdlError http_<status>
       │     ├─ 非 JSON          → VdlError bad_json（带前 120 字节）
       │     ├─ data[] 为空      → VdlError not_found
       │     └─ mid 不匹配       → VdlError wrong_song
       │     ↳ 产出：title/singers/albumMid/durationMs/声明大小 sizes{ M800,M500,C400,F000 }
       │
       ├─ loadCredential()                :88   → %LOCALAPPDATA%/vdl/auth/qq.json
       │     └─ 过期 cookie 先被过滤；过滤后缺 uin 或 qm_keyst → null（= 匿名）
       │
       ├─ fetchVkeys(mid, cred)           :163  → u.y.qq.com musicu.fcg（CgiGetVkey）
       │     ├─ 非 2xx           → http_<status>
       │     ├─ 非 JSON          → bad_json
       │     └─ req_1.code ≠ 0   → vkey_failed（当前文案写「未登录或接口变更」）
       │     ↳ 产出：sip + midurlinfo[]，每项 { filename, purl, result }
       │
       ├─ 逐档位判定（4 档固定顺序 320K/128K/96K AAC/FLAC）  :230
       │     ├─ 找不到 filename  / result≠0 / purl 为空 → 记入 denied（丢弃，不进 formats）
       │     └─ 放行 → headBytes(purl) 取 Content-Length；失败则用声明大小
       │
       ├─ formats 为空 → 抛 need_login        :249（**不看有没有凭据**）
       └─ 产出 ProbeResult(schema=2)：formats[] + warnings[]
             recommended = formats[0]（= 最高可用档）

getQQ = scopedOperation(getQQImpl)          :334
       ├─ probeQQ() 重新探测（purl 里的 vkey 会过期，不能复用）
       ├─ 选档：formatId 命中 → 否则 recommended → 否则 formats[0]（**静默降级**）
       ├─ streamTo(url, dest.part)          :283
       │     ├─ 有 .part → 带 Range；服务端不认 206 → 从 0 重写
       │     ├─ 每块 throwIfCancelled + throttle + report
       │     └─ 返回实际字节
       ├─ 实际 < 100KB → bad_payload（**唯一的「像试听」判据**）
       ├─ fetchLyric → 同名 .lrc（失败不影响音频）
       ├─ 封面随目标名临时落盘 → ffmpeg 写 title/artist/album + attached_pic
       └─ 合并失败 → 保留原始音频 + warnings「写入标签失败」
```

## 2. 现状状态矩阵（代码实际行为）

| 场景 | 现在怎么表现 | 证据位置 |
|---|---|---|
| 匿名、某档放行 | `formats` 只含放行档；`warnings` 写「未登录，仅匿名档」 | qq.ts:262 |
| 已登录、某档放行 | `warnings` 写「已登录，档位以账号权限为准」 | qq.ts:259 |
| 某档 `result≠0` | **直接丢弃**该档，只在 warnings 里拼一句「本次未放行：320K MP3…——歌曲付费或账号无对应会员」 | qq.ts:232, 260, 263 |
| 全部档位被拒 | 抛 `need_login`，文案「这首曲子没有匿名可用的播放地址」 | qq.ts:249 |
| 请求的 formatId 不存在 | **静默**换成推荐档（用户以为拿到的是自己选的档） | qq.ts:336 |
| 下载到试听片段 | 只有 < 100KB 才判失败；30 秒片段通常 300–500KB → **报「完成」** | qq.ts:351 |
| 凭据过期 | cookie 被过滤 → 当匿名处理，**不提示凭据已过期** | qq.ts:94 |
| 网络失败 | `fetch` 抛 TypeError → 上层 `fail()` 记成 `internal` | errors.ts:19 |
| 接口 result code | **全部丢失**，只剩中文标签 | qq.ts:232 |

## 3. 已知（有证据）

1. 档位只由 `midurlinfo[].result` + `purl` 决定，不看歌曲元数据里的 `size_*`（3.1 起的设计）。
2. `songmid` 与 `filename` 是**按下标**配对的，长度不一致会错位（qq.ts:165 注释）。
3. purl 是相对/绝对两种形态，需要拼 `sip[0]`。
4. 同一首歌登录前后档位可能完全一致（`docs/music-channels.md` 2026-10-23 实测，非会员账号）。
5. `fetchDetail` 对不存在的 mid 也回 `code=0`，只能靠空 `data` 判断。

## 4. 未知（不得推断）

| 未知项 | 为什么不能猜 |
|---|---|
| `result=104003` 的确切含义 | 只能观察到「该档没有 purl」。是会员缺失、单曲付费、地区还是客户端限制，**没有证据区分** |
| 试听片段的接口标志 | 现有记录里没有「这是试听」的字段证据；只能从**字节数/时长**间接推断 |
| 会员账号的实际档位 | 未用会员账号验证过（3.1 起的已知缺口） |
| `vkey_failed` 的成因 | 可能是未登录、风控或接口变更，现文案只写了两种 |
| HEAD 是否总可用 | CDN 可能拒绝 HEAD 或返回 0，此时只能退回声明大小 |
| 封面/歌词接口的稳定性 | 未纳入本批 |

## 5. 本批要验证的最小问题（工作包 2 的靶子）

按 ReversePlan §4.3「先写测试确认能检出问题，再改代码」，下面每条都对应一个合成响应用例：

| # | 断言 | 改前 | 现在（2026-10-27） |
|---|---|---|---|
| T0 | 放行档进 `formats`，推荐的是最高可用档 | ✅ | ✅ |
| T1 | 未放行档**也出现**且 `available:false`、`reason` 含真实 code | ❌ 被丢弃 | ✅ 四档全在；`result=104003` / 「接口没有返回」分别如实写 |
| T2 | 已登录且全档被拒 → 不应报 `need_login` | ❌ 恒报 need_login | ✅ 改报 `filtered`，文案带 result 代码 |
| T3 | 未登录且全档被拒 → `need_login` + 可执行下一步 | ✅ | ✅ 下一步给出 `auth qq` 命令 |
| T4 | 显式指定不可用档位 → 报 `no_stream`，**不换档** | ❌ 静默降级 | ✅ 报错并列出可用档位 |
| T5 | 实际字节远小于接口声明 → 不报「完成」 | ❌ 只挡 < 100KB | ✅ `incomplete_media`（阈值 60%，`.part` 保留可续传） |
| T5b | 字节数与声明相符时仍正常完成 | ✅ | ✅ 防误杀回归 |
| T6 | 凭据过期 → 明确「已失效」 | ❌ 当匿名静默处理 | ✅ warning 单独说明需重新 `auth qq` |
| T7 | 网络失败 → 不是 `not_found` / `need_login` | ✅ | ✅（仍记成 `internal`，见 §6 后续） |
| T8 | `vkey` 接口 `code≠0` → `vkey_failed` | ✅ | ✅ |

## 6. 本批明确不做

- 不访问真实账号、不下载真实歌曲（线上验证另立手工记录）；
- 不实现 320K/FLAC 的任何「绕过」手段——本批只保证**如实报告**受限；
- 不推广到网易云/酷我/酷狗（同样问题存在，记为后续，避免一次改四个引擎）；
- 不改 `schema=2` 字段集合，只复用已有的 `Format.available / reason`。

### 后续（已确认存在，本批未动）

| 项 | 现状 | 建议 |
|---|---|---|
| 网易云 / 酷我 / 酷狗 | 同样存在「未放行档直接丢弃」与「显式档位静默降级」 | 按 QQ 的做法逐个搬，每个引擎配自己的合成响应测试 |
| 网络错误分类 | `fetch` 失败最终落到 `fail()` → `code=internal` | 在 `core/http` 或 `fail()` 统一映射 `network_error`（影响面大，需单独评估） |
| 试听判定的精度 | 只能比「字节数 vs 接口声明」，无法直接读音频时长 | 若要更准，可在端上/桌面用 ffprobe 读时长，但会引入子进程依赖 |

## 7. 相关文件

- 引擎：`ts/src/engines/qq.ts`
- 契约：`ts/src/core/types.ts`（`Format.available/reason`）、`ts/src/core/errors.ts`
- 呈现：`ts/src/cli.ts`（probe 列表）、`web/vue/index.html` + `style.css`（档位按钮按 `available` 置灰、`title` 显示 `reason`）
- 规格与历史实测：`docs/music-channels.md`

## 8. 工作包交付记录（2026-10-27）

**改动范围**

| 文件 | 变更 |
|---|---|
| `ts/src/engines/qq.ts` | `loadCredential` 增加 `expired`；四档全量进 `formats`（`available/reason`）；全档被拒区分 `filtered`/`need_login`；`get` 不再静默换档；新增 `incomplete_media` 判定；去掉「歌曲付费或账号无对应会员」的推断式文案 |
| `ts/tests/qq-probe.test.ts` | 新增 10 条合成响应用例（改写 `globalThis.fetch` + 临时 `LOCALAPPDATA` + `VDL_FFMPEG` 指向不存在路径） |
| `ts/src/cli.ts` | probe 列表打印不可用档位与原因 |
| `web/vue/index.html` / `style.css` | 档位按钮 `title` 显示原因，`:disabled` 有可见样式 |
| `docs/design/qq-capability-baseline.md` | 本文（数据流 + 已知/未知 + 用例 + 交付） |

**运行命令与结果**

```
bun test ts/tests/qq-probe.test.ts   → 10 pass / 0 fail（改前 5 pass / 5 fail）
bun test ts/tests                    → 111 pass / 0 fail（原 101 + 新增 10）
```

**脱敏证据**：全部为人工构造的 JSON 响应与临时目录，未访问任何真实账号、未下载真实歌曲、
未记录 cookie / 直链 / 签名。**本轮是「仅离线验证」**，线上档位行为未重新测试。

**未覆盖内容**：会员账号的真实档位、`result=104003` 的确切含义、试听片段的接口标志、
HEAD 在真实 CDN 上的可用性、网易云/酷我/酷狗的同类问题。

**进入下一个工作包的条件**：若要继续，建议顺序是
① 把这个做法搬到网易云（同一套合成响应思路）；
② 统一网络错误码（影响面大，需先定方案）；
③ 真实账号验证必须先取得明确授权，且只在用户自有权益范围内观察。

