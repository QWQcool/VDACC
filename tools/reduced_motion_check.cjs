/**
 * reduced-motion 专项检查（真实浏览器）。
 *
 * 为什么不用「读 CSS 里有没有 @media」来证明：那种断言恒真——规则存在不代表生效，
 * 也不代表没有被别的 !important 覆盖。这里用 Playwright 把浏览器切到
 * `reducedMotion: 'reduce'`，直接读**计算后样式**。
 *
 * 同时做防恒真：同一批元素在 `no-preference` 下必须有非零过渡/动画，
 * 否则「reduce 下是 0s」可能只是因为元素根本没有动效。
 *
 * 用法：node tools/reduced_motion_check.cjs http://127.0.0.1:8765 <token>
 * 退出码：0 通过 / 1 有失败 / 2 缺依赖或参数
 */
const path = require('node:path');

let playwright;
try {
  // 项目里只装了 playwright-core（复用系统 Edge，不下载浏览器）
  playwright = require(path.join(__dirname, '..', 'ts', 'node_modules', 'playwright-core'));
} catch {
  console.error('[reduced-motion] 缺少 playwright-core：先执行 cd ts && bun install');
  process.exit(2);
}

const BASE = (process.argv[2] || 'http://127.0.0.1:8765').replace(/\/$/, '');
const TOKEN = process.argv[3] || process.env.VDL_TOKEN || '';

/**
 * 用合成节点读「类名 → 计算后样式」，不依赖页面当前状态
 * （队列为空时页面里没有 .job，设置面板关着时也没有 .slideover）。
 */
const READ_MOTION = `(() => {
  const host = document.createElement('div');
  host.setAttribute('data-motion-probe', '1');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;';
  host.innerHTML = '<button class="btn primary">x</button>'
    + '<input class="input" value="x">'
    + '<div class="bar"><i></i></div>'
    + '<div class="slideover"></div>';
  document.body.appendChild(host);
  const sels = ['.btn', '.input', '.bar i', '.slideover'];
  const out = sels.map((sel) => {
    const el = host.querySelector(sel);
    if (!el) return { sel, missing: true };
    const cs = getComputedStyle(el);
    return {
      sel,
      transitionDuration: cs.transitionDuration,
      transitionProperty: cs.transitionProperty,
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
    };
  });
  host.remove();
  return out;
})()`;

const zero = (value) => String(value || '').split(',').every((one) => {
  const v = one.trim();
  return v === '0s' || v === '0ms' || v === '';
});

const moving = (row) => !zero(row.transitionDuration)
  || (row.animationName && row.animationName !== 'none' && !zero(row.animationDuration));

async function readMotion(browser, reducedMotion) {
  const context = await browser.newContext({ reducedMotion, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="source-input"]', { timeout: 15000 });
    return await page.evaluate(READ_MOTION);
  } finally {
    await context.close();
  }
}

async function main() {
  if (!TOKEN) {
    console.error('用法: node tools/reduced_motion_check.cjs <baseUrl> <token>');
    process.exit(2);
  }

  const failures = [];
  let browser;
  try {
    browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  } catch (error) {
    console.error(`[reduced-motion] 启动 Edge 失败：${error.message}`);
    process.exit(2);
  }

  try {
    const reduced = await readMotion(browser, 'reduce');
    const normal = await readMotion(browser, 'no-preference');

    console.log('[reduced-motion] reduce 下的计算样式');
    for (const row of reduced) {
      if (row.missing) {
        failures.push(`探针节点缺失：${row.sel}（选择器写错了？）`);
        console.log(`  ????  ${row.sel}  探针节点缺失`);
        continue;
      }
      const ok = zero(row.transitionDuration) && (row.animationName === 'none' || zero(row.animationDuration));
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${row.sel.padEnd(12)} transition=${row.transitionDuration}`
        + ` animation=${row.animationName}/${row.animationDuration}`);
      if (!ok) {
        failures.push(`${row.sel} 在 reduce 下仍有动效`
          + `（transition=${row.transitionDuration} animation=${row.animationName}/${row.animationDuration}）`);
      }
    }

    // 防恒真：正常偏好下这些元素必须真的有动效，否则上面那组断言毫无意义
    console.log('[reduced-motion] no-preference 对照组（至少 2 个元素要有动效）');
    const animating = normal.filter((row) => !row.missing && moving(row));
    for (const row of normal) {
      if (row.missing) continue;
      console.log(`  ${moving(row) ? 'MOVE' : 'still'} ${row.sel.padEnd(12)} transition=${row.transitionDuration}`
        + ` animation=${row.animationName}/${row.animationDuration}`);
    }
    if (animating.length < 2) {
      failures.push(`对照组只有 ${animating.length} 个元素有动效，断言可能恒真（CSS 过渡是否被删了？）`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error('[reduced-motion] 失败：');
    for (const one of failures) console.error(`  - ${one}`);
    process.exit(1);
  }
  console.log('[reduced-motion] OK');
}

main().catch((error) => {
  console.error('[reduced-motion] 未预期错误：', error);
  process.exit(1);
});
