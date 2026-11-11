# AGENTS.md —— 给后续 AI / 协作者的上下文

这个仓库是一个**多平台视频/音频下载工具**（抖音 / B站 / 网易云 + yt-dlp 通用兜底），
定位是「桌面可编程下载内核 + 可选 Web GUI + Agent Skill」。
动手前先读 `Plan.md`（路线图与待决策）。本文只写**不能违反的红线**和**已验证的事实**。

> **内容分析与生成侧：解冻后当天又冻结（2026-11-02）**。计划见
> [`docs/style-transfer-plan.md`](docs/style-transfer-plan.md)——**它是冻结状态，不是待办**。
> 冻结原因：拿不到 H3 运行通道（用户不再长租算力；本机 10 GB 显存比 H3 的定位差一个数量级），
> 于是 A0 第三项与 A5 无法验收。重启条件（租几小时 24–48 GB 卡 / 官方额度 / 或收窄成纯分析）
> 写在该文档 §0.1。**人物三视图**另有结论：不排期（跨视角一致性不够）。
> 冻结期间的主线见 `Plan.md` §2.6。

## 一、红线（踩过的坑，不要再走回头路）

1. **抖音签名的旧结论已作废，不要复用。**（2026-10-21 更正）

   旧结论（错）：`aweme/detail` 要求 `a_bogus`，只有浏览器 JS 算得出，所以必须借浏览器。

   实测结论（对）：
   - 门是 `x-secsdk-web-signature`，算法 `md5(f"{uifid}_{timestamp}_{SALT}_{query}")`，
     `SALT = A96D855A08C0A9707F8BEF0D9A527E4E`，硬编码；
   - `ttwid` 可自己 POST `https://www.douyin.com/ttwid/register` 注册，
     `passport_csrf_token` 随便填；
   - **还需要 uifid**（2026-10-26 补正）：签名里必须带，取法见 `getUifid()` ——
     先查 6 种 uifid cookie，再 GET 首页从 `x-tt-trace-host` 响应头取。
     所以「完全无 cookie 也能下」这个说法不准确，准确表述是
     **「不需要登录 cookie，但 ttwid + uifid 缺一不可」**；
   - query 必须带 `aid=6383`，否则清晰度被截到 720p；
   - **Argus 会概率性拦截**：表现为 HTTP 403（`Blocked by ArgusSecurityPlugin Uifid Not Found`）
     或 **HTTP 200 + 空 body**。后者最坑——空 body 会被 JSON 解析器拒掉，看起来像接口改版。
     `fetchDetail()` 已做 3 次退避重试，每次清空 cookie 重新注册、重新签名（timestamp 变了签名必须变），
     连续失败才报 `blocked`。
   - **教训（2026-10-26 踩过）**：一次 `bad_json` 就断定「HTTP 引擎失效」，实际换个时刻就通了。
     排查风控类问题先重试几次再定性，单次失败不足以证明机制坏了。
   - 对照实验：官方 yt-dlp 2026.08.19 未打补丁 → `HTTP 403` + `Fresh cookies needed`；
     打上 PR #17826 的 +56/-1 补丁 → 无 cookie 拿到 `h264_1080p`（1080×1920）。

   现状：修复在 PR #17826，未合并、0 条 review。因此两条都别做：
   - **不要**把抖音引擎删掉换回官方 yt-dlp——未合并前官方版仍然下不了；
   - **也**不要再用"必须借浏览器算签名"当设计理由——浏览器方案保留是为了兜底和其它站点。

2. **不要提议安装任何第三方 GUI**（ytDownloader / Open Video Downloader / Stacher / BBDown 之类）。
   全部基于 yt-dlp 或需要额外环境，且失去可控性。

