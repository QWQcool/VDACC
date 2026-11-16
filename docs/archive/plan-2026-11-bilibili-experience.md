# Plan.md §2.7–2.8 归档（2026-11-10 B站 体验专项 / 收藏夹入口）

> 从 `Plan.md` 整体平移过来（2026-11-16），**内容未改写**，只加了这个头。
> 这两节的每一项都已落地并有真机 / 真实账号的验收记录；主计划只保留结论摘要与链接。
> 归档不是删除：改动这些结论前请先读完全文。

---

### 2.7 2026-11-10 B站 体验专项（扫码登录 / 分析页 / 剪贴板）

用户反馈：「下载体验有点差了，尤其登录账号经常会卡网页」，并要求参考唧唧Down 的做法。
竞品分析（含证据分级与未覆盖范围）已落 [`docs/design/reference-jijidown-notes.md`](docs/design/reference-jijidown-notes.md)，
本节只排期与定验收。**只学机制，不复刻实现**；不绕过会员/付费、不碰 DRM、不修改目标程序。

#### 2.7.1 痛点根因（都能指到我们的代码行）

现在的登录是「弹一个 Edge 让你自己登」：`POST /api/auth/<site>/login` → `ts/src/auth.ts` →
`node ts/src/auth-node.mjs` → Playwright `connectOverCDP` 到系统 Edge 的独立 profile。
所以"卡网页"不是网络慢，是这条链路有四个具体的失败面：

1. 硬依赖三件套：系统 Edge + `node` 在 PATH + `cd ts && bun install`（`playwright-core`）。缺一个，
   错误只落 `console.error('[auth_login_failed]')`，界面只说「刷新状态」；
2. `%LOCALAPPDATA%\vdl\profile` 是单例（Playwright 锁），另一个进程占着就起不来；
3. 用户得在弹出的 Edge 里自己找登录入口；页面慢、风控、广告都会让这一步看起来「卡死」，
   而窗口关掉也不等于失败（要等满 300s 超时）；
4. 手机端只能「看状态」，实际登录必须回到那台电脑。

**关键判断：B站 根本不需要浏览器登录。** 官方扫码是公开 REST（§2.7.2 已实测），
扫码 → 拿 cookie → `nav` 校验，全程 3 个 GET，零浏览器、零 Playwright、零 profile 锁。

#### 2.7.2 事实基础（本轮实测，不是抄结论）

- `GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate`（只带 UA，无 cookie）
  → `{code:0, data:{url, qrcode_key}}`，`qrcode_key` 为 32 位 hex，`url` 是 `account.bilibili.com/h5/...scan-web?...qrcode_key=<key>`。
- `GET .../qrcode/poll?qrcode_key=<key>` → `{code:0, data:{url:"", refresh_token:"", timestamp:0, code:86101, message:"未扫码"}}`。
  **外层 `code` 恒 0，状态在内层 `data.code`**：86101 未扫码（实测）／86090 已扫码待确认／86038 已过期（后两条来自公开文档 + 其文案，待我们实测）。
- 唧唧Down 的日志与上面一致（`code=86101 message=未扫码`、成功后 `has_url=true has_cookie=true timestamp=<非0>`），
  且它自己会在拿不到 cookie 时明确报「登录成功但未收到 Cookie」。
- 它整条登录链路是 Rust 侧 3 个 HTTP + `qrcode` crate 生成 PNG，**没有打开任何浏览器**。

#### 2.7.3 M3 · 排期

**N19 · B站 扫码登录（P0，替代 Edge 弹窗）**

- 新增 `ts/src/auth_qr.ts`（纯函数 + 可注入 fetch，便于单测）：
  - `generateQr()` → `{key, url, qrDataUrl, expiresIn}`；内部调 generate，渲染 PNG data URL（渲染方式见决策 D1）；
  - `pollQr(key)` → `{state: 'pending'|'scanned'|'expired'|'ok'|'error', message, account?}`；
  - 成功路径：**两路取并集**（响应 `getSetCookie()` + `data.url` 查询串），写入 `%LOCALAPPDATA%\vdl\auth\bilibili.json`，
    **保持现有 `storage_state` 形状**（`{cookies:[{name,value,domain,path,expires}]}`）——这样 `cookieHeader()`、
    `verify()`、`bilibili_api.ts` 的 cookie 过滤全部零改动；
  - 写盘后立即调 `nav` 判真（复用 `CHECKS.bilibili`），拿 `uname/mid/vipStatus`；`isLogin=false` 一律报错，不把"文件写了"当"登录成功"。
