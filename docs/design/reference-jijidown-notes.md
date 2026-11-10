# 唧唧Down V2.3.17 参考笔记（B站 登录与下载交互）

> 记录时间：2026-11-10。对象：`D:\Program Files\JiJiDown\JiJiDown.exe`（V2.3.17 Beta，18 738 176 字节，
> SHA-256 `a265bf8bacd598f838176e4f25f5c3cca386711c74ac8fdc81f05a9491a64980`，无数字签名）。
> 目的：用户反馈"登录账号经常卡网页"，要借鉴它的扫码登录与分析页交互。
> **边界**：只学机制与交互，不复刻实现、不绕过会员/付费、不碰 DRM、不修改目标程序。

## 1. 做到了什么，没做到什么（先看这条）

| 层 | 手段 | 结果 |
|---|---|---|
| 形态识别 | PE 头 + 版本资源 | x86-64 PE，`FileVersion=2.3.17`，`ProductName=唧唧 V2.3.17 Beta` |
| 技术栈 | 二进制内 `.cargo/registry` panic 路径、`__TAURI_INTERNALS__.invoke`、`EBWebView` 目录 | **Tauri 2.11.2**（`tauri-2.11.2` / `wry-0.55.1` / `webview2-com`）+ Rust 后端 |
| 依赖清单 | panic 路径里的 `index.crates.io-*/<crate>-<ver>/` 正则提取 | 约 110 个 crate（`reqwest` / `rusqlite` / `qrcode` / `aes` / `quick-xml` / `image` / `zip` / `tray-icon` / `muda` / `notify-rust` …） |
| 网络行为 | 它自己写的日志 `%APPDATA%\com.jijidown.desktop\logs\2026-11-10.log`（142 行 / 329 KB） | 完整请求 URL、请求头、响应头、命令序列 |
| 接口 | 我们直接调 B站 官方接口复核 | generate / poll 两个接口实测通过（见 §3.1） |
| 反编译 | ✅ 已做（2026-11-10 当天补装 Ghidra 12.2 + JDK 25，见 §9） | 拿到 12 个函数的伪代码与交叉引用；**参数级结论仍取不到**（Rust `fmt::Arguments` 把数值优化成间接引用） |
| 反编译（IDA） | ❌ 不做 | IDA Pro 需商业授权、不能自动下载，IDA Free 不支持插件（REA 适配器与 `ida-pro-mcp` 都要插件） |
| 前端 JS | ❌ 未解开：Tauri 把前端当作 brotli 压缩资产塞进 phf 表 | 界面行为取自用户截图 + 日志，不取自 JS |

`inspect_rust_binary` 报告 `.dep-v0` 段不存在（发布时没开 cargo-auditable），所以依赖清单是从 panic 路径反推的，
**它只是"这个 crate 参与编译"的证据，不证明调用关系**。

## 2. 落盘形态

```
D:\Program Files\JiJiDown\
├─ JiJiDown.exe            18.7 MB，未签名
├─ program\ffmpeg.exe       7.4 MB（自带，不依赖系统 PATH）
└─ other\                   两个占位 txt

%LOCALAPPDATA%\com.jijidown.desktop\EBWebView\      WebView2 用户数据（证实是 WebView2，不是 Electron）
%APPDATA%\com.jijidown.desktop\
├─ jijidown.sqlite3         WAL；app_meta(key,value) + download_tasks(id,position,task_json)
├─ login\bilibili.json      {version, nonce(12B), ciphertext}  ← 凭据加密存储
├─ logs\YYYY-MM-DD.log      逐命令 + 逐请求日志
├─ background\ conversion-queue\
```

下载任务不是内存态：整条任务序列化成 JSON 写 `download_tasks.task_json`，`position` 管顺序，重启可恢复。
凭据是加密的（依赖里有 `aes-0.8.4` + `cipher`，**没有** `aes-gcm`），12 字节 nonce；具体模式未确定，我们不复刻这个格式。

## 3. B站 扫码登录（本轮最有价值的部分）

### 3.1 接口（我们已实测，不是抄它的结论）