3. **不要试图读取用户正在使用的浏览器的 cookie。** 三道墙实测无解：
   - 文件锁：Edge 运行时独占 `Network\Cookies`，只读都 PermissionError
   - 后台复活：关掉 Edge 后几秒自己又拉起
   - App-Bound Encryption：Chromium 127+ 密钥绑死浏览器进程，离线解密报
     `Failed to decrypt with DPAPI`

   **正确姿势**：用我们自己 `browser_profile` 起的独立 Edge，通过
   `context.storage_state()` 导出**明文** cookie。我们是进程内合法持有者，
   不涉及任何解密，也不碰用户的浏览器。这是唯一被认可的路。

4. **不要再做 UI/UX 与「体验数字」类测试（2026-11-04 起）。**

   这类测试只产出截图和耗时数字，**既不能证明功能正确，也没人会在发版前逐张比对**。
   明确禁止把它做成用例、验收项或发布门槛，包括但不限于：

   - 布局/视觉回归截图对比（`tools/ui_shots.cjs` 那组浅/深 × 中/英 × 390/768/1440 矩阵）、
     像素级对齐、暗色模式逐屏巡览；
   - 开屏/首屏耗时、滚动帧率、动画缓动曲线、骨架屏对比这类「体感数字」；
   - 无障碍朗读逐项核查、浏览器兼容矩阵（我们只保证自己那套壳与主流桌面浏览器）。

   **允许且应该做的只有功能验证**：页面能加载、按钮能触发对应请求、错误能显示出来、
   返回的字段对得上。判断标准一句话——**这条测试失败了，能说明「功能坏了」吗？**
   答不上来就别写。

   注意这条禁的是「把外观/手感变成测试与验收」，不是禁「实现 UI 时自己看一眼」。
   历史产物（`tools/ui_shots.cjs`、`tools/reduced_motion_check.cjs`、`docs/design/ui/shots/`）
   保留但不再维护，也不再作为发布门槛。

5. **DRM 研究决策已更新（2026-10-27）。** 取消「不做 DRM」的项目红线，允许把 DRM 和受保护媒体纳入研究计划，见 `Plan.md` §2.6.3 和 `ReversePlan.md`。这是研究范围变更，不表示项目已支持 Widevine 或其他 DRM，也不能把付费点播一概认定为 DRM；当前能力以代码与验证结果为准。

## 二、已验证的事实

