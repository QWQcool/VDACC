# 媒体下载器 UI 参考（MediaGrabber 概念图）

> 来源：用户提供的概念图（原文件 `98a3a4a6c704fcce7aabf877c6ccb8b2.png`）。
> 该 PNG 未落到本机可访问路径，**请把它另存为 `docs/design/media-grabber-concept.png`**；
> 本文是它的结构化拆解，作为实现时的功能清单与视觉参照。

## 1. 整体结构

```
┌ 顶部栏：Logo + 产品名 + 版本号 + 主题切换 ────────────────┐
├ 输入区（一张白卡）────────────────────────────────────┤
│  ├ 平台链接（左，带「解析」主按钮）                      │
│  ├ 其他网址（右，带「解析」次按钮）+「强制使用通用解析」   │
│  ├ 音乐链接（整行，带「解析」次按钮）                     │
│  └ 画质 chips（720P / 1080P / 2K / 4K）+ 提示文案        │
├ 结果卡（缩略图 + 标题 + 作者/来源/简介 + 平台角标）────────┤
└ 素材列表（多选，逐行：档位 / 大小 / 勾选 / 预览）──────────┘
```

## 2. 视觉 token（照此实现）

| 项 | 值 |
|---|---|
| 页面底色 | `#f2f3f5` |
| 卡片 | `#ffffff`，1px `#e6e8eb`，圆角 8，无重阴影 |
| 主按钮 | `#ff7a00` 实心白字；次按钮 `#9aa0a6` 实心白字 |
| 文字 | 主 `#1f2328`，次 `#6b7280`，提示 `#9aa0a6` |
| 选中态 | 橙色描边 + 浅橙底 |
| 字体 | 系统 UI 字体，正文 13~14px，标题 18px/600 |
| 图标 | 单色线性图标，16px |

## 3. 必须由数据驱动的部分（红线）

| 元素 | 规则 |
|---|---|
| 画质 chips | 只能渲染 `probe` 返回且 `available=true` 的档位；不可用的置灰并给出 `reason`（如「需登录」「需大会员」「源无此清晰度」） |
| 素材行的大小 | 必须是真实 `Content-Length` 或探测值，未知就显示「未知」，**不要编造** |
| 平台角标 | 来自引擎识别结果，不是从域名猜 |
| 音乐 FLAC 标记 | 只有解析结果确实是 lossless 才显示 |

## 4. 明确不照搬

- **2K / 4K 恒亮**：源没有就是没有，不做 upscale。
- **QQ 音乐 / 酷狗 / 酷我入口**：v1 不做（加密容器 + 客户端签名），等真做了再放按钮。
- **“全部选中”默认全勾**：默认只勾最高档，避免用户误下 N 份。

## 5. 交互状态（截图里没画，但必须实现）

1. 空态：只显示输入区 + 一句用法示例。
2. 解析中：按钮转 loading，输入框禁用。
3. 解析失败：卡片位置显示错误码 + 可执行建议（如「需登录 → 点此登录」）。
4. 下载中：行内进度条 + 速度 + 剩余时间；可取消。
5. 完成：行尾出现「打开文件 / 打开目录」。
6. 已存在：行内标注「已存在，跳过」，提供「重新下载」。

## 6. 与后端契约的对应关系

| UI 元素 | 接口字段 |
|---|---|
| 结果卡标题/作者/简介 | `probe.media.{title,author,description,thumbnail}` |
| 画质 chips | `probe.formats[].{label,height,available,reason}` |
| 素材行 | `probe.formats[].{label,bytes,ext,codec}` |
| 下载按钮 | `POST /api/jobs {formatIds:[...]}` |
| 进度 | `GET /api/events`（SSE：`{jobId,percent,speed,eta,state}`） |

## 7. 视觉基线（infOS 移动端原型）

`docs/design/screenshots/prototype-baseline-1440x900.png` —— 由 REA 浏览器场景对
`C:\Users\v_chchsli\Desktop\remote-client-prototype\index.html` 的真实渲染截取：

| 参数 | 值 |
|---|---|
| 浏览器 | Edge（headless），Chromium 155 |
| 视口 | 1440×900 @1x |
| 环境 | `zh-CN` / `Asia/Shanghai` / `prefers-reduced-motion: reduce` / service worker 阻断 |
| 等待 | 1500ms（等字体与 SVG 就位） |

复现方式：

```powershell
# 1) 起静态服务（REA 只接受 http(s)，不接受 file://）
Start-Process python -ArgumentList "-m","http.server","8899","--bind","127.0.0.1" `
  -WorkingDirectory "C:\Users\v_chchsli\Desktop\remote-client-prototype" -WindowStyle Hidden

# 2) 用 REA 的 capture_browser_scenario 抓图（launch 模式，executable_path 指向 msedge.exe）
# 3) 结果里的 data_base64 落盘保存为 PNG
```

用途说明：这张图是**风格参照**，不是我们的 UI 验收基线。等 `vdl serve` 的 Web UI 做出来之后，
再对我们自己的页面建立像素基线；届时同样的参数（1440×900、reduced motion、清 toast）可复用。
