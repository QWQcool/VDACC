/* 只做「转发链接」：打开带 token 的本地页面，让用户在页面里选档位。
   这样扩展不需要任何 host 权限，也不需要处理 CORS —— 导航请求不走 Origin 校验。 */
const DEFAULTS = { port: 8765, token: '' };

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'vdl-send',
    title: '用 VDACC 下载此页面',
    contexts: ['page', 'link', 'video', 'audio'],
  });
});

async function openPanel(target) {
  const { port, token } = await chrome.storage.sync.get(DEFAULTS);
  if (!token) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}` +
    (target ? `&url=${encodeURIComponent(target)}` : '');
  await chrome.tabs.create({ url });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const target = info.linkUrl || info.srcUrl || info.pageUrl || (tab && tab.url) || '';
  openPanel(target);
});

chrome.action.onClicked.addListener((tab) => {
  openPanel((tab && tab.url) || '');
});
