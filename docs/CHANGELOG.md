# CHANGELOG

> 只记「用户可感知的变化」与「验证结论」。设计与取舍见 `Plan.md`。
> 每个版本的 GitHub Release 从这里摘取。

## 未发布

- **发布收口（N05）与减少动态效果检查**：新增 `tools/release_baseline.cjs` + `docs/release-baseline.json`
  记录 Skill 包体积基线（exe **91.95 MB** / zip **42.58 MB** / 3 个文件；两次构建漂移 0.0%），
  漂移 ≥25% 直接失败，避免「这次发的包为什么大了一倍」靠记忆；**只记体积不记哈希**，
  完整性仍由 `manifest.json` + `SHA256SUMS` 负责。新增 `docs/RELEASE.md` 检查清单
  （版本号四处同步、必跑项、CI 手动触发、标签/Release、回滚），并如实标注**干净机器验收仍未做**。
  界面侧新增 `tools/reduced_motion_check.cjs`：用真实 Edge 把 `prefers-reduced-motion: reduce`
  下的**计算后样式**读出来（不是查 CSS 里有没有 @media 这种恒真断言），并用 `no-preference`
  做对照防止误报；四个探针（`.btn`/`.input`/`.bar i`/`.slideover`）在 reduce 下全部 0s/无动画，
  对照组有 0.15s/0.22s 过渡与 `slide-in` 动画。顺手补了 `scroll-behavior: auto !important` 兜底。
- **酷我：接口没给元数据时，标题从音频文件自带的 ID3 里取**：酷我 `songinfoandlrc` 会偶发
  `status=301 音乐查询失败`（连续请求更容易触发），此时文件名会变成
  `474678847_kuwo-474678847_128kbps.mp3`。但 CDN 给的 mp3 自己带 ID3（实测
  `TIT2=花海 / TPE1=周杰伦`），所以新增 `core/tags.ts`（纯 JS 解析 ID3v2.2/2.3/2.4 文本帧，
  支持 latin1 / UTF-16 BOM / UTF-8，不依赖 ffprobe），下载完成后只读文件头 256KB，
  用标签里的标题/歌手重命名；读不到就保持 rid 命名，不猜。
  真实实测：`474678847_花海 (DJ 阿若版)_128kbps.mp3`，3,368,054 字节 / 210.4s / 128kbps，
  ffprobe 标签正确。测试 147 → **154 pass**。
- **网易云补上 128K / 96K 低档**（真实环境驱动）：原来只探「无损 / 320K」，**没有会员权益的账号
  一首歌都下不了**，连平台对免费曲开放的 128K/96K 也拿不到。现在四档全探（999000/320000/128000/96000），
  免费曲对未开通权益的账号至少能下 128K。另外按「字节相同」判重：实测 128K 与 96K 会返回不同 URL
  但字节完全相同的文件，直接列两条会出现「128K 3.93MB / 96K 3.93MB」的自相矛盾列表，现在合并成一条
  并说明原因（被判重的档位 id 仍可通过 `--format` 使用）。
  真实实测：免费曲 id 2007983648 → 无损 14.62MB / 320K 9.82MB / 128K 3.93MB，`--format standard`
  下载 4,179,995 字节（mp3 129,918 bps、257.4s、带封面）；会员专享曲（id 186016）四档仍全部 `code=404`
  ——补档位不会让 VIP 曲变得可下。测试 145 → **147 pass**。
- **B站：接口错误不再一律说成「下载失败」，无声视频与截断不再当成功**（ReversePlan 工作包 1–2，
  **仅离线验证**）：`apiJson` 原来把所有接口码记成 `download_failed`——那时还没开始下载；
  现在 HTTP 错误记 `http_<status>`、风控返回 HTML 记 `api_error`、`code=-404` 记 `not_found`、
  其它业务码记为 `api_error` 并带 **`code=…` + 平台原话**（如「大会员专享限制」），不替用户解释。
  `dash.audio` 为空时 probe 会明确提示「下载结果会是无声视频」（原来静默产出无声音文件且
  `warnings` 恒空）；未登录也会提示清晰度以匿名放行为准。下载侧新增完整性校验：
  每条轨实际字节 < Range 探测值 × 95% 报 `incomplete_media`，**判定在 ffmpeg 合并之前**。
  新增 6 条合成响应测试，测试 139 → **145 pass**。线上行为未复测。
