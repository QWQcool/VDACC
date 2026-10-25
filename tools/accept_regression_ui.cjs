/** V2 本地回归：独立 Edge + 临时用户目录 + 本地媒体，不访问用户凭据或第三方站点。
 * 运行 node tools/accept_regression_ui.cjs；依赖 cd ts && bun install。
 */
const { chromium } = require('../ts/node_modules/playwright-core');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdacc-ui-regression-'));
const port = 20000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
const token = 'local-regression-token';
const bun = process.env.BUN || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA, 'Microsoft/WinGet/Links/bun.exe') : 'bun');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let backend, browser;
const fixture = http.createServer((req, res) => {
  const bytes = Buffer.alloc(32768, 65);
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
  if (req.method === 'HEAD') res.end();
  else setTimeout(() => res.end(bytes), 150);
});
const api = async (endpoint, body) => (await fetch(base + endpoint, {
  method: body ? 'POST' : 'GET', headers: { 'X-VDL-Token': token },
  body: body ? JSON.stringify(body) : undefined,
})).json();

async function main() {
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const media = `http://127.0.0.1:${fixture.address().port}/fixture.mp4`;
  const env = { ...process.env, LOCALAPPDATA: path.join(temp, 'user'),
    VDL_STORE: path.join(temp, 'history', 'jobs.json'), VDL_ALLOW_ORIGIN: '' };
  async function start() {
    backend = spawn(bun, ['ts/src/server.ts', '--port', String(port), '--token', token, '-o', path.join(temp, 'out')],
      { cwd: root, env, stdio: 'ignore', windowsHide: true });
    backend.on('error', (err) => { console.error(err.message); });
    for (let i = 0; i < 100; i++) {
      try { if ((await api('/api/health')).ok) return; } catch { /* 等待启动。 */ }
      await sleep(100);
    }
    throw new Error('测试服务启动超时');
  }
  await start();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${base}/?token=${token}&url=${encodeURIComponent(media)}`);
  await page.locator('[data-format-id="file"]').waitFor();
  assert.equal(await page.locator('[data-format-id="file"]').getAttribute('aria-pressed'), 'true');

  // 同一次点击的快速重复事件只能提交一次；跟踪 API 返回 ID 而非历史首项。
  let submissions = 0;
  page.on('request', (req) => { if (req.url() === base + '/api/jobs' && req.method() === 'POST') submissions++; });
  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() === 'POST') {
      // 故意让提交时的旧快照晚于 SSE 完成事件，验证 UI 不回退到 running。
      const response = await route.fetch();
      await sleep(600);
      await route.fulfill({ response });
    } else await route.continue();
  });
  const posted = page.waitForResponse((res) => res.url() === base + '/api/jobs' && res.request().method() === 'POST');
  await page.getByTestId('download').evaluate((button) => { button.click(); button.click(); });
  const submitted = await (await posted).json();
  const id = (submitted.jobs || [submitted.job])[0].id;
  await page.locator(`[data-job-id="${id}"][data-status="done"]`).waitFor();
  assert.equal(submissions, 1);
  assert.equal((await api('/api/jobs')).jobs.find((j) => j.id === id).bytes, 32768);

  const settings = page.locator('.topbar button[title="设置"]');
  await settings.click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.waitFor();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '保存');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '关闭');
  await dialog.locator('input').nth(1).fill('-1');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await dialog.getByRole('alert').count(), 1);
  await dialog.locator('input').nth(1).fill('');
  await dialog.locator('select').selectOption('dark');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await settings.evaluate((el) => el === document.activeElement), true);
  assert.equal((await api('/api/settings')).settings.theme, 'dark');

  // 断网期间提交的失败任务只能靠重连快照恢复；UI 不应假显示在线。
  await page.context().setOffline(true);
  await backend.kill(); await once(backend, 'exit'); backend = null;
  await start();
  assert.equal((await api('/api/settings')).settings.theme, 'dark');
  const missed = await api('/api/jobs', { url: 'https://example.invalid/unsupported' });
  const missedId = (missed.jobs || [missed.job])[0].id;
  await page.locator('.topbar [role="status"]').waitFor();
  await page.context().setOffline(false);
  await page.locator(`[data-job-id="${missedId}"][data-status="failed"]`).waitFor({ timeout: 15000 });
  await page.locator('.topbar .pill').waitFor();
  assert.match(await page.locator(`[data-job-id="${missedId}"]`).innerText(), /通用解析|组件/);

  // 请求失败解除解析按钮忙碌态，重试入口可继续使用。
  await page.route('**/api/probe', (route) => route.abort());
  await page.getByTestId('probe').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=probe]').disabled);
  assert.match(await page.locator('.content').innerText(), /网络|连接/);
  await page.unroute('**/api/probe');
  await page.getByTestId('probe').click();
  await page.locator('[data-format-id="file"]').waitFor();
  await page.locator('.topbar .pill').waitFor();

  if (process.argv.includes('--python-acceptance')) {
    const python = process.env.VDL_TEST_PYTHON || path.join(root, 'venv', 'Scripts', 'python.exe');
    const check = spawn(python, ['tools/accept_ui.py', base, media, '--token', token, '--timeout', '30'],
      { cwd: root, stdio: 'inherit', windowsHide: true });
    const [code] = await once(check, 'exit');
    assert.equal(code, 0, 'Python V2 acceptance failed');
  }

  await page.screenshot({ path: path.join(temp, 'desktop.png'), fullPage: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 980 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .map((el) => el.className || el.tagName));
    await page.screenshot({ path: path.join(temp, `width-${width}.png`), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}: ${overflow.join(', ')}`);
  }
  await page.screenshot({ path: path.join(temp, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, scenarios: ['deep-link', 'download', 'duplicate-submit', 'settings-validation',
    'focus-trap-return', 'restart-persistence', 'SSE-recovery', 'network-retry', 'responsive'], artifacts: temp }));
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (backend) { backend.kill(); await once(backend, 'exit'); }
  fixture.closeAllConnections(); fixture.close();
  // 临时截图留作人工复核；真实用户目录从未被修改。
});
