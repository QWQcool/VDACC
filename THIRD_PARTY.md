# 第三方资源说明

## 角色美术

- `vdl/web/assets/pero-stand.png` ← infOS `public/assets/onboarding/pero_normal.png`
- `vdl/web/assets/pero-done.png` ← infOS `public/assets/onboarding/pero_proud.png`

两张均由原图等比缩放到 420px 高（原图 3584×4800，约 8MB）。

**版权归 infOS 作者所有**，经其许可在本项目中使用；**不适用**本仓库的 Apache-2.0。
当前只出现在「空态」与「下载完成」两处（解析中复用空态角色）；
后续替换自有角色时，只需替换这两个文件，代码无需改动。

## 设计 token

`vdl/web/styles.css` 的配色、圆角与阴影取值参考 infOS 的
`packages/frontend/src/assets/ui-tokens.css`（Apache-2.0），未直接复制其组件代码。

## 参考工程（朋友授权）

- `docs/design/reference-app-notes.md` 参考自朋友的 **MediaGrabber 1.0.0 鸿蒙工程源码**。
- 口头授权范围：其 UI 代码、文案、素材可用于本项目（含后续移动端）；
  Android / Windows 实现代码未提供，需自行实现。
- 本仓库目前**未包含**其任何文件；其核心引擎（`mg-core.bundle.js`）与平台适配层不复制。
- 若后续引入其 UI 代码或素材，必须在本文件补登具体文件清单与授权时间。