- **酷我/酷狗：不再把用户指去「登录」，也不再误称「试听档」**（ReversePlan 工作包 1–2，
  **仅离线验证**）：两家**都没有登录能力**，原来全档不可用时却报 `need_login`（用户被指进死胡同），
  现在改报 `filtered` 并说明「公开通道只放行部分曲目」；显式 `--format` 不存在时改报 `no_stream`
  （原来静默换成别的档）；下载字节 < 探测到的总字节 95% 时报 `incomplete_media`（原来只挡 <100KB）。
  酷狗另修两处措辞：把公开档称作「试听档」是错的（实测通常是整首 128kbps），
  以及把「搜索接口失败」说成「付费曲或账号未登录」——现在三态分开
  （获取失败 / 搜索没命中 / 接口标记付费 `pay_type≠0`）。新增 11 条合成响应测试，
  测试 128 → **139 pass**。线上行为未复测。
- **网络错误不再说成「内部错误」**：各引擎直接用 `fetch`，断网/DNS 失败/超时抛的是
  `TypeError`(`fetch failed`)/`AbortError`，原来统一被 `fail()` 记成 `internal`——用户看到
  「内部错误」会往程序 bug 方向查。现在归成 `network` 并给出「检查网络或稍后重试」的下一步，
  普通程序错误仍是 `internal`；网易云引擎早就是这个码，本次把其余引擎对齐（`ts/src/core/errors.ts`）。
  另补 `/api/preview` 的作用域回归测试：核实后**预览不是缺陷**（整个请求包在 `runOperation` 里，
  probe 与 preview 共用一个作用域），两条用例把该前提钉住。测试 120 → **128 pass**。
- **网易云：档位与完整性如实报告**（ReversePlan 工作包 2，**仅离线验证**）：
  `probe` 两个档位（无损/320K）全部返回，未放行的 `available:false` + `reason` 带平台 `code`
  （如 `code=404`），`warnings` 不再恒为空；详情查不到歌改报 `not_found`（原来是 `filtered`）；
  全档被拒的消息带上 code；显式指定档位不可用时报 `no_stream`，不再静默降到另一档；
  下载字节 < 接口声明整曲大小的 60% 时报 `incomplete_media`（无损档的试听片段也能上百 KB，
  原来只有 <100KB 才拦）。新增 9 条合成响应测试（`ts/tests/netease-probe.test.ts`），
  测试 111 → **120 pass**。线上档位行为未重新验证。
- **QQ 音乐：受限与未知不再伪装成可用**（ReversePlan 工作包 1–2，**仅离线验证**）：
  `probe` 现在返回全部四个档位，未放行的档位 `available:false` + `reason` 带真实 `result` 代码
  （如 `104003`），不再用「歌曲付费或账号无对应会员」这种没有证据的推断；有凭据且全档被拒报
  `filtered`、无凭据才报 `need_login`；凭据过期单独提示；显式指定档位不可用时改报 `no_stream`
  （原来会静默换成别的档，用户以为拿到 320K）；下载字节 < 接口声明整曲大小的 60% 时报
  `incomplete_media`，不再把试听片段报成「完成」。CLI 打印不可用档位原因，界面档位按钮
  `:disabled` 有可见样式并带 `title`。新增 10 条合成响应测试（`ts/tests/qq-probe.test.ts`），
  测试 101 → **111 pass**。线上档位行为未重新验证。
