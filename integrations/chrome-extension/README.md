# Chrome / Edge 扩展（MV3）

作用只有一个：**把当前页面链接转发给本机 VDACC**，由页面里选档位、看进度。

## 为什么不需要 CORS 白名单

扩展不调用 `fetch`，而是 `chrome.tabs.create` 打开
`http://127.0.0.1:<port>/?token=...&url=...`。
这是普通导航请求，不触发服务端的 `Origin` 校验，也不需要 `host_permissions`。

## 安装

1. 先启动服务，拿到 token：

   ```bash
   python -m vdl serve
   # 本机: http://127.0.0.1:8765/?token=xxxxxxxx
   ```

2. Chrome/Edge 打开 `chrome://extensions`（Edge 是 `edge://extensions`），开启「开发者模式」；
3. 「加载已解压的扩展程序」→ 选本目录；
4. 点扩展图标 → 打开设置页 → 填端口（默认 8765）与 token。

## 使用

- 页面右键 →「用 VDACC 下载此页面」；
- 或点工具栏图标，把当前标签页发过去；
- 链接参数里的 `t=` 会被保留（页面里再解析）。

## 注意

- 服务必须在本机跑着；关掉服务后扩展只会打开一个连不上的页面。
- token 存在 `chrome.storage.sync`，会随浏览器账号同步——公用电脑上别保存。