- 路由（`ts/src/server.ts`）：`GET /api/auth/bilibili/qrcode`（生成）、`GET /api/auth/bilibili/qrcode?key=`（轮询一次，无状态）、
  `POST /api/auth/bilibili/logout`（删凭据）。**轮询由前端发起**（1.5s），服务端不挂后台任务，避免泄漏。
- 前端（`web/vue/`）：设置面板「账号」区的 B站 改成弹层——二维码图 + 四态文案 + 「刷新二维码」+「关闭」；
  已登录显示 `昵称 [大会员]` + 「退出」；未登录显示红字「未登录 · 仅 480P」。
- CLI：`vdl auth bilibili --qr` 在终端打二维码（ASCII）+ `--timeout`（默认 180s），成功打印昵称不打印 cookie。
- 兜底保留：`POST /api/auth/bilibili/login` 不删（Edge 方案留作对照），网易云/QQ 本期不动（它们没有等价的公开扫码接口）。
- 已知风险：扫码成功后 cookie 究竟来自 `Set-Cookie` 还是 `data.url`，本轮**无法实测**（不能替你扫码）；
  两路并集 + `nav` 判真足以覆盖；若只拿到 URL 里那几个而缺 `buvid3`，再按需补 `GenWebTicket`（不预做）。

**N19 落地状态（2026-11-10 当天）**：核心 + 接线 + 界面全部完成，**只差一次真人扫码**。

- `ts/src/auth_qr.ts`：`generateQr / pollQr / fetchAccount / parseSetCookie / cookiesFromUrl / mergeCookies / logoutBilibili`，
  fetch、二维码渲染、数据目录、时钟都可注入。
- 状态比计划多一档 **`unverified`**：凭据已落盘但 `nav` 没验通（网络问题）。这种情况**不能报 ok**——
  报绿会让用户以为能下 4K，其实是空的。`nav` 明确说未登录时才删文件（`saved:false`）。
- 路由三条（生成 POST / 轮询 GET / 退出 POST）+ CLI `auth bilibili --qr`（终端二维码，过期自动换一张，最多 3 张）+ 前端弹层。
- 单测 **16 条**（`ts/tests/auth_qr.test.ts`，假 fetch，不联网）；全量 `bun test ts/tests` **225 pass**。
- 实测（不扫码）：真接口 generate 出 32 位 key + 5618 字符 PNG data URL；poll 回 `pending/未扫码`；
  Playwright 功能自检：点「登录」→ `.qr-img` 出现（`data:image/png;base64,` 5638 字符）→ 3.5s 后文案变「未扫码」→ 零 page error。
- 两个现场发现（写成测试钉住）：① `nav` 的 `vip_label` 在真实账号下是**对象** `{path,text,label_theme,color}`，
  不是字符串，`String()` 会得到 `[object Object]`；② 冒烟必须设 `VDL_AUTH_DIR` 指到临时目录。

**真实扫码验证（2026-11-10，用户本人）**：B站 ✅ 通过。
`auth/bilibili.json` 由 27 条旧 cookie（Edge 时代）变成 **8 条**（SESSDATA / bili_jct / DedeUserID /
DedeUserID__ckMd5 / sid / default_sites / ticket / first_domain），写入时间 17:44:31；
`/api/auth` 复核 `ok=true · 晨星成焰`；同一条竖屏视频 probe 的最高流（1080×1920 / 60fps / 10.3Mbps）与
扫码前**完全一致**——说明这 8 条够用，没有出现"能看 nav、不能下清晰档"的半吊子状态。
顺带发现并修掉一个真 bug：档位按宽归档，竖屏 1080×1920 的宽 1080 落在 854 与 1280 之间 → 被标成「480P」
（用户会以为登录没生效）。改成按**长边**归档（横屏=宽、竖屏=高），宽银幕仍按宽，行为不变。