- **任务管理**：`DELETE /api/jobs/:id`（只允许已结束任务）、`POST /api/jobs/clear-finished`、
  `POST /api/jobs/retry-failed`；界面在任务卡加「删除」「打开文件夹」（复用 `/api/reveal`），
  列表头加「重试失败 (N)」「清空已结束」。删除通过 SSE `job-removed` 推给所有界面，无需刷新。
  实测：删除 → 1 条剩余；批量重试 → created=1；清空 → 3 条移除、界面即时归零
- **设置内诊断**：`GET /api/doctor` + 设置面板「本机诊断」，手机/网页上也能看到
  ffmpeg、组件与 SHA256、配置、输出目录、三站凭据状态（只读、不下载）

## v3.4.2 — 2026-10-27

**前端模块化与分发清单**

- **前端拆分（N03 完成）**：`app.js` 628 → 481 行，拆出 `i18n.js`（词条）、`api.js`（fetch/JSON）、
  `format.js`（size/dur/platformClass/jobName）、`jobs.js`（终态保护 upsert + 分组）、
  `overlays.js`（Esc/焦点循环/背景 inert/滚动锁）；页面按 vue → i18n → api → format → jobs → overlays → app 加载
- **布局回归脚本**：`node tools/ui_shots.cjs <base> <token>` 覆盖浅/深 × 中/英 × 390/768/1440，
  检查横向溢出、关键元素与控制台报错，截图落 `docs/design/ui/shots/`（不入库）。实测 12/12 PASS
- **Skill 包清单与校验**：`build_skill_ts.py` 现在生成 `manifest.json`（版本、构建时间、每文件
  字节与 SHA256、合计体积）和 `SHA256SUMS`，两者一起打进 zip；新增
  `python tools/verify_skill_ts.py dist/video-acquire-ts` 逐个核对（篡改一个字节即退出码 1）。
  实测包内 5 个条目、vdl.exe 91.9 MB、zip 42.6 MB。干净机器验收仍未做。


## v3.4.1 — 2026-10-27

**并发、去重与上游变化适配**

- **ffmpeg 改异步（N01 第一步）**：合并音视频、写标签、封面缩放从 `spawnSync` 改为
  `Bun.spawn`（`core/ffmpeg.ts`），长任务期间服务和 SSE 不再被卡住；取消会在 200ms 内
  kill 子进程（`DownloadCancelled`），找不到 ffmpeg 用 `code=-2` 与「跑失败」区分。
  实测 B站 合并 9.48 MB（h264+aac）与 QQ 标签写入均正常。
- **并发下载（N01 完成）**：设置里的并发为 1–4，服务端 worker 池按 `concurrency` 起多个任务；
  新增 `core/dest.ts` 目标路径预留（同时写同名文件才加 ` (2)`，顺序重下仍覆盖），
  七个引擎（抖音 / B站 / 嗅探 / 网易云 / QQ / 酷我 / 酷狗）全部接入并在 `finally` 释放；
  网易云、QQ 的临时封面从固定 `__vdl_cover.img` 改为跟随目标文件名（并发时会互相覆盖的真实 bug）。
  实测 3 个抖音任务同时跑（9.7% / 5.2% / 39.1%），取消其中一个后另外两个正常完成；
  限速仍按「每条流」计算，设置面板已注明「总带宽 ≈ 并发 × 限速」
- **酷我元数据降级**：2026-10 起 `songinfoandlrc` 会间歇性返回空 `songinfo`（同一 rid 前后两次不同），
  改为 3 次重试取「信息最多」的响应，仍为空则用首行歌词「标题 - 歌手」兜底，
  再不行用 rid 当标题并在 warnings 里说明——不再直接报「查不到这首曲子」。
  实测《花海》3,368,054 字节 mp3 + 1,337 字节 `.lrc`
- **任务提交去重**：同一链接 + 同一档位已在排队/下载时，`POST /api/jobs` 复用原任务
  （响应带 `reused`），不再创建第二个写同一目标文件的任务；界面提示「相同任务已在队列，未重复创建」。
  实测双击同一抖音 1080P：第二次 `created=0 / reused=1`、任务总数仍为 1。

**抖音详情请求抗风控（重试 + 独立错误码）**

