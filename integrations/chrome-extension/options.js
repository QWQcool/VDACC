const DEFAULTS = { port: 8765, token: '' };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS).then(({ port, token }) => {
  $('port').value = port;
  $('token').value = token;
});

$('save').addEventListener('click', async () => {
  const port = parseInt($('port').value, 10) || 8765;
  const token = $('token').value.trim();
  await chrome.storage.sync.set({ port, token });
  $('status').textContent = '已保存';
  setTimeout(() => { $('status').textContent = ''; }, 1500);
});