```
GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate      # 只带 UA，无 cookie
→ {"code":0,"data":{"url":"https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=<32 hex>&from=",
                    "qrcode_key":"<32 hex>"}}

GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=<key>
→ {"code":0,"data":{"url":"","refresh_token":"","timestamp":0,"code":86101,"message":"未扫码"}}
```

关键点：**外层 `code` 恒 0，状态在内层 `data.code`**。取值与含义（先两条来自我们实测与它日志，
86090 / 86038 来自其错误文案与公开文档，本节标注为待复核）：

| `data.code` | 含义 | 证据 |
|---|---|---|
| 86101 | 未扫码 | 我们实测 + 它日志 `code=86101 message=未扫码` |
| 86090 | 已扫码，待手机确认 | 其文案「已扫码，请在手机上确认登录」+ 公开文档（待我们实测确认） |
| 86038 | 二维码失效 | 其文案「二维码已过期，请刷新后重试」（待实测确认） |
| 0 | 成功 | 它日志 `has_url=true has_cookie=true timestamp=<非0>` |

登录成功后它做的事（日志字段名即证据）：取 `url` 查询串、取响应 `Set-Cookie`、记录 `timestamp`；
拿不到 cookie 会明确报「登录成功但未收到 Cookie」，不是静默失败。
其中「取 `Set-Cookie`」这一步已由 Ghidra 交叉引用确认落在轮询函数里（`set-cookie` 字符串引用自
`FUN_1401d0bf0`，见 §9）。

### 3.2 状态机（日志原文，2 秒一次）

```
[command:generate_login_qrcode] success qrcode_key=6e0e...
[command:poll_login_qrcode]    success status=pending message=未扫码     ×N（间隔约 1.8s）
```

前端只拿 `{status, message}`，二维码过期由前端重新 `generate`。

### 3.3 二维码图像

字符串 `data:image/png;base64,` + 依赖 `qrcode-0.14.1` → **二维码在 Rust 侧生成 PNG**，当 data URL 交给 WebView 显示。
也就是说整个登录过程**没有打开任何浏览器**，只调了 3 个 HTTP 接口（generate / poll / nav）。

### 3.4 登录态展示

`x/web-interface/nav` 拿 `isLogin / uname / mid / vipStatus`。界面两态（用户截图）：
未登录 → 红色「未登录 只能下载480P」；已登录 → 头像 +「昵称 [大会员]」+「退出」。

## 4. playurl 与清晰度

日志原文：

```
[playurl] request url: https://api.bilibili.com/x/player/playurl?avid=<aid>&bvid=<bv>&cid=<cid>&qn=127&fnval=4048&fourk=1
[playurl] request headers:
  user-agent: ...Chrome/125.0 Safari/537.36
  referer: https://www.bilibili.com/video/<bv>?p=<n>
  accept-encoding: identity
[command:get_page_download_quality] success quality=116
```

- **请求 qn=127（最高），再读响应里实际给到的档位**，界面据此显示「将会下载 1080P60」。
  这是"先探测再承诺"的做法，不是"猜最高档"。
- **没有 wbi 签名**：整个二进制里不存在 `w_rid` / `img_key` / `sub_key` / `mixinKey` 字符串。
  这条只说明它没签，**不说明签名无用**——我们主线仍保留 wbi（`bilibili_api.ts` 已实现）。
- 未登录上限 480P（其 UI 自述），登录非大会员到 1080P60（日志 `quality=116`）。
  我们的档位比它高（wbi + `fnval` 矩阵 + 页面 SSR 补 `id=122`），**这部分不搬**。

## 5. 附属资源

| 产物 | 接口 | 备注 |
|---|---|---|
| 弹幕 | `https://api.bilibili.com/x/v1/dm/list.so?oid=<cid>` → XML | 失败回落 `https://comment.bilibili.com/<cid>.xml`；`quick-xml` 解析，可转 ASS |
| 字幕 | `https://api.bilibili.com/x/player/wbi/v2?bvid=<bv>` → `subtitle_url` | 注意：它调的是 **wbi/v2 却没签名**，大概率会被降级；这一点我们没有实测 |
| 封面 | 取回图片再转 `data:image/...;base64,` | 日志 `get_cover_image_data success data_chars=91163 / 146927 / 298571`，即"服务端代取，界面不直连图床" |
| 头像 | `i0.hdslb.com/bfs/face/...` | 同上，走同一命令 |