- 抖音 Argus 会**概率性**拦截 `aweme/detail`，有两种表现：HTTP 403
  （`Blocked by ArgusSecurityPlugin Uifid Not Found`）或 **HTTP 200 + 空 body**。
  后者原先直接落到 `bad_json`，看起来像接口改版，实际是风控
- 新增 `fetchDetail()`：最多 3 次退避重试（300ms / 900ms）。每次重试都
  **清空 cookie 重新注册 ttwid、重新取 uifid、重新签名**——复用同一套 cookie 和签名重试无效，
  因为签名里含 timestamp
- 新增错误码 `blocked`：连续 3 次仍被挡才报；`next_action` 给出换网络/关代理/浏览器兜底三条路
- `CookieJar.clear()` 与纯函数 `isBlockedResponse()`；新增 5 组测试，测试 **90 → 95**
- 实测：整段分享文案 probe 成功（`7699759219418991887` / 1080×1440 / 23.6s），
  行为与此前一致，正常路径无回归

## v3.4.0 — 2026-10-26

**分批、账号状态、doctor 与真机体验**

- **`doctor` 只读诊断**：`bun ts/src/cli.ts doctor [--json]` 检查 Bun/平台、ffmpeg（缺失时给安装与
  `VDL_FFMPEG` 指引）、yt-dlp 组件与校验值、配置可读性、输出目录可写、三站本地凭据；
  只有阻塞项（fail）才让退出码为 1，警告只是需要人看一眼
- **组件下载真校验**：安装 yt-dlp 前先取官方 `SHA2-256SUMS`，比对 SHA256 后才落盘，
  并把校验值记进配置；`/api/components` 只在「有记录且一致」时报 `verified`。
  实测重装 17,880,111 字节，SHA256 `33121d19…`。顺带修了 `validate()` 丢掉 `ytdlpSha256` 的问题
- **Skill 构建修复**：Windows 上 `find_bun()` 会先命中 npm 的无扩展名 shell 脚本，
  `CreateProcess` 报 `WinError 193`；改为优先找真正的 `bun.exe`。实测产物
  `vdl.exe` **91.9 MB**、`video-acquire-ts.zip` **42.6 MB**，直接运行返回结构化
  `unsupported_url` 且退出码 1

- **账号状态进 UI**：设置面板新增「账号」区，列出 B站 / 网易云 / QQ音乐 的本地凭据与在线校验结果
  （有效 / 已失效 / 无凭据），可在手机或网页上发起「登录/重新登录」——登录仍在电脑的独立 Edge 里完成，
  不读取日常浏览器的 cookie；`GET /api/auth` 结果缓存 20 秒
- **附属单独重取**：已完成的 B站 任务多出「重取字幕/弹幕」，走 `POST /api/jobs/:id/sidecar`，
  只重新拉字幕/弹幕、不重下视频；实测重取后 `.srt` 重新写入、任务卡片显示 32/268

- **专辑分批**：`/api/album` 与 CLI 都支持 `offset`，单批仍 20 首；界面在还有剩余时显示
  「加载下一批（20 首）」，追加曲目且保留已勾选，标题栏显示 `已列 / 总数`，并说明之后还剩多少。
  CLI 输出批次号与 `--offset` 提示
- **缺档位不再静默换档**：B站 下载指定 `--format` 时若该集没有这个档位，
  直接报 `no_stream`（并列出可用档位），不再悄悄换成别的清晰度；分P/番剧各集档位不一致时能看见真实原因

- **Android 壳体验**：地址栏加载成功后自动收起（右下角「地址」按钮可叫回）、
  电脑离线改为壳内错误页（说明 + 错误码 + 重试）、`token` 无效与缺失分开提示；
  真机（realme RMX5200 / Android 16）复测通过
- **长文案标题**：抖音「标题」是整段文案，结果卡标题限 3 行，不再撑满一屏

- 抖音等「复制链接」给出的整段分享文案可直接粘贴：先抽取第一条链接再判平台，短链再靠重定向拿 id；
  此前整段文案会被当成 URL 交给 yt-dlp 通用解析，报 `is not a valid URL`。