**网易云扫码：试过，撤掉（2026-11-10 用户决定）**。服务端日志记录了完整序列：
`801 等待扫码` ×6（约 9 秒）→ 直接 **`8821 请切换其他登录方式或升级新版本再试`**，**全程没有 `802`**。
已排除的假设：无效 key 返回 `800`（不是 8821）；`type=1/3` 都能生成并稳定等待；请求头/方法（GET、
带 Content-Type 的 POST、带 Accept）三种都试过，都是 801。所以不是我们参数写错，是这条登录方式
对当前账号/客户端被判拒。**结论**：`QR_SITES` 只留 `bilibili`，网易云适配器删除、
恢复走电脑上的 Edge；QQ 音乐本就没做扫码。
保留两点：① 弹层里的「改用电脑 Edge 登录」兜底（扫码不行不是死路）；
② 服务端 `[qr] site=… state=… code=…` 日志（不含 cookie），平台哪天改了能立刻看出来。

**本轮事故与修复（要记住）**：第一次冒烟直接对着真实用户目录跑，`POST /api/auth/bilibili/logout` 把
`%LOCALAPPDATA%\vdl\auth\bilibili.json` **真删了**。同目录的 `bilibili.cookies.txt`（Netscape 备份）还在，
用它还原出 27 条 cookie，`nav` 复核 `isLogin=true / 晨星成焰 / 年度大会员`，凭据已恢复。
因此加了 `VDL_AUTH_DIR` 开关（`auth.ts` 与 `auth_qr.ts` 都认），并复跑一次隔离冒烟确认
「真实凭据 7139 字节前后一致」。**结论：破坏性接口的冒烟必须用隔离目录，这一条以后当规矩。**

**N20 · 分析页（P0）**

现状：`POST /api/probe` 已经返回 `media.parts[]`（多 P）与 `formats[]`（含 `subtitles[]`），
但界面只有一个输入框 + 任务列表，等于把分析结果丢了。
新增视图（`view` ref 切换，不引路由库）：封面 / 标题 / UP主 / BV / 简介 / 共 N P；
每 P 卡片：`第 N P · 标题`、时长、`CID`、画质 chip（用 probe 实际返回的档位，文案「将下载 1080P60 · h264 · 1.2GB」）、
资源五选（视频 / 音频 / 弹幕 / 字幕 / 封面）、`下载到…`；顶部 `前往B站`（普通 `<a target=_blank>`，不走 shell）、
`重新解析`、`批量下载`（逐 P `POST /api/jobs`，复用 worker 池 + 提交去重）。

- 契约：`Part` 增 `cid?: number`（可选，仅 B站 有）。**不加** UI 专用字段。
- 单 P 视频要不要也回 `parts[1]`：见决策 D4（唧唧 的界面单 P 也显示「第 1 P」）。
- 封面：当前 UI 直连 `i0.hdslb.com`（`index.html:174`）。是否裂图**未实测**；只有实测被拦才加服务端代理，不预先扩接口。

**N20 落地状态（2026-11-10）**：✅ 视图、契约、逐 P 资源选择都做了，**音频单独下没做**。

- 契约：`Media.desc?`（简介，只给界面看）、`Part.cid?`；
  **单 P 也回 `parts[1]`**，且单 P 的 `Part.url` 与 `media.source_url` **完全相同**——
  否则两个字符串在后端"同链接同档位去重"里会被当成两个视频（分析页与直接解析会各建一个任务）。
- 界面：标题下方加 `前往B站` + `重新解析`，简介 3 行截断（CSS clamp，不截字符串）；
  分P 行补 `CID`、画质 chip（`1080P60` 这种，取当前选中档位的 label+fps）、每 P 三个资源 chip。
- 逐 P 资源：`partOpts = { [index]: {cover, subs, danmaku} }`；全局开关语义改成**"套用到全部 P"**
  （`persistSidecars` 同时调 `applySidecarsToAll`），单 P 还能再改。换 P 重新解析会保留已有勾选。
- **音频**：我们只产出"视频+音频合并"的成品，没有 audio-only 通路。界面上给了一个
  **禁用**的「音频」chip 并在 tooltip 说明，而不是摆一个点了没反应的开关。要做真 audio-only
  需在 `bilibili_api` 加"只取 dash.audio → .m4a"的分支，列为后续 N20b，不在本轮范围。

