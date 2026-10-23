# VDACC 界面示意（设计原型）

静态 HTML 示意页，用来给下一轮实现定布局与配色。**不是最终实现**，也没有接任何接口；
`mockup.css` 是共享样式，四个页面都只引用它。

## 页面

| 文件 | 场景 | 主题 |
|---|---|---|
| `index.html` | 主界面：单视频解析完成（媒体卡 + 分段画质 + 附属开关 + 任务） | 浅色 |
| `batch.html` | 分P / 番剧批量：整批统一画质、三态全选、集数列表、进行中任务 | 浅色 |
| `album-dark.html` | 音乐专辑：截断提示、曲目勾选、完成/失败任务 | **暗色** |
| `settings.html` | 设置对话框：输出目录、限速、主题、并发、通用组件 | 浅色（对话框） |

本地预览：`python -m http.server 18799 -d docs/design/ui` 后开 `http://127.0.0.1:18799/`。

## 设计依据（三个参考的取舍）

| 来源 | 拿来什么 |
|---|---|
| `docs/design/media-grabber-concept.png` | 暖灰底（`--bg: #f4f3f0`）、橙色主强调（`--accent: #ff6a00`）、分段式画质选择器、媒体卡（左缩略图右元数据）、小字距标签 |
| `infOS`（`ui-tokens.css`） | 卡片 1px 细边 + 弱阴影 + 12px 圆角、三级文字色（primary/secondary/tertiary）、语义色（success/warn/danger）+ soft 底、暗色主题令牌 |
| `remote-client-prototype` | `letter-spacing` 的精致小标题、原生 dialog 式设置层、细边框列表、mono 数字/版本号 |

## 实现时要注意（写给下一轮开工）

- 现有界面是 `web/vue/`（Vue 3 global 构建、无打包），**契约别动**：`/api/*` 的字段与行为都不变，只换渲染。
- 画质从「多选 chips」改成**分段单选/多选**前，先想清楚批量语义：现在多档会同时下载（文件名带清晰度后缀）。
- `sidecarHint`（字幕/弹幕会写附属文件）是用户承诺，别删掉。
- 警告条（`warnbar`）承载「未登录 / 仅匿名档 / 会员档被拒」等关键信息，优先级高于美观。
- 暗色令牌要整套同步换，不能明暗混用。
- 中英文双语词条在 `web/vue/app.js` 的 `I18N` 里，示意页没做 i18n。