| 项 | 值 |
|---|---|
| 抖音截流方案 | 可用，能拿 `normal_1080_0` 最高档，不依赖用户关闭浏览器 |
| yt-dlp 版本 | 2026.08.19（本机加载 1744 个提取器） |
| yt-dlp 的 B站支持 | 完整（BiliBili / Bangumi / Playlist / Live / Intl） |
| yt-dlp 的抖音支持 | 官方版仍 403 + 误导性 `Fresh cookies needed`；PR #17826（+56/-1）实测可修 |
| 抖音签名 | `x-secsdk-web-signature` = `md5(uifid_timestamp_SALT_query)`，纯 HTTP 可算；需 ttwid + uifid（**不需要登录 cookie**）。Argus 会概率性 403 或回 200+空 body，已加重试 |
| 网易云播放地址 | `GET /api/song/enhance/player/url?ids=[id]&br=999000` + `MUSIC_U` 直接返回 `level=lossless` 的 FLAC；**不需要 eapi/weapi 加密** |
| 网易云歌单 | `GET /api/v6/playlist/detail?id=X&n=N` 的 `n` 只截**内联曲目**（0/3/1000/5000 实测都到 `trackCount`），`trackIds` 恒为**全量**；`GET /api/playlist/track/all` 匿名已回 `code=404`，**不能用**。全量曲目 = `trackIds` + 每批 **100 条** `GET /api/song/detail/?ids=[...]`（100 实测正常），返回顺序不保证，必须按 id 还原。热度榜 `3778678` 实测 200 首 / 419–610ms / 0 缺失。`163cn.tv` 短链要跟一次跳转；落点是 `st.music.163.com`（活动页）不是内容页，无效码回 403 |
| QQ 歌单 | `POST https://u.y.qq.com/cgi-bin/musicu.fcg`，`req.module='music.srfDissInfo.aiDissInfo'`、`method='uniform_get_Dissinfo'`、`param={disstid,song_begin,song_num}`，匿名可用：`req.data.dirinfo.songnum` 是总数、`title/picurl` 是标题封面，`songlist[]` 每项 `mid`（**不是 `songmid`**）/`name`/`singer[].name`。`song_num=100` 一次给整单。**旧 `fcg_ucc_getcdinfo_byids_cp` 回 `{"code":0,"subcode":4000,"msg":"check privacy error!"}`，不能用**；`getSongListDetail` 回 `500003` |
| 抖音合集 / 主页 | `aweme/v1/web/mix/aweme` 与 `aweme/post` 无签名一律 403 `Blocked by ArgusSecurityPlugin`；带现有 `x-secsdk-web-signature` 后 200，但对不存在的 `mix_id` 回 `status_code=4` + `aweme_list:null`，而 `aweme/detail` 对不存在的视频是 `status_code=0` + 无 detail —— **无法区分「合集不存在」与「还缺 a_bogus」**。`www.douyin.com/collection/<id>` 返回 JS 挑战页（`jsvmprt`），无 SSR 数据。没有真实 mix_id 前不做列表功能 |
| B站 音频单独下 | `dash.audio` 本来就是独立轨（`playurl` 同一次返回），只下音频 = 只请求 audio 轨 + `ffmpeg -c copy` 转封装 m4a。没有 ffmpeg 也能落盘（改名保留），但必须说明「未转封装」。实测 228s 视频：4,981,362 字节 / aac 48kHz 立体声 / 173kbps |
| 酷狗歌单 | `mobiles.kugou.com/api/v3/special/info?specialid=<id>&format=json` 给 `specialname`/`nickname`/`songcount`/`imgurl`（`{size}` 占位）；`…/special/song?specialid=&page=&pagesize=` 给 `data.total` + `data.info[]`。曲目字段 `hash`（32 hex）/`filename`（「歌手 - 歌名」，**没有** songname/singername）/`duration`（**秒**）。`pagesize=100` 一次给整单；不存在的 id 是 `total:0 + info:[]`（不是报错）。酷狗**专辑**批量未做 |
| B站 预览 / 代理端口 | DASH 双轨：`<video>` 只有画面，音轨要单独挂一个 `<audio>` 跟随（`/api/preview` 回 `audioUrl`）。**B站 mcdn 节点是 `xxx.mcdn.bilivideo.cn:8082`**，`streamUrlAllowed` 原先拒绝所有非默认端口 → 这类地址预览恒 403；现在只额外放行 8082，其它端口仍拒。双轨**并行下载**只在未设限速时启用（限速按每条流算，并行 = 2 倍总带宽） |
| 抖音图文 | 判据是「有 `images` **且** `video.play_addr.url_list` 为空」——只看 `images` 会把带背景视频的图文误杀。命中的作品跑不出视频流，应报 `unsupported` 而不是「没有解析到档位」 |
| 酷我歌单 | **不可用**（2026-11-11 实测）：`api/www/playlist/playListInfo` 要 `csrf` 头 + `kw_token` cookie，而首页/搜索页/H5 页都**不下发 kw_token**（只有 `Hm_Iuvt_…`）；桌面 `/playlist_detail/<id>` 直接 **430**；移动 UA 的 `/h5app/playlist/<id>` 是压缩成单字母变量的 NUXT 表达式（**不 eval**）。`search.kuwo.cn/r.s?ft=playlist` 能给 `playlistid`/`name`/`songnum`（单引号 dict），但**没有曲目** |
| B站清晰度归档 | 必须按**宽度**（3840/2560/1920/1280/854）；宽银幕（1920×816、4096×1740）按高度会整体下移一档 |
| B站格式结构 | 全部是 video-only + audio-only，必须成对合并；带 cookie 才看得到 4K/1080P |
| B站扫码登录（`vdl auth bilibili --qr`，**只有 B站**） | 只需两个 GET、**不需要 cookie 也不需要浏览器**：`passport-login/web/qrcode/generate` → `{url, qrcode_key}`（32 位 hex）；`/qrcode/poll?qrcode_key=` 的**外层 `code` 恒 0，状态在内层 `data.code`**（86101 未扫码 / 86090 已扫码待确认 / 86038 已过期 / 0 成功）。**扫码是可选快路径，默认 `vdl auth <site>` 仍走 Edge**（见下一行）。**网易云扫码已试过并撤掉**：`unikey` 流程连续 `801` 后直接 `8821`（无 `802`），平台侧不放行，适配器已删除；QQ 音乐没做扫码（需 ptqrtoken）。落盘必须**同时写 `storage_state` 与 Netscape 两份**——引擎的 `cookieHeader()` 优先读 txt，只写 json 会让旧 txt 盖住新 cookie（表面「登录成功、档位没变」）；落盘后仍用 `nav` 判真，验不通标 `unverified` 而不是绿 |
| 路由顺序 | 专用引擎（抖音/网易云/QQ/酷我/酷狗/B站）→ L2 直链/m3u8（`sniff`）→ `ytdlp-generic` 兜底。抖音裸 ID 规则最宽，必须排最前；QQ/酷我/酷狗 只认域名（裸串不路由）；L2 只认媒体扩展名，不跑页面 JS |
| ffmpeg | 本机 **9.0.2-full_build**（`winget install Gyan.FFmpeg`，shim 在 `%LOCALAPPDATA%\Microsoft\WinGet\Links`，在用户 PATH）。TS 主线用 `VDL_FFMPEG` 或 PATH；legacy 的查找顺序 `venv\Scripts` → `PATH`（`legacy/python/vdl/core/env.py`）。缺失会让 B站/YouTube 变无声视频 |
| Bun | 本机 **1.4.4**（`winget install Oven-sh.Bun`，shim 同目录）。装在用户 PATH 的目录里，**已开着的终端不会刷新**，新装后 `where bun` 报找不到属正常，新开窗口或直接探 `%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe` 即可 |
| Playwright | `playwright-core`（`package.json` 写 `^1.64.1`，实装 1.65.0）。**绝对不能用 Bun 跑**：它的 WebSocket 在 Bun 下握手永远不返回（同机同版本 Edge，node 正常、bun 30s 超时），而 Playwright 官方只支持 Node。所以 Edge 登录路径由 `ts/src/auth-node.mjs` 用 **node 子进程**执行（`auth.ts` 只负责 spawn + 收 JSON）。该脚本自己拉系统 Edge：`--remote-debugging-port=0` + **`--remote-allow-origins=*`**（Chromium 111+ 硬要求），读 `DevToolsActivePort`（**每次先删旧文件**，否则连到死端口 ECONNREFUSED）再 `connectOverCDP`；profile 必须用**一次性目录**（复用 `%LOCALAPPDATA%\vdl\profile` 会 `browser has been closed`）。不下载 chromium |
| venv | `venv\Scripts\python.exe` = **3.13.4**（系统 `python` = 3.13.14），已装 playwright 1.64.0 + yt-dlp 2026.8.19，legacy 可直接跑 |
| Android 端 M0 | 引擎 bundle 8.5KB（gzip 4.6KB）、APK 846KB、minSdk 26；桥（paths / md5 / fs 分块+publish）在 realme RMX5200 / Android 16 真机跑通，落盘 md5 与 `md5sum` 一致。JS 侧 md5 必须纯 JS（`node:crypto` 是同步 API，桥是异步），已与原生 `MessageDigest` 交叉校验 |
| MiniMax H3 | 提示词是**三字段结构**：`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`（官方 guide）；纯文本生成直接从三字段开始，用首/尾帧才加 instruction 行。时长 **4–15s**；原生 32kHz 立体声，声音必须写进提示词；**2K 不是超分**，是 768P 的 in-context regeneration。详见 `docs/style-transfer-plan.md` §3 |
| Android 端二期（2026-11-06 真机） | 专辑批量可用（20 首/批 + `nextOffset`，界面本来就有「加载下一批」）；QQ 登录通道已通（`auth.uin` **只给账号数字**，`qm_keyst` 不出原生），**档位未用真实账号验证**；打开/预览走 `content://`（`ui.reveal` = 用系统默认应用打开，手机没有「在文件夹中显示」），`<video>` 实测 `readyState=4` |
| B站 番剧 4K | API（含 wbi 签名、fnval/qn 共 20+ 组合实测）最高只给 `id=120`（4K 5978k）；`id=122`（8554k）**只在页面 SSR `playurlSSRData` 里**，yt-dlp 也是先读 SSR。我们从页面补这一档后 4K = 1.52 GB / 8731k（地址 `…-100198.m4s`） |
| B站 字幕 | 必须走 **wbi 签名的 `/x/player/wbi/v2`**（`aid`+`cid`，番剧 `ep_id`）。未签名的 `/x/player/v2` 会**概率性返回别的稿件的字幕**（实测 207s 的 MV 拿到跨度 746/1606/1337s 的无关内容；3018 行跨 10109s 也见过），这就是「下载下来的字幕全是错的」。落盘前必须校验时间轴跨度 ≈ 片长（容许 max(8s, 2%)、且不能只盖前一半），并**人工轨优先于 `ai-*`** |
| yt-dlp 的真实职责 | TS 主线里 **只服务「其它站点」**：`platformOf` 返回 `unsupported` 且开了 `allowGeneric` 才走 `engines/generic`。B站 走原生 `bilibili_api`（只有 `VDL_BILI_ENGINE=ytdlp` 才回退到 yt-dlp 版）、抖音/网易云/QQ/酷我/酷狗全部原生、直链与 m3u8 走 `sniff`。因此删组件只影响「其它站点」与 legacy Python（它的 B站/YouTube 仍靠 yt-dlp）；`doctor` 会从 ok 变 warn，不是 fail |
| infOS Package（`integrations/infos/package/`） | Manifest V2：`manifestVersion:2` / `packageId` / `trust:'user'`；上传包**只能**声明 `tool`/`skill`/`event-subscriber`/`service`/`capability-provider`/`context-provider`/`agent-flow`/`presenter`/`web-ui`/`asset`——`application`/`runtime-adapter`/`policy` 声明了会**激活失败**。tool 导出 `createContribution(host)` → `{definition:{name,description,parameters}, execute(args,ctx)}`，返回字符串；`host` 只给 `onDispose` 与 `dataDirectory`。只收已编译 ESM（`.mjs`），拒绝 `node_modules`，**20 MiB ZIP / 64 MiB 解包**。token 每次启动都变，只能放 Package 数据目录的 `config.json` |
| infOS 宿主实测（2026-11-11，`D:\infOS` 0.9.12） | 后端固定 `127.0.0.1:9120`（`PERO_PORT` 可改），数据目录 `%USERPROFILE%\.infos`；**API 要 `Authorization: Bearer <localToken>`**，`localToken` 在 `<数据目录>\client-access.json`（`INFOS_API_TOKEN` 优先）。装包三步：`POST /api/packages/install`（multipart 字段名 `package`）→ `POST /api/packages/:id/authorize`（`{digest, permissions}`）→ `PUT /api/packages/:id/enabled`；`GET /api/integrations/installed` 是界面投影。**install 返回的 `digest` ≠ 注册表里的 `authorizedDigest`**（宿主侧重算），别拿它当幂等键。数据目录已被某进程占用时后端拒绝启动（`数据目录已有后端进程正在使用`），先看 9120 是否已在监听 |
| 网易云歌曲链接 | 手机分享形式是 `https://music.163.com/#/song?id=…`，**id 在 hash 里**；只读 `searchParams` 会报「识别不出歌曲 ID」。专辑/歌单链接的 id 不能当歌曲 id |
| A3 风格卡（`analyze --style-card`） | 产出 `style-card.{md,json}`：节奏 / 景别 / 运镜（**按主类归并**，否则「拉」「拉（轻微）」会分裂成两类）/ 亮度 / 实测响度 / 描述词频（**标注为词频，不是识别**）/ 覆盖度。**不出成品 H3 提示词**——4–15s 拼接与 soundscape 措辞要人写，且 A5 无通道无法验证；卡尾固定列三条边界 |
| 声音客观量（默认开） | ffmpeg `ebur128` 一次解码：整片 LUFS / LRA / 真峰 / 100ms 包络 / 静音段（≤-50 LUFS 且 ≥300ms）/ 每镜响度（`scenes[].db`）。**必须 `-loglevel info`**——逐帧数值只打在 info 里，用惯常的 `error` 一行都拿不到。解析汇总前要先剔掉带 `TARGET:` 的逐帧行（那些行也带 `I:`/`LRA:`，否则拿到的是最后 100ms 的值）。**只报数字，不判「对白/音乐」**：那要频谱或 ASR，光看音量会编 |
| 运镜（`--pair-frames`） | 每镜抽「首帧\|尾帧」并排图判 `camera`（固定/推/拉/摇/移/升降/环绕/手持）。**ffmpeg 的 `-frames:v` 是输出选项**，放在两个 `-i` 之间会被当成第二个输入的选项直接报错——要用 `-ss X -t 0.12 -i ...` 限住每个输入。两帧对比分不清「慢推」与「主体走近」，拿不准写「固定」。描述文件合并是**字段级叠加**（camera-only 不清空 subject），且 `<outDir>/visuals.json` 快照会自动作为基线 |
| A2 语义描述（`analyze --describe` / `--visuals`） | DeepSeek 视觉：本账号只有 **`deepseek-flash`** 支持 `image` 输入（另一个 `deepseek-v4-pro` 只支持 text）。key **只从 `DEEPSEEK_API_KEY` 读**，不落盘、不打印。**它是推理模型**：`max_tokens` 同时覆盖 reasoning 与答案，给 500 会被推理吃光（`finish_reason=length`、content 空）→ 固定 `reasoning_effort: low` + 1200 预算，截断自动加倍重试（上限 4000）。提示词必须写明「不确定留空、不推测剧情、忽略平台角标水印」，全字段留空按失败处理；约 **2.2k tokens/镜** |
| 分析 A1（`cli analyze` + 界面「分析」） | CLI：`bun ts/src/cli.ts analyze <本地文件>`；界面：已完成视频任务卡的「分析」→ `POST /api/analyze`。产物 `下载/_analysis/<文件名>/{result.json,frame-*.jpg}`；台词**只读同名 `.srt/.lrc`**，没接语音识别；122s/1080P 实测 47 段 / 41 帧 / 10.9s，点第 3 帧预览跳到 6.1s。缺 ffmpeg 时 `/api/health` 的 `capabilities.analyze=false`（端上恒 false）。**抽帧必须带 `-y`**：否则第二次分析时 ffmpeg 等「是否覆盖」，亮度全 null 而截图还是旧的。A2–A5（VLM/H3）仍冻结 |