**N19b / N19c 落地状态（2026-11-11）**：✅ 完成。

- **N19b 登录后能力自检**：扫码成功后，若输入框里已有链接，**自动重解析一次**并把结果写成
  「登录成功，当前最高档：1080P60」。没有链接就跳过——不凭空造一个视频去探测。
  这条针对的是「nav 说已登录、playurl 只给 480P」这种真实出现过的半吊子状态。
- **N19c 失败可诊断**：`auth.ts` 增加进程内 `lastError` 记录（`noteAuthError / clearAuthError / authErrorOf`，
  信息截断 300 字），三个写入点——Edge 登录失败、扫码 `state==='error'`（带平台原始码如 `qr_8821`）、
  成功即清除。`GET /api/auth` 每行多一个 `lastError {at, code, message}`，设置面板在对应站点行下方用警示色显示
  并附时间。以前这些只写一行 `console.error`，界面上永远只说「刷新状态」。
- 验证：单测 4 条（记录/清除/无记录返回 null/超长截断）+ 全量 251 pass；
  隔离目录起服务冒烟：`/api/auth` 三行都带 `lastError` 字段、设置面板渲染正常、零 page error。

**N19a 落地状态（2026-11-10）**：🟡 做到「记录 + 判断」，**自动续期没做**，理由在下面。

- 扫码成功时把 `data.refresh_token` 与 `timestamp` 存进凭据文件的 `meta`（`cookies` 数组形状不变）。
  **注意**：今天那次扫码发生在本功能之前，所以现存凭据里没有 `meta`，界面会如实写「这次登录未记录 refresh_token」。
- 新增 `ts/src/auth_renew.ts`：只读调用 `cookie/info?csrf=<bili_jct>`，
  返回 `{state, needsRenew, canAutoRenew, message}`；`-101` → `need_login`，网络失败 → `error`（不冒充“需要续期”）。
  路由 `GET /api/auth/bilibili/renew`、CLI `auth bilibili --renew [--json]`、设置面板「续期状态」一行。
- **为什么不做自动续期**：真链路是 `cookie/info` → `correspondPath`（用 B站 公钥 RSA-OAEP 加密 timestamp）→
  抓 `/correspond/1/<correspondPath>` 里的 `refresh_csrf` → `POST cookie/refresh` → `POST cookie/confirm`。
  公钥与 `correspondPath` 细节拿不到可信来源；**猜一个公钥等于埋雷**，而 refresh 成功但 confirm 没做会让旧 cookie 失效——
  “帮用户续期”变成“把用户踢下线”。所以先只报告状态，真需要时重新扫码（现在 10 秒）。
- 实测（真实凭据）：`cookie/info` 返回 `{refresh:false, timestamp:1794304882640}`；
  CLI 输出 `state=ok / needsRenew=false`。单测 7 条（无凭据、缺 csrf、不需要续期、需要续期+有 token、-101、网络失败、文件损坏）。

**N21 · 剪贴板 →「立即分析」（P1）**

唧唧Down 用 Rust 读 Win32 剪贴板；我们是浏览器页面，能力边界不同，分两层且都如实告知：

- 主路径：`navigator.clipboard.readText()` 轮询（1.5s，仅 `visibilityState==='visible' && hasFocus()`，与上次内容去重）。
  `http://127.0.0.1` 属安全上下文可用，但**首次需要用户授予剪贴板权限**；未授权时静默降级、不报错刷屏。
- 兜底：`window` 上监听 `paste`，粘到页面任意位置即触发（零权限）。
- 命中 → 右下角卡片「检测到 <平台> 链接 · 立即分析 / 忽略」；点「立即分析」→ probe → 进 N20 的分析页。
- 设置项 `clipboardWatch`，默认值见决策 D2。

**N22 落地状态（2026-11-10）**：✅ 完成。

- 探测时把「再取一遍 DASH 并重填 `urlCache`」记成闭包（`refresher`）；普通视频重取
  `/x/player/playurl`，番剧重取 `/pgc/player/web/v2/playurl` **并再补一次 SSR 的 4K 档**
  （否则刷新后会掉档，等于用一次过期换了永久降级）。
