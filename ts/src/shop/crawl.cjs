/**
 * 抖音商城商品页抓取（node + playwright-core + 系统 Edge）。
 *
 * 为什么必须过浏览器：商品数据来自 `aweme/v2/shop/promotion/pack/h5/`，URL 上挂着
 * `a_bogus` + `verifyFp`，是页面 JS 现算的；直接请求 `product/detail?id=` 只回 44 字节错误。
 *
 * 输出：stdout 一行 JSON `{ ok, finalUrl, pack }`（失败时 `{ ok:false, error }`）。
 * 父进程（`ts/src/engines/douyin_shop.ts`）负责解析与下载。
 *
 * 参数：node crawl.cjs <url> [timeoutMs]
 */
const { chromium } = require('playwright-core');

const URL_ARG = process.argv[2];
const TIMEOUT = Number(process.argv[3] || 45000);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PACK_RE = /\/aweme\/v2\/shop\/promotion\/pack\/h5\//;

const out = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); };

(async () => {
  if (!URL_ARG) { out({ ok: false, error: 'missing url' }); return; }

  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  } catch (err) {
    out({ ok: false, error: `启动 Edge 失败：${err.message}` });
    return;
  }

  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 414, height: 896 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();

    let resolvePack;
    const packPromise = new Promise((resolve) => { resolvePack = resolve; });

    page.on('response', (res) => {
      if (!PACK_RE.test(res.url())) return;
      res.json().then((json) => resolvePack({ pack: json, url: res.url() })).catch(() => {});
    });

    const navigated = page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
      .then(() => page.url())
      .catch((err) => { throw new Error(`打开页面失败：${err.message.split('\n')[0]}`); });

    await navigated;

    const hit = await Promise.race([
      packPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT)),
    ]);

    if (!hit || !hit.pack) {
      // 兜底：有的场景 pack 被缓存、不再走网络，从 DOM 里捞标题与图片
      const dom = await page.evaluate(() => ({
        title: (document.title || '').trim(),
        images: [...new Set([...document.images].map((i) => i.currentSrc || i.src).filter((u) => /ecom-shop-material|item\.ecombdimg/.test(u)))],
      })).catch(() => ({ title: '', images: [] }));
      out({ ok: false, error: '没有抓到商品数据包（可能是登录墙/风控页）', finalUrl: page.url(), dom });
      return;
    }

    out({ ok: true, finalUrl: page.url(), pack: hit.pack, packUrl: hit.url });
  } catch (err) {
    out({ ok: false, error: err.message || String(err) });
  } finally {
    await browser.close().catch(() => {});
  }
})();