ffmpeg 为什么是硬前提：B站/YouTube 全是 DASH 音视频分离，yt-dlp 下完会得到
`.fXXX.mp4` + `.fXXX.m4a` 两个文件然后警告 ffmpeg 不存在，结果是**无声视频**。
抖音那套能跑通，纯粹因为抖音返回单文件 mp4。

## 三、目录与运行

```
├─ ts/src/           主线（Bun）：cli.ts / server.ts / auth.ts / skill_cli.ts
│  ├─ core/          契约层：types / platform / config / http / progress / cancel / rate / naming / errors
│  ├─ engines/       douyin / netease / qq / kuwo / kugou / bilibili(_api) / sniff(L2) / generic(yt-dlp)
│  └─ analyze/       A1：分镜(scdet) / 抽帧 / 台词 / 客观指标（不依赖任何模型）
├─ ts/tests/         bun test（当前 298 个）
├─ web/              Vue 3 界面（默认入口 /）+ vendor / assets（无 PWA：sw/manifest 已删）
├─ ts/skill/         TS Skill 源（SKILL.md + references），由 tools/build_skill_ts.py 组装
├─ legacy/python/    Python 归档：vdl / skill / tests / tools / dy_* / VDACC.bat（冻结，仅参考）
├─ docs/             CHANGELOG.md、music-channels.md、design/
├─ mobile/android/   Android 壳：本地引擎模式（引擎 bundle 在 assets）+ 连电脑模式
│                    engine/ 是引擎打包工程（Bun.build + shims），见同目录 README
│                    源码入库，build/ 与 .gradle/ 不入库
├─ tools/            构建脚本（build_skill_ts.py；legacy 构建在 legacy/python/tools/）
├─ VDACC.bat         双击启动：起服务 + --open 打开浏览器
├─ 下载/             输出目录（不入库）
└─ venv/             Python 环境（只给 legacy 用，不入库）
```