- `streamTo` 拆成「单次下载 `streamOnce`」+「重试壳 `streamTo`」：只有 **403 / 410** 触发刷新，
  最多 2 次；404（被删/限权）与 5xx（交给任务级重试）**不重试**。
  续传由 `.part` + `Range` 承担，所以重试不会重下已完成的字节。
- 刷到上限仍失败时报 `url_expired`（「刷新 2 次后仍失败」+ 下一步建议），不再只给一个 `http_403`。
- 验证：单测 B7（403 → 刷新 1 次 → 继续下完）、B8（刷新 2 次仍 403 → `url_expired`，且 playurl 恰好被调 3 次）；
  全量 240 pass；另做一次**真机下载**：同一条竖屏视频 65.10 MB / 1080P 落盘并合并成功（新档位标签同时被验证）。

**N22 · 播放地址过期自动重取（P2）**

唧唧Down 有「刷新播放地址重试次数已用尽」这条真实路径；我们下载中遇 403 直接失败。
`bilibili_api.ts` 下载循环里：403/410 且已有 `.part` → 重新解析取新 url → 带 `Range` 续传，最多 2 次；
仍失败返回 `url_expired` + `next_action`，不把"地址过期"说成"下载失败"。

#### 2.7.4 明确不做

- 内嵌 webview 站内搜索、收藏夹/合集抓取（需桌面壳；Plan §2.6 N02 已定不做收藏夹）；
- 托盘 / 右键菜单 / 自动更新器 / 单实例锁（桌面壳特性；项目定位仍是「内核 + 可选 Web GUI + Skill」）；
- 复刻它的 cookie 加密格式（`{version,nonce,ciphertext}`）；要加密应走 Windows DPAPI，另立议题；
- 把「1080P60」当上限卖点——我们已能拿 4K，并能补页面 SSR 的 `id=122` 档。

#### 2.7.5 验收门槛

- 单测（`bun test ts/tests`，假 fetch，不发真请求）：poll 四种 `data.code` 的状态映射、cookie 两路并集与去重、
  `expires` 归一、`Part.cid` 透传、`url_expired` 重取分支。
- 手工真机（不写成用例）：`vdl auth bilibili --qr` 扫码 → `vdl auth --status` 出昵称；
  4K 番剧 probe 档位不降级；分析页批量下载两个 P 都落盘。
- **不新增** UI/视觉/耗时类测试（AGENTS 红线 4）；分析页只验「按钮发出对应请求、错误能显示、字段对得上」。

#### 2.7.6 待决策

| 编号 | 问题 | 选项 | 建议 |
|---|---|---|---|
| D1 | 二维码在哪渲染 | A 服务端加 `qrcode`（MIT、纯 JS，CLI/Web 共用）；B 前端 vendor 一份；C 自写 `core/qr.ts` | **A**：一处实现喂两端，自写等于重造 RS 纠错 |
| D2 | 剪贴板监听默认值 | 关 / 开 | **关**：要权限就得先问，不能默认弹授权框 |
| D3 | 是否顺带做收藏夹 | 做 / 不做 | **已定：做，但只做「选择入口」**（用户 2026-11-10 改口径）。事实更正：唧唧Down 确实有，且它也是**分页列表 + 逐条下载**（IPC 只有 `get_favorite_detail`，无批量命令，见 notes §5.1）→ 与我们想做的形态同构，落地方案见 §2.8 N23 |

> 2026-11-10：用户确认本计划通过；D3 明确不做，D1/D2/D4 按表中建议执行（要改直接说）。

#### 2.7.7 二轮静态取证与计划微调（同日）

当天补装了 **Ghidra 12.2 + JDK 25**（都装 D 盘：`D:\Tools\{jdk,ghidra_12.2_PUBLIC}`，
工程与脚本在 `D:\Tools\ghidra-work`），对目标做了三轮迭代取证，过程、踩坑与命中地址表记在
notes §9。**IDA 没做**：Pro 需商业授权不能自动下载，Free 不支持插件（REA 适配器要插件）。

采信三条（都有交叉引用支撑）：