命名后缀见字符串：`_danmaku`、`_danmaku.xml`、`_subtitle`；流文件 `.m4s` / `.m4a`。

### 5.1 收藏夹与合集（它做了，我们不做）

用户 2026-11-10 的印象是「唧唧Down 也没做收藏夹」。**这句与证据不符**，先把事实摆清：

- 命令名：`get_favorite_detail`（与 `get_video_detail` / `generate_login_qrcode` 同在一张命令表里）；
- 接口：`https://api.bilibili.com/x/space/fav/season/list?season_id=`（收藏夹season列表）；
- 中文文案：`收藏夹内没有可下载的视频`、`未能识别收藏夹 ID`、`获取收藏夹失败：`、`解析收藏夹失败：`、
  `合集内没有可下载的视频`、`解析合集失败：`；
- 结构体：`FavoriteInfo` / `FavoriteMedia` / `FavoriteSeason` / `FavoriteResource` / `UgcSeason` / `UgcEpisodeArc`。

也就是说**收藏夹 + 合集两条都做了**。

关键细节：**它是"分页列表 + 逐条下载"，不是"一键全下"**。证据三条：

1. IPC 命令表里收藏夹只有 `get_favorite_detail`（旁边是 `get_video_detail`）；
   下载只有单数 `start_video_download`，**没有任何 `download_favorite` / `start_batch` 类命令**；
2. 列表接口自带分页参数与 `has_more` 游标：
   - 收藏夹媒体列表：`https://api.bilibili.com/x/v3/fav/resource/list?media_id=<id>&pn=<页>&ps=<每页>&keyword=&order=mtime&type=0&tid=0&platform=web`
   - 合集列表：`https://api.bilibili.com/x/space/fav/season/list?season_id=<id>&pn=<页>&ps=<每页>`
   - 数据结构 `FavoriteResourceData` 带 `has_more`，`FavoriteSeasonData` 是 `{info, medias}`；
3. 入口是链接解析：字符串里有 `https://space.bilibili.com/`、`fid=`、`media_id=`，配「无法识别收藏夹 ID」的报错 ——
   用户粘一条收藏夹链接，它解析出 id 再翻页拉。

所以用户 2026-11-10 提议的「批量选择入口 + 自己决定下载哪些」与它同构。
**边界**：前端是 brotli 内嵌资源，未解开，所以"它界面上有没有全选框"我给不出证据；
只能说**它的后端 IPC 层没有批量入口**。

## 6. 交互机制

**剪贴板 →「立即分析」**

```
[command:update_clipboard_monitor_settings] start enabled=true auto_show=false
[command:clipboard_notification_parse] start url=https://www.bilibili.com/video/BV1eaW86KEr3/?trackid=...&spm_id_from=...
[command:clipboard_notification_parse] success emitted
[command:open_url] start url=https://www.bilibili.com/video/BV1eaW86KEr3      ← 「前往B站」
```

Rust 侧轮询 Win32 剪贴板 → 解析出视频 URL → `emit` 事件 → 前端弹右下角卡片（不自动跳转，`auto_show=false`）。

**分析页**（截图 + 日志字段）：封面 / `VIDEO · <BV>` / 标题 / 共 N P / 简介 / UP 主头像；
动作按钮 `前往B站`（系统浏览器）/`重新加载`/`批量下载`；
每个分 P 卡片：`第 N P · 标题`、`CID <cid> · <时长>`、资源五选（视频/音频/弹幕/字幕/封面）、`下载到...`、
画质 chip（`将会下载1080P60`）。

**其它已确认的实现选择**

- 断点续传：依赖 `http-range-0.1.5`；对应我们已做的 `Range: bytes=<resume>-`
- 完整性：`x-upos-md5` 头 + 下载后 MD5 校验；我们有 sha256 但只用于组件，视频不做校验
- 播放地址过期：`无法刷新视频/音频/无损音频/杜比音频下载地址`、`下载失败：刷新播放地址重试次数已用尽`
  → 403 后重新 playurl 再续传，有次数上限