```bash
bun ts/src/cli.ts probe "<url>" --json
bun ts/src/cli.ts get "<url>" -o 下载 --limit 2M     # --limit 可选（K/M 后缀）
bun ts/src/server.ts --port 8765 --token <token>
cd ts && bun install          # auth 需要 playwright-core（复用系统 Edge）
bun test ts/tests
```

**环境准备（新机器 / 重装）**

```bash
winget install Oven-sh.Bun Gyan.FFmpeg    # 都装到用户目录；装完必须新开终端，旧窗口 PATH 不刷新
cd ts && bun install                       # 只装 playwright-core（复用系统 Edge，不下载浏览器）
venv\Scripts\python.exe -m pip install playwright yt-dlp   # 仅 legacy 需要
```

验收（缺一不可）：

```bash
bun --version                              # 1.4.x
ffmpeg -version                            # 9.x；缺了 B站/音乐/m3u8 全废
bun test ts/tests                          # 298 pass
bun ts/src/cli.ts probe "<抖音或B站链接>" --json
```

`vdl auth`（扫码登录）依赖 `cd ts && bun install`，否则报 playwright-core 缺失。

## 四、工程约定

- **代码里不写绝对路径。** TS 用 `import.meta.dir` + `path.join` 派生；legacy 用
  `pathlib.Path(__file__).resolve().parent`。输出目录可用参数覆盖。
