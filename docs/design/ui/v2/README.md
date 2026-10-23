# VDACC 界面示意 V2（infOS 风格为基线）

> V1（`../index.html` 等）以 MediaGrabber 概念图为骨架、橙色为主，被判定偏旧；**V2 取代 V1 成为视觉基线**，
> V1 仅保留作对比。V2 的令牌基本逐条取自 infOS 的 `.docs/S06_UI_UX_DESIGN_SPEC.md`。

## 页面

| 文件 | 说明 |
|---|---|
| `detail.html` | 解析详情页：侧栏 + 顶栏 + 双栏内容（解析 / 媒体卡 / 分P / 音乐+警告 / 任务）+ 右栏运行状态 |
| `detail.html?theme=dark` | 同一页面的暗色主题（只换令牌，不动结构） |
| `settings.html` | 设置以右侧 Slide-over 打开（遮罩 + 模糊 + 18px 左侧圆角） |
| `app.css` | 全部令牌与组件，**没有外部依赖、没有构建** |

本地预览：

```bash
python -m http.server 18799 -d docs/design/ui
# http://127.0.0.1:18799/v2/detail.html
# http://127.0.0.1:18799/v2/detail.html?theme=dark
# http://127.0.0.1:18799/v2/settings.html
```

## 与 V1 的关键差别

| 维度 | V1（旧） | V2（本版） |
|---|---|---|
| 主色 | 橙色 `#ff6a00`，大面积使用 | **粉 `#ec4899`**（品牌/主操作）+ 天蓝 `#0ea5e9`（系统/进行）+ 紫 `#8b5cf6`（音乐/AI），单屏强调色 ≤15% |
| 骨架 | 单列居中，卡片堆叠 | **左侧栏 240px + 主区 + 332px 右栏**（工作站布局，窄屏收起侧栏） |
| 画质 | 橙色分段块 | **浅槽 + 白色选中 pill**（选中项只让文字变粉，不铺大色块） |
| 开关 | 原生 checkbox | 自绘 switch（粉色轨道），focus 有粉色光环 |
| 设置 | 居中 Modal | **右侧 Slide-over**（遮罩 8px 模糊，左侧 18px 圆角） |
| 卡片 | 1px 边 + 阴影 | 同上，但圆角 14、阴影只到 `xs`，hover 只加一点点 |
| 文字 | 14px 起步、颜色跳跃 | 主 14/22，标题 20/28（650），微标签 10–11px + 1.4–1.8px 字距；ID/大小/时间用等宽 |

## 令牌（实现时直接用）

```css
--bg-canvas:#f6f7fb; --bg-surface:#fff; --bg-soft:#fafbfc;
--text-1:#171923; --text-2:#596174; --text-3:#8b93a7;
--line-subtle:rgba(15,23,42,.07); --line:rgba(15,23,42,.11);
--pink:#ec4899; --sky:#0ea5e9; --purple:#8b5cf6;
--emerald:#059669; --amber:#d97706; --red:#dc2626;
--r-sm:7px; --r-md:10px; --r-lg:14px; --r-xl:18px;
--shadow-xs:0 1px 2px rgba(15,23,42,.04); --shadow-sm:0 2px 8px rgba(15,23,42,.055);
```

暗色令牌整套在 `app.css` 的 `[data-theme='dark']`，与 infOS §4.3 一致；**不要明暗混用**。

## 组件清单（细节页覆盖到的）

- 解析卡：44px 输入 + 粉色渐变主按钮 + 平台胶囊（B站粉点 / 音乐紫点 / 其他蓝点）
- 媒体卡：240×135 封面（左上粉光、右下蓝光做氛围，不塞真实图）、20px 标题、等宽 meta、单行截断的源地址
- 画质托盘：4px 内衬 + 白色选中 pill + 等宽体积
- 附属开关：switch + 一行说明
- 警告卡：amber soft 底 + 1px 同色边，承载「未登录 / 仅匿名档 / 会员档被拒」
- 分P列表：勾选 + P 编号 + 清晰度胶囊 + 等宽时长
- 任务卡：状态胶囊（sky/emerald/red/neutral）+ 进度条（sky→purple 渐变，完成转 emerald）+ 右侧动作
- 右栏：Runtime 键值行、最近完成、待处理（amber 文字）
- Slide-over 设置：字段 + 组件安装状态行 + 局域网警告 + 底部保存

## 给实现方的注意

1. 现有前端是 `web/vue/`（Vue 3 global 构建、无打包）。**只换渲染，不动 `/api/*` 契约**。
2. 画质从「多选 chips」改成托盘后，要保留多选语义（现在多档会同时下载，文件名带清晰度后缀）；示意页画的是单选态。
3. `warnbar` → `.alert` 的信息优先级最高，别为了好看把警告收进 tooltip。
4. 中英词条在 `web/vue/app.js` 的 `I18N`；示意页未做 i18n，实现时两条都要补。
5. 暗色只切 `data-theme`，结构不重排；`prefers-reduced-motion` 下关闭所有过渡。
6. 不要引入像素粗边框/发光——infOS 规范里这些只用于选中态和品牌点缀。