- 本地 API 按完整 Origin 校验协议、主机和端口；文件访问统一检查真实路径，阻止相邻前缀目录及 junction 逃逸；媒体代理逐跳校验重定向。
- 配置与任务历史创建父目录并原子写入；保存失败明确返回错误，任务提交写盘失败整体回滚。活跃任务不再被最近 100 条历史上限挤出。
- Skill 对未内置的 QQ / 酷我 / 酷狗 / 通用站点返回 `unsupported_url`，不再误入 B站；参数值不再误作 URL。
- 进度、取消、媒体缓存和字幕上下文改为请求/任务独立作用域；下载 A 时解析 B 不串字幕、弹幕或媒体地址。
- 抖音 / B站封面开关接通 CLI 与 Web；已存在视频也可补附属文件。字幕失败不虚报数量，附属失败返回警告并保留主文件；B站合并失败保留音视频流。
- Web 支持 SSE 断线提示与重连快照、防重复提交、网络失败后重试、设置保存失败提示、完整焦点循环与返回；修复 768px / 390px 布局溢出和旧 UI 验收选择器。
- TS Skill 构建日志强制 UTF-8，修复旧 Windows CI 的 cp1252 编码崩溃；CI 固定 Bun 1.4.4，保持手动触发。
- 验证：75 项 Bun 离线测试；9 类 Edge 场景及 Python UI 入口；干净临时目录中模拟 cp1252 构建、ZIP 与编译产物 JSON 烟测通过。第三方在线下载和 Android 真机未在本轮重验。

## v3.3.0 — 2026-10-23

**界面 V2、设置补齐、浮层体验**

- **限速进设置面板**：输入 MB/s（空或 0 = 不限速），保存即 PATCH 并立即生效，右栏同步显示。
  修一个静默 bug：`saveSettings` 里的局部 `const limitRate` 遮蔽了同名 ref，赋值不报错也不生效
- **并发诚实化**：原来能选 1–4，但服务端 `pump` 是单 worker 串行，选了也不生效；
  改成只读「并发 1（单 worker 串行，当前版本固定）」
- **浮层体验**：Esc 可关闭设置 / 预览，打开时锁背景滚动，焦点落到面板；
  侧栏去掉与顶栏重复的「已连接」；任务按「进行中 / 已结束」分组
- **Web UI 重做（V2，infOS 风格）**：`web/vue/` 换成侧栏 + 双栏工作站布局，令牌按 infOS S06 规范
  （画布 `#f6f7fb`、卡片 14px 圆角 + xs 阴影、粉 `#ec4899` 主操作、天蓝进行态、紫音乐）；
  画质改「浅槽 + 白色选中 pill」，附属开关改 switch，设置改右侧 Slide-over，新增右栏
  （运行状态 / 待处理 / 通用组件）与空状态。实测：B站 解析/封面/画质/开关正常，480P 任务
  21,181,196 字节完成并显示完成态；专辑 173 首列表 20（略过 153）；暗色与 390×844 手机布局通过
  - 顺带修：B站 封面按 Referer 防盗链会 403，`<img>` 加 `referrerpolicy="no-referrer"`；
    主按钮 hover 时 `background` 简写会清掉渐变（白字压浅底像「文字消失」），改为只改 `background-color`

- **Web UI 支持字幕 / 弹幕**：B站 结果页多出「字幕 / 弹幕」两个开关（选择持久化，刷新后仍在），
  任务接口接受 `subs` / `danmaku`（只认显式 `true`），完成后任务卡片显示实际拿到的条数
  （字幕行数 / 弹幕条数）。其它平台不显示这两个开关
- **Web UI 支持专辑**：新增 `POST /api/album`（网易云 / QQ），界面粘贴专辑链接即列出曲目
  （上限 20，超出会明说略过几首），勾选后逐首建任务；实测 173 首专辑列 20 略 153，
  QQ《轻轻》专辑在界面里下载完成 3,554,923 字节