- **服务端与 CLI 共用同一批引擎。** 业务逻辑只写在 `ts/src/engines/`，`cli.ts` / `server.ts` /
  `skill_cli.ts` 都只是壳。这个后端要给 agent 调用，输出必须是结构化数据而非只给人看的日志。
- **单例约束**：`%LOCALAPPDATA%\vdl\profile` 同时只能被一个进程使用（Playwright 会锁），
  TS `auth` 与 legacy 共用同一目录，所以两边也不能同时跑。
- **纯 HTTP 引擎只用标准库（legacy）。** `legacy/python/dy_http.py` 故意不依赖 requests / playwright：
  换台机器 clone 下来就能跑。别为省事给它添新依赖。
- **请求与任务状态隔离。** `core/operation.ts` 为每个 HTTP 请求和下载任务创建独立作用域；
  引擎使用 `operationState`，不要重新引入全局 last* / URL 缓存或进度、取消回调。
  队列按设置起 1–4 个 worker；同名目标由 `core/dest.ts` 预留（同时写才加后缀），
ffmpeg 已改异步可取消。**限速仍是「每条流」**，总带宽 ≈ 并发 × 限速；yt-dlp 子进程不受我们的限速。
- **契约优先。** 对外字段只加在 `ts/src/core/types.ts`（schema=2），错误码由 `core/errors.ts` 统一；
  legacy 对应 `legacy/python/vdl/core/models.py`、`errors.py`，两边字段名必须一致。
  不许在壳里自己拼字段名，也不许把已知失败写成"下载失败"了事。
