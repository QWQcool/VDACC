/**
 * 把 `web/vue` 搬进 APK 的 assets（M1-d）。
 *
 * 不直接改 `web/vue`：桌面端还在用它，两边共用的前提是**只换 API 那一层**
 * （`vue/api.js` → `ui/local-api.js`），界面代码一行不动。
 *
 * 两个必须处理的差异：
 * 1. 桌面用绝对路径（`/vue/app.js`、`/styles.css`），在 `file://` 下会解析到根目录 → 必须改相对路径；
 * 2. 端上没有 HTTP 服务，`index.html` 要先加载引擎 bundle，再加载 `local-api.js` 顶掉 `api.js`。
 *
 * 产物落在 `app/src/main/assets/ui/app/`，与 `assets/engine/engine.bundle.js` 同级引用。
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dir;
const ROOT = path.resolve(HERE, '../../..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'mobile/android/app/src/main/assets/ui/app');

function copy(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. 静态资源
copy(path.join(WEB, 'styles.css'), path.join(OUT, 'styles.css'));
copy(path.join(WEB, 'vendor/vue.global.prod.js'), path.join(OUT, 'vendor/vue.global.prod.js'));
for (const name of ['style.css', 'i18n.js', 'format.js', 'jobs.js', 'overlays.js', 'app.js']) {
  copy(path.join(WEB, 'vue', name), path.join(OUT, 'vue', name));
}
// 端上的 API 适配层（顶掉 vue/api.js）
copy(path.join(HERE, 'ui/local-api.js'), path.join(OUT, 'local-api.js'));

// 2. index.html：绝对路径 → 相对路径，api.js → local-api.js，前置引擎 bundle
const html = readFileSync(path.join(WEB, 'vue/index.html'), 'utf8');
const rewritten = html
  .replace(/href="\/assets\/icon-192\.png"/, 'href="icon-192.png"')
  .replace(/(href|src)="\/styles\.css"/g, '$1="./styles.css"')
  .replace(/(href|src)="\/vue\//g, '$1="./vue/')
  .replace(/(src)="\/vendor\//g, '$1="./vendor/')
  // 产物在 assets/ui/app/，引擎在 assets/engine/ → 往上两级
  .replace('<script src="./vue/api.js"></script>',
    '<script src="../../engine/engine.bundle.js"></script>\n<script src="./local-api.js"></script>');

if (rewritten === html) {
  console.error('[ui] index.html 没有被改写：路径规则可能变了，先看一眼再继续');
  process.exit(1);
}
if (!rewritten.includes('../engine/engine.bundle.js')) {
  console.error('[ui] 没能注入引擎 bundle：api.js 的 script 标签形状变了');
  process.exit(1);
}
writeFileSync(path.join(OUT, 'index.html'), rewritten, 'utf8');

console.log(`[ui] 产物 ${path.relative(ROOT, OUT)}（index.html + ${7} 个脚本/样式）`);