- **局域网模式 `--lan`**：服务绑 `0.0.0.0`，启动打印仅内网 IPv4 的带 token 地址与风险提示；
  `Origin` 只放行「与本请求 Host 一致」的来源（外来源仍 403）。实测同机走局域网 IP 访问 200
- **Android 手机壳**：`mobile/android/` 极薄 WebView 壳（无第三方依赖，APK 9,637 字节），
  粘 `http://<电脑IP>:8765/?token=...` 即可用电脑端的界面与下载；地址存 SharedPreferences；
  预留 `am start -e url <地址>` 联调参数（未在真机安装验证，等正式测试机）

## v3.2.0 — 2026-10-23

**B站字幕/弹幕、QQ 全链路、专辑批量、酷我/酷狗、L2 嗅探**

- **B站字幕** `--subs`：`player/v2` → `subtitle_url` → SRT，中文 / `ai-zh` 优先；探测时只记 `bvid+cid`，
  不给普通 probe 加请求。实测 `BV1DSnK6REdy`（52s，7 种 AI 字幕）落 32 条；视频已存在走跳过分支仍补字幕；
  无字幕视频输出「该视频没有可用字幕（含 AI 字幕）」
- **B站弹幕** `--danmaku`：落同名 `.danmaku.xml`；实测 K/DA MV 1200 条 / 126,636 字节；番剧明确报「暂不支持」
- **B站进度分母**：改用 `Range: bytes=0-0` 探测的两条流真实字节（原先用 playurl 带宽估算，带宽缺失会退回单流分母）。
  实测 480P 21,093,538 字节全程分母唯一，79 个采样点仅最后 1 个 ≥99.9%
- **QQ 音乐全链路**：`auth qq` 扫码（49 cookies）+ `getQQ` 流式下载 + ffmpeg 标签/封面 + `.lrc` 歌词 + 路由。
  实测《轻轻》128K MP3 3,554,923 字节、96K AAC 2.60MB、`.lrc` 1,991 字节；**该账号 320K/FLAC 仍 104003**（会员权限）
- **QQ 下载前预览**：`/api/preview` 接 `previewQQ`；`/api/stream` 只对 `*.qqmusic.qq.com` / `*.tc.qq.com` 放行 http，
  其它站点仍强制 https。实测 Range 206 `audio/mpeg`，非白名单 http 仍 403
- **专辑批量** `--album`（网易云 / QQ）+ `--dry-run`：上限 20 并如实报略过数量（173 首 → 取 20 / 略过 153）；
  逐首下载、单首失败继续并在结尾汇总，有失败退出码 1
- **酷我 / 酷狗**：公开接口 probe + 下载 + 标签/封面（酷我另有 `.lrc`），已接路由。
  实测酷我 128kbps 3,368,054 字节、酷狗 128kbps 4,631,150 字节（带 `mjpeg` 封面）；会员档被拒时如实报试听档
- **L2 嗅探**：m3u8 / 直链 mp4·webm·mov·mkv·m4v·flv，HLS 用 ffmpeg 合成（进度/取消），直链复用 `.part` 续传。
  实测公开 HLS 184P 20,049,937 字节、直链 mp4 991,017 字节；**不跑页面 JS、不做 blob/MSE**
- **`auth --status` 默认在线校验**：过期 cookie 不再报「已登录」（实测 B站 `nav` code=-101 会被指出）
- **CLI 展示 warnings**：未登录 / 仅匿名档 / 会员档被拒 / 试听片段不再只藏在 `--json` 里
- **测试**：53 个，`bun test ts/tests` 全绿

## v3.1.0 — 2026-10-23

**限速、QQ 音乐探测骨架、可双击启动**

- **限速**：`--limit 2M`（K/M/G 与纯数字）与 `config.limitRate`（服务端启动/patch 即生效）；
  抖音 / B站 / 网易云的流式落盘全部接入。实测抖音 1080P 6,281,768 字节 @1M 用 6.53s，
  不限速 0.74s，两者 sha256 一致。边界：按单条流算（B站 音轨另起预算），yt-dlp 通用引擎不受此限速管辖
