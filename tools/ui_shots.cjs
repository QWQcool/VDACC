/**
 * 视觉/布局回归（手动运行，需要系统 Edge）：
 *   node tools/ui_shots.cjs http://127.0.0.1:8765 <token>
 *
 * 覆盖 浅/深 × 中/英 × 390/768/1440，截图写到 docs/design/ui/shots/（不入库），
 * 同时检查：没有横向溢出、关键元素存在、控制台无报错。任一失败退出码 1。
 */
const fs = require('node:fs');
const path = require('node:path');

const playwright = require(path.join(__dirname, '..', 'ts', 'node_modules', 'playwright-core'));

const BASE = (process.argv[2] || 'http://127.0.0.1:8765').replace(/\/$/, '');
const TOKEN = process.argv[3] || process.env.VDL_TOKEN || '';
const OUT = path.join(__dirname, '..', 'docs', 'design', 'ui', 'shots');

const THEMES = ['light', 'dark'];
const LANGS = ['zh', 'en'];
const SIZES = [
  { width: 390, height: 844, name: '390' },
  { width: 768, height: 1024, name: '768' },
  { width: 1440, height: 900, name: '1440' },
];

async function main() {
  if (!TOKEN) {
    console.error('用法: node tools/ui_shots.cjs <baseUrl> <token>');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  const failures = [];
  const rows = [];

  for (const theme of THEMES) {
    for (const lang of LANGS) {
      for (const size of SIZES) {
        const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
        const errors = [];
        page.on('console', (msg) => {
          if (msg.type() !== 'error') return;
          const text = msg.text();
          if (text.includes('favicon')) return;
          errors.push(text);
        });

        const name = `${theme}-${lang}-${size.name}`;
        try {
          await page.goto(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
          await page.evaluate(([t, l]) => {
            localStorage.setItem('vdl-theme', t);
            localStorage.setItem('vdl-lang', l);
          }, [theme, lang]);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForSelector('.probe-row button', { timeout: 15000 });
          await page.waitForTimeout(500);

          const probe = await page.evaluate(() => {
            const doc = document.documentElement;
            const btn = document.querySelector('.probe-row button');
            return {
              overflow: doc.scrollWidth - window.innerWidth,
              buttonText: (btn?.innerText || '').trim(),
              nav: document.querySelectorAll('.nav-item').length,
              cards: document.querySelectorAll('.card').length,
            };
          });

          if (probe.overflow > 2) failures.push(`${name}: 横向溢出 ${probe.overflow}px`);
          if (!probe.buttonText) failures.push(`${name}: 解析按钮没有文字`);
          if (probe.cards < 1) failures.push(`${name}: 没有渲染任何卡片`);
          if (errors.length) failures.push(`${name}: 控制台报错 ${errors[0].slice(0, 80)}`);

          await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
          rows.push({ name, overflow: probe.overflow, cards: probe.cards, ok: true });
        } catch (err) {
          failures.push(`${name}: ${err.message.split('\n')[0]}`);
          rows.push({ name, overflow: '-', cards: '-', ok: false });
        } finally {
          await page.close();
        }
      }
    }
  }

  await browser.close();

  for (const row of rows) {
    console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(18)} overflow=${row.overflow} cards=${row.cards}`);
  }
  if (failures.length) {
    console.error('\n失败项:');
    for (const line of failures) console.error(' - ' + line);
    process.exit(1);
  }
  console.log(`\n全部通过，截图在 ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