1. `set-cookie` 字符串引用自**轮询函数** → 它的 cookie 主路径是读响应头，不是只解析 `data.url`；
2. 整个二进制没有 `cookie/info` / `cookie/refresh` / `GenWebTicket` → **它没有登录态续期**；
3. 无 `w_rid` / `img_key` / `mixinKey` 却调 `x/player/wbi/v2` → 字幕**没签名**，正是我们踩过的"字幕串号"坑，不抄。

由此把计划改成三处（都是"比它多做一步"，不是抄）：

- **N21 落地状态（2026-11-10）**：✅ 完成（默认关闭）。

- 设置面板新增「剪贴板」开关（默认**关**，见决策 D2）：打开时**当场**读一次剪贴板以触发浏览器授权，
  被拒就关掉开关并说明「仍可 Ctrl+V 粘贴」，不留一个假的“已开启”。
- 轮询 1.5s，只在 `visibilityState==='visible'` 且 `hasFocus()` 时读；与上次内容去重；命中只弹右下角卡片，
  **绝不自动解析**——点「立即分析」才填输入框并走 probe。
- 兜底：全局 `paste` 监听（零权限），输入框内粘贴不重复弹。
- 只对“像下载目标”的链接（B站/抖音/网易云/QQ/酷我/酷狗/b23）弹卡片，普通网址不打扰。
- 验证（Playwright，授予剪贴板权限）：开关可开启 → 写入带 `?spm_id_from=…` 的分享文案 → 卡片出现并抽出链接 →
  点「立即分析」→ 输入框被填、`/api/probe` 收到该 URL、卡片消失、零 page error。

**N19a · 凭据续期（P1，新增）**：poll 成功时把 `refresh_token` 一并存进 `auth/bilibili.json` 的旁挂字段
  （cookie 数组不动，保持 `storage_state` 形状）；启动与每 24h 用 `cookie/info` 问一次是否需要续期，
  需要则 **POST** `cookie/refresh`（实测 GET 返回 `Method Not Allowed`）拿新 cookie 并原子落盘。
  **边界**：两条接口只在未登录态验证过存在性（`-101 账号未登录`），语义要首个真实扫码后确认；
  确认不通过就降级为"只提示即将过期，不自动续"。
- **N19b · 登录后能力自检（P0，并入 N19）**：不只回昵称，还跑一次真实 probe 报「实际最高档」。
  否则会出现"顶栏显示已登录、下载仍只有 480P"这种假成功——我们有 probe，唧唧只有昵称。
- **N19c · 失败可诊断（P0，并入 N19）**：`GET /api/auth` 增 `lastError { at, code, message }`，
  界面直接说清上次为什么失败（现在只有一行 `console.error`）。

另外两处定调：

- **N22 的重试次数**：它的次数取不到（Rust 把数值优化成间接引用）。我们**自己定 2 次**，并在注释里写明
  这是设计选择而非对标结果；同时在 probe 层加 **60s 短缓存**（它日志里同一视频 3 秒内请求了两次 playurl）。
- **N20 实现约束**：分析页的封面 `<img>` 必须带 `referrerpolicy="no-referrer"`。这不是新发现——
  `index.html:174` 已经这么做，实测 hdslb 对 `Referer: http://127.0.0.1:8765/` 返回 **403**、
  无 Referer 返回 200。新页面照抄这行，别写裸 `<img>`。

**仍然不做**（有证据也不做）：复刻它的凭据加密格式、内嵌 webview 站内搜索、收藏夹/合集、
protobuf 弹幕（无 `dm/web/seg`，解析成本高、当前 XML 够用）。

本轮仍**没有改一行代码**，只更新了计划与取证记录。

### 2.8 2026-11-10 追加：收藏夹/合集 = 「批量选择入口」（N23）

对手同构已确认（notes §5.1）：它是**分页列表 + 逐条下载**，后端 IPC 没有任何批量命令。
所以我们做的是「选择入口」，**不做「一键全下」**——既与它一致，也符合"用户自己决定下哪些"。

**契约（新增，不动 `schema=2`）**