- **本地服务的安全约束别松。** `ts/src/server.ts` 必须：默认只绑 `127.0.0.1`、`/api/*` 校验 token、
  带 `Origin` 的请求校验同源（`VDL_ALLOW_ORIGIN` 才放行宿主）、`/api/reveal` 与 `/api/files`
  只能访问输出目录内的路径、`/api/stream` 只代理白名单域名。少任何一条，任意网页都能向本机提交任务或读走文件。
- **局域网模式**：TS 主线默认绑 `127.0.0.1`；`--lan` 会绑 `0.0.0.0` 供手机壳访问，
  必须同时满足：token 校验不变、`Origin` 只放行「与本请求 Host 完全一致」的来源、
  启动时打印醒目警告与仅内网 IP。公共网络下不要开。
- **凭据只在用户目录。** `bun ts/src/cli.ts auth`（legacy：`python -m vdl auth`）写
  `%LOCALAPPDATA%\vdl\auth\`（`storage_state` 里是 HttpOnly cookie），profile 在
  `%LOCALAPPDATA%\vdl\profile`。两者永不入库、永不打印值——日志只报 cookie 名与数量。
  **测试/冒烟必须设 `VDL_AUTH_DIR` 指到临时目录**：`POST /api/auth/bilibili/logout` 会真删
  `auth/bilibili.json`（2026-11-10 误删过一次，靠同目录 `bilibili.cookies.txt` 还原）。
- **Skill 只能由构建脚本组装。** TS 版：`python tools/build_skill_ts.py --zip`（单文件 `vdl.exe`
  + `ts/skill/SKILL.md`）；legacy 版：`legacy/python/tools/build_skill.py`。别手工往 `dist/` 拷代码。
  legacy 包刻意排除 `legacy/python/vdl/web` 与 `server.py`（Agent 不需要，且含授权受限的插画）；
  TS 包只含 `skill_cli.ts`。
- **legacy 已冻结。** `legacy/python/`（`dy_dl.py` / `dy_gui.pyw` / `vdl/` / `skill/` / `tests/`）
  只保留抖音浏览器兜底与历史参考，不再加新能力、不接新站点；新功能一律加在 `ts/`。
  **不要**把 tkinter 迁到 TS——浏览器引擎在 legacy 里，迁过去会丢能力。
- **3.0 起新能力只加 `ts/`。** 解析/服务的主线是 `ts/src`（Bun），`legacy/python/vdl/` 只修
  会让 legacy 彻底不可用的 bug，不接新站点、不改契约。对外契约仍是 `schema=2`，
  两边字段名必须一致（`ts/src/core/types.ts` ↔ `legacy/python/vdl/core/models.py`）。
- **TS 引擎的 Cookie 必须过滤。** B站 番剧接口对超大 Cookie 头返回 400；
  只带域名匹配且未过期的（约 27 条/1.7KB），不要直接把 `storage_state` 全拼进去。
- **提交前脱敏**：确认没有 cookie / 密钥 / 绝对路径 / 机器名进入 diff。
  `browser_profile/`、`cookies.txt` 已在 `.gitignore` 里，不要用 `-f` 强加。
- 中文注释，函数级说明写清「为什么这么做」，而不只是「做了什么」。