- **QQ 音乐**：只有匿名 `probe`（`canHandle` / `probeQQ`），**未接路由、无下载**。
  匿名只对部分免费曲放行：实测《轻轻》128K MP3 3,529,853 字节 / 96K AAC 2,703,704 字节，
  与接口 `size_128mp3` / `size_96aac` 一致；320K/FLAC 返回 `result=104003`（需登录）；
  搜索匿名不可用（`req_1.code=2001` + 登录页），只吃 songmid / 分享链接
- **启动**：删除指向已归档 `dy_gui.pyw` 的 `抖音下载器.bat`；新增 `VDACC.bat`
  （检查 bun → 起 8765 → `--open` 打开带 token 的浏览器）。实测 `GET /` 200、无 token `/api/health` 401
- **界面**：移除指向已删除 `/legacy/` 的「旧版」链接（原来点了 404）
- **文档**：目录说明/契约路径按 `ts/` + `legacy/python/` 现状重写；PWA 章节改为如实说明已移除
- **测试**：27 个（限速 4 组、QQ 纯函数 5 组），`bun test ts/tests` 全绿

## v3.0.0 — 2026-10-22

**正式版（TS 主线）**

- Vue 3 为默认入口；解析/多选/分P批量/下载前预览/设置/中英
- 进度聚合：B站 视频+音频按已完成字节累加，修复 99.9% 卡住
- 4K 策略定稿：**avc 兼容优先**（与 yt-dlp 的选流差异保留并记录）
- Python `vdl/` 冻结，不再演进；物理归档 `legacy/python/` 列入 3.0.1
- CI 改为 `workflow_dispatch` 手动触发（配额原因）

## v3.0.0-beta.6 — 2026-10-22

**默认入口切到 Vue**

- `/` → Vue 界面；`/legacy/` 保留旧版（回归用，确认后删）
- Service Worker 升 `vdacc-shell-v2`：导航请求网络优先，避免旧缓存把 `/` 锁成旧版
- 实测：`/` 加载 Vue、`/legacy/` 旧版输入框与任务区正常

待补：番剧 4K 选流对齐、删 legacy、3.0 正式版收口

## v3.0.0-beta.5 — 2026-10-22

**下载前流预览（Vue）**

- `POST /api/preview`：解析并返回代理地址；引擎直链缓存在进程内
- `GET /api/stream`：带 UA/Referer 代理（CDN 有防盗链），透传 Range 与 206
- 白名单限制：douyinvod / bilivideo / 126.net 等，避免 SSRF
- Vue 下载前「预览」按钮；实测抖音 `src=/api/stream`，HEAD 200

待补：切默认入口、番剧 4K 选流对齐

## v3.0.0-beta.4 — 2026-10-22

**Vue 批量三态全选**

- 分P/合集列表：全选 / 半选（indeterminate）/ 逐条勾选
- 硬上限 20；超限提示分批；预计体积按当前档位估算
- 清晰度整批统一，每个勾选项一个 job
- 实测：4 分P，初始全选 → 取消 1 → 全选 → 选 2，提交 `2/2`

待补：下载前流预览、切默认入口

## v3.0.0-beta.3 — 2026-10-22

**Vue 设置面板与本地预览**

- 设置弹窗：输出目录 / 主题 / 并发 / 通用解析开关 + 组件状态与安装
- 完成任务可「▶ 预览」本地文件（`GET /api/preview?path=`，仅限输出目录）
- 旧版的「下载前远程流预览」未迁移，Vue 只预览已完成文件
- Playwright 实测：设置回填、组件 17.1MB、任务 5.99MB、预览 src 指向 `/api/preview`

待补：批量三态全选、下载前预览、切默认入口

## v3.0.0-beta.2 — 2026-10-22

**Vue 3 迁移（切片）+ i18n**

