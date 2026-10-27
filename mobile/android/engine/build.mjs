/**
 * 把 TS 引擎打成 WebView 能直接 `<script src>` 的单个文件。
 *
 * 为什么用 Bun 自带 bundler 而不是 esbuild：仓库里已经装了 Bun（桌面主线就用它），
 * 引 esbuild 等于为一个打包步骤多一个 npm 依赖 + 一份 lockfile。Bun.build 够用。
 *
 * 为什么 format 必须是 iife：页面是 `file:///android_asset/ui/*.html`，
 * 在 file:// 下 `<script type="module">` 会被 CORS 拦掉（Android WebView 也一样）。
 * 打成单文件 + 经典 script 是唯一不需要放宽 WebView 安全开关的走法。
 *
 * 为什么要有 shim 插件：引擎源码 import 的是 `node:path` / `node:crypto`，
 * 浏览器里没有这些模块。这里把它们映射到 shims/ 下，**不修改引擎源码一行**。
 * 任何没映射到的 node: 模块直接构建失败——宁可现在报错，也不要在真机上跑到一半才发现缺能力。
 */
import path from 'node:path';

const here = import.meta.dir;
const repoRoot = path.resolve(here, '../../..');
const outfile = path.resolve(here, '../app/src/main/assets/engine/engine.bundle.js');

/** node: 模块 → shim 文件。加新能力时必须同时加实现和测试。 */
const NODE_SHIMS = {
  'node:path': 'shims/path.ts',
  'node:path/posix': 'shims/path.ts',
  'node:crypto': 'shims/crypto.ts',
};

const nodeShimPlugin = {
  name: 'node-shim',
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => {
      const target = NODE_SHIMS[args.path];
      if (!target) {
        throw new Error(
          `[engine] ${args.path} 被引擎引用了，但端上没有对应实现。\n`
          + `  要么在 shims/ 下补一个并登记到 NODE_SHIMS，要么把这段能力挡在 mobile entry 之外。\n`
          + `  引用来源：${args.importer}`,
        );
      }
      return { path: path.resolve(here, target) };
    });
  },
};

const stamp = new Date().toISOString();

const result = await Bun.build({
  entrypoints: [path.resolve(here, 'src/entry.ts')],
  target: 'browser',
  format: 'iife',
  minify: true,
  sourcemap: 'none',
  define: { BUILD_STAMP: JSON.stringify(stamp) },
  plugins: [nodeShimPlugin],
});

if (!result.success) {
  console.error('[engine] 打包失败：');
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}

const code = await result.outputs[0].text();
await Bun.write(outfile, code);

const gzipped = Bun.gzipSync(new TextEncoder().encode(code)).length;
const rel = path.relative(repoRoot, outfile).replaceAll('\\', '/');
console.log(`[engine] ${rel}`);
console.log(`[engine] 原始 ${(code.length / 1024).toFixed(1)} KB / gzip ${(gzipped / 1024).toFixed(1)} KB`);
console.log(`[engine] builtAt=${stamp}`);
console.log('[engine] 未打包的 node: 模块会在上面直接报错，不会静默降级。');