```
POST /api/collection   { url? | id?, kind?: 'fav'|'season', page?, pageSize? }
→ { ok, source:'bilibili-fav', title, owner, total, page, pageSize, hasMore, items[] }

items[] = { bvid, title, author, cover, duration_ms, url, state: 'ok'|'gone'|'private' }
```

- 接口（对手用的是同一套，可直接复用）：
  - 收藏夹：`x/v3/fav/resource/list?media_id=&pn=&ps=&order=mtime&type=0&tid=0&platform=web`
  - 合集：`x/space/fav/season/list?season_id=&pn=&ps=`
- ID 解析接受三种写法：`space.bilibili.com/<mid>/favlist?fid=<id>`、`?media_id=<id>`、裸数字；
  合集接受 `collectiondetail?sid=<id>`。解析不出来给 `bad_input` + 明确文案（不吞成"下载失败"）。
- 前端：复用 N20 的卡片；**默认全不勾**；底部「下载选中（N）」；
  `state != 'ok'` 的条目显示「已失效 / 私密」且**不可勾选**，不能静默过滤掉（那样用户会以为收藏夹少了东西）。
- 明确不做：一键下载整个收藏夹；自动跨页续拉（用户点「加载下一页」，与 `/api/album` 的 `nextOffset` 一致）。

**验收（手工，不写成用例）**：一个 ≥2 页的真实收藏夹能翻页；勾 3 条只产生 3 个任务；
含失效条目的收藏夹里失效项如实标注且勾不上；未登录时给出"收藏夹需要登录"而不是空列表。

**N23 落地状态（2026-11-10）**：✅ 服务端 + 界面都做了，**差一个真实收藏夹 ID 的联调**。

- 新增 `ts/src/engines/bilibili_collection.ts`：`parseCollectionTarget`（favlist?fid / media_id / collectiondetail?sid /
  纯数字 + kind 提示）、`fetchCollection`（收藏夹与合集两套 URL，`pn`/`ps` 分页，`has_more`）。
- **对结构做硬校验**：`data` 为 null、既无 `medias` 也无 `archives` 都抛 `collection_shape`，
  绝不把"解析不出来"说成"空收藏夹"。`-101` → `need_login`，`-403` → `collection_private`，都带下一步。
- 失效条目：`bvid` 为空或 `attr=9` 一律标 `state:'gone'` **保留在列表里**（勾不上），不静默过滤。
- 界面：粘收藏夹/合集链接直接进列表卡（走后端 `/api/collection`，不经过 probe）；默认全不选；
  勾选后「下载选中（N）」逐条建任务，档位留空用引擎推荐档，资源开关沿用全局偏好。
- 验证：单测 11 条（链接解析 / 分页参数 / 映射 / 三种错误分支，假 fetch）；
  界面自检（桩数据）：3 行渲染、失效行 `disabled`、勾 2 条只发 2 个 `/api/jobs` 请求、零 page error；
  真实接口用无效 `media_id` 验证诚实报错（`collection_shape`）。全量 `bun test ts/tests` **237 pass**。
- **真实收藏夹已验（2026-11-11，用户提供的 `fid=3473916881`）**：形状假设全部对上——
  `title=unity`、`owner=晨星成焰`、`total=6`、`hasMore=false`、6 条全 `ok`，
  首条 `BV1KU4y1x7jH` / 126069000ms。界面：卡片标题/UP主/总数正确、默认一条不勾、
  勾 2 条只发 2 个 `/api/jobs`（URL 是视频页而不是收藏夹链接）、零 page error。
  **顺手修了两个真 bug**：
  ① **翻过末页被误判成形状错误**：6 条时请求 `pn=2`，接口回 `data: {info, medias: null, has_more: false}`
  （不是 `data: null`），旧代码一律抛 `collection_shape`。现在 `has_more === false` 时返回空页。
  ② **第 2 页把总数覆盖成 0**：`info.media_count` 只在第一页有，前端 `{...data}` 会把 `total` 写成 0，
  界面显示「已列 20 / 0」。现在保留首屏 total，并按 bvid 去重再追加。
- **仍未验证**：合集（`season`）。手上只有收藏夹链接，合集走的是另一条接口
  （`x/space/fav/season/list`），形状按同一套 `archives`/`has_more` 兼容，但没有真实 `sid` 跑过。