- `/vue/`：无构建 Vue 3 页面（Vue 170KB 本地托管，无 CDN）
- 功能：解析、多选档位、分P 下拉、下载、SSE 任务、取消/重试、明暗主题
- i18n：中英切换，`localStorage` 持久化；旧版界面保留在 `/`
- 服务端静态路由支持目录 `index.html`
- 实测：抖音 3 档 + 5.99MB 完成；B站 4 分P 选中 P2；16+2 测试通过

待补（未迁到 Vue）：设置面板、预览、批量三态全选；旧版仍为默认入口

## v3.0.0-beta.1 — 2026-10-22

**可选通用组件 + 设置面板**

- `GET /api/components` / `POST /api/components/ytdlp/install`：按需下载 `yt-dlp.exe`（17.9MB，3s）
- `allowGeneric` 开关 + `engines/generic.ts`：未知站点 probe/get，直链实测 1,128,375 字节
- 设置面板 UI：输出目录 / 主题 / 并发 / 通用解析开关 + 组件安装状态
- 实测：组件安装、通用 probe、通用下载、设置弹窗（Playwright）均通过

已知边界：SSE 进度按单条流统计；番剧 4K 选流与 yt-dlp 有差异。

## v3.0.0-alpha.4 — 2026-10-22

**TS 测试与 CI**

- `bun test`：16 个用例（平台识别 / 命名 / 契约默认值 / 服务端 401·403·404·静态页 / 设置）
- 平台识别抽成 `core/platform.ts`，CLI / Skill / 服务端共用，避免三处正则漂移
- 服务端测试用子进程 + 随机端口 + `VDL_STORE` 隔离，不污染真实历史
- CI 新增 `test-ts` job（Bun + Python 构建校验），与 Python legacy 并行

待补：yt-dlp 可选组件、设置面板 UI

## v3.0.0-alpha.3 — 2026-10-22

**TS 版 Skill（单文件）**

- `tools/build_skill_ts.py`：`bun build --compile` 出 `vdl.exe`（91.9 MB），
  配 `SKILL.md` + `references/engines.md`，zip 42.6 MB
- 入口 `ts/src/skill_cli.ts` 刻意不含 `auth`/playwright，体积不膨胀
- 未知站点返回 `unsupported_url`（不再落到 `bad_input`）
- 实测：抖音 3 档 / 6.28 MB 下载；B站 4 分P + 1080P 推荐；网易云 2 档

待补：测试迁移、yt-dlp 可选组件、设置面板 UI

## v3.0.0-alpha.2 — 2026-10-22

**TS 服务能力补齐**

- 网易云下载：FLAC/320K + 800px 封面 + 标签 + `.lrc`（实测 19,066,853 字节）
- `auth`：Node Playwright 复用同一 profile；只落本站域名 cookie；`--status` / `--clear`
- 设置 `GET/PATCH /api/settings`（outDir / theme / concurrency / limitRate / allowGeneric）
- 任务取消（14.1% 实测）、重试（127MB 完成）、持久化（重启恢复，中断标记）
- 依赖：`playwright-core`（不下载浏览器，复用系统 Edge）

待补：Skill 切 TS、测试迁移、yt-dlp 可选组件

## v3.0.0-alpha.1 — 2026-10-22

**TS 后端主线（Bun）**

- `ts/` 成为默认入口：抖音、B站（分P / 番剧）、网易云解析；`probe/jobs/SSE/files` 服务
- 纯 TS B站：`playurl` + DASH + ffmpeg，probe **305ms**（Python 1.6s），分P 与 Python 字节一致
- 番剧实测：197 集、480P **127,096,266 字节 / 15.7s** 可播放
- 修复：Cookie 头 8.9KB 会触发 400，改为域名/过期过滤（27 条 / 1.7KB）
- 推荐档改为 **1080P**（批量/分P 场景）
- yt-dlp 降为**可选组件**，不内置
- `vdl/`（Python）冻结为 legacy，契约仍为 `schema=2`

待补：网易云下载、`auth`、设置 / 取消 / 持久化、Skill 切 TS、测试迁移

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