- 合并失败降级：`missing separate audio stream, remuxing video only`
- 转码参数：`-map 0:v:0? -map 0:a:0? -c:v libx264 -preset veryfast -crf 23 -c:a aac -movflags +faststart mp4`
- 音频选择顺序（字符串碎片 `全景声 Atmos Hi-Res flac xml`）：`dash.flac` > `dash.dolby.audio` > 普通 audio

## 7. 借鉴与不借鉴

| 点 | 判断 | 理由 |
|---|---|---|
| 纯 HTTP 扫码登录（无浏览器） | ✅ 借鉴 | 3 个 GET 就能拿到 cookie，彻底绕开"卡网页"、Edge 缺失、profile 单例锁 |
| 二维码在服务端渲染成 PNG | ✅ 借鉴（方式待定） | 一处实现同时喂 Web 与 CLI；具体用依赖还是自研见 Plan.md §2.7 决策 D1 |
| "先 probe 再承诺档位" | ✅ 已有 | 我们 `/api/probe` 返回的就是实际可用档位 |
| 每 P 五类资源勾选 + 批量下载 | ✅ 借鉴 | 我们 probe 已回 `parts[]`/`formats[]`，缺的是界面 |
| 剪贴板 → 右下角卡片 | 🟡 改形态 | 它是 Rust 读 Win32 剪贴板；我们是浏览器页，只能靠 `navigator.clipboard`（需授权）或粘贴事件 |
| 封面代取转 base64 | 🟡 按需 | 我们当前直连 `i0.hdslb.com`；若实测裂图再加代理，不预先扩接口 |
| 内嵌 webview 站内搜索 | ❌ 不做 | 需要桌面壳（它靠 Tauri webview + cookie 同步）；我们无壳 |
| 收藏夹 / 合集 | ✅ 做，但只做「选择入口」 | 见 §5.1：它也是分页列表 + 逐条下载，没有批量命令；我们照这个形态做，不做"一键全下" |
| 托盘 / 右键菜单 / 自动更新 / 单实例 | ❌ 不做 | 桌面壳特性；我们是"内核 + 可选 Web GUI + Skill" |
| 凭据加密落盘 | ❌ 不复刻 | 它自定义 `{version,nonce,ciphertext}`；我们靠用户目录边界，要加密应走 DPAPI 另立议题 |
| 1080P60 当上限卖点 | ❌ 不搬 | 我们已能拿 4K，且能补 SSR 的 122 档 |

## 8. 还剩什么没拿到

1. **参数级数值**（playurl 的 `qn`/`fnval`、刷新地址的重试次数）：Rust 用 `fmt::Arguments` 拼 URL，
   数值在结构体里被优化成间接引用，Ghidra 伪代码里读不到（详见 §9 的停止理由）。
2. **前端 JS**：Tauri 资产是 brotli 压缩块 + phf 键表，需按键定位再逐块解压（本轮未做）。
3. **成功扫码那一步的真实响应**：需要一次人工扫码。我们按两路并集实现，不依赖它。

要跨过第 1 条只剩运行期抓包（mitmproxy 装根证书），静态分析收益已到底。

## 9. Ghidra 二轮静态取证（2026-11-10）

### 9.1 工具链（全部装在 D:）

| 组件 | 版本 | 位置 |
|---|---|---|
| JDK | Temurin 25.0.5+8 | `D:\Tools\jdk\jdk-25.0.5+8` |
| Ghidra | 12.2 PUBLIC（2026-10-16） | `D:\Tools\ghidra_12.2_PUBLIC` |
| 工程/脚本/输出 | — | `D:\Tools\ghidra-work\{proj,scripts,out}` |

安装包 SHA-256 `2c2cd776…a7be67` 与 Release 公告一致后才解压。Ghidra 12.2 要求 **JDK 25**
（`Ghidra/application.properties` 里 `application.java.min=25`），本机原本没有任何 Java。

两个踩到的坑：

- `analyzeHeadless.bat` 认的是 **`GHIDRA_MAXMEM` / `GHIDRA_HEADLESS_MAXMEM`**，不是 `MAXMEM`。
  第一轮设了 `MAXMEM=6G` 实际仍跑在默认 2G，`StackVariableAnalyzer` 直接 `OutOfMemoryError`；
  改成 `GHIDRA_HEADLESS_MAXMEM=24G`（本机 64 GB）后约 **17 分钟**完成全量分析。
- `analyzeHeadless.bat` 末尾会 `pause`，用 `Start-Process cmd /c` 后台跑必须 `< nul`，否则进程挂在"按任意键继续"上，
  还会占住日志文件让下一轮起不来。

### 9.2 方法：三轮迭代，每轮都留下失败原因

1. **已定义字符串 → 引用 → 函数**：命中 74 个字符串 / 28 个函数，**全是 null 结尾的普通字面量**；
   Rust 的拼接 URL 没被定义成 string Data，一条都没覆盖到。
2. **内存字节模式 → 引用**：URL 都找到了地址，但 `refs=0`。
3. **回溯到可打印串首再找引用**：字面量实际从 `https://` 起头，代码引用的是串首；这一轮命中 12 个函数。

### 9.3 命中表

| 用途 | 字面量地址 | 引用者（Ghidra 自动命名） |
|---|---|---|
| 扫码二维码生成 | `140cfabc8` | `FUN_1401d4a00`、`FUN_1401d1fc0` |
| 扫码轮询 | `140cfa5a8` | `FUN_1401cf5f0`、`FUN_1401d0bf0` |
| 登录态 nav | `140cfa91b` | `FUN_1401d33e0` |
| playurl | `140d053ac` | `FUN_1402c5f10` |
| view | `140d04316` | `FUN_1402b69f0`、`FUN_1402d64f0` |
| 字幕 `x/player/wbi/v2` | `140d03ea0` | `FUN_1402c1d00` |
| 弹幕 `x/v1/dm/list.so` | `140d04fe1` | `FUN_1402bf110`、`FUN_1402cfb50` |
| 收藏夹 season | `140d054f4` | `FUN_1402b93c0` |

登录相关函数集中在 `0x1401cxxxx–0x1401dxxxx`，与 panic 位置字符串 `src\services\login.rs` 的落点吻合；
播放/字幕/弹幕在 `0x1402bxxxx–0x1402cxxxx`，对应 `src\services\bilibili.rs`。

### 9.4 可以采信的三条

1. **cookie 取自响应头**：`set-cookie` 字符串与 `http-1.4.0/src/header/map.rs` 的 panic 位置一起出现在
   轮询函数 `FUN_1401d0bf0` 里 → 它读 `Set-Cookie` 拿 cookie，并非只解析 `data.url`。
   （我们的实现仍按两路并集，但主次现在有依据。）
2. **没有登录态续期**：整个二进制搜不到 `cookie/info`、`cookie/refresh`、`GenWebTicket`。
   `refresh_token` / `access_token` / `ac_time_value` 只是被当 cookie 存/同步。
   我们另行实测：`cookie/info` 接口存在（未登录返回 `-101 账号未登录`）、
   `cookie/refresh` 是 **POST**（GET 返回 `Method Not Allowed`）→ 续期可行，语义待真实登录后验。
3. **字幕没签名**：无 `w_rid` / `img_key` / `mixinKey`，却调 `x/player/wbi/v2`。
   这正好撞上 AGENTS.md 记过的「未签名的 `/x/player/v2` 会概率性返回别的稿件的字幕」。**这条路不要抄。**

另外确认：无 `dm/web/seg` → 弹幕只有 XML（`list.so` + `comment.bilibili.com` 兜底），没有 protobuf 分段。

### 9.5 为什么停在这里

第三轮拿到的 12 个函数逐个读过：可读性到"哪些 URL 被谁用"为止。参数级问题（`qn` 传几、`fnval` 怎么算、
重试几次）在 `fmt::Arguments` 结构里，伪代码只剩 `CONCAT44` / `memcpy` / `undefined8` 噪声，
继续读下去是在猜，不是在取证。**与其编一个数，不如自己定一个数并写清是设计选择。**
