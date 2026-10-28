/**
 * 发行产物的**体积基线**（N05）。
 *
 * 目的不是「再算一遍哈希」——那已经由 `build_skill_ts.py` 写进 manifest.json + SHA256SUMS。
 * 这里回答另一个问题：**这次构建比上次大/小了多少**，以及有没有文件悄悄消失。
 * exe 体积是分发门槛（用户要下载 40MB+ 的包），没有基线就只能靠记忆。
 *
 * 为什么不把 SHA256 写进基线：任何一行代码改动都会让哈希全变，基线会天天飘；
 * 体积是稳定的信号，完整性由 manifest 负责。
 *
 * 用法：
 *   node tools/release_baseline.cjs            构建并与基线对比（不写文件）
 *   node tools/release_baseline.cjs --update   构建并写入 docs/release-baseline.json
 *
 * 退出码：0 通过 / 1 有漂移或构建失败 / 2 参数问题
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'video-acquire-ts');
const ZIP = path.join(ROOT, 'dist', 'video-acquire-ts.zip');
const BASELINE = path.join(ROOT, 'docs', 'release-baseline.json');

/** 允许的抖动：Bun 版本/平台差异会让 exe 有几百 KB 的浮动，超过这个比例才值得报警。 */
const TOTAL_DRIFT_WARN = 0.10;
const TOTAL_DRIFT_FAIL = 0.25;
const FILE_DRIFT_WARN = 0.20;

const update = process.argv.includes('--update');

function fail(message) {
  console.error(`[baseline] ${message}`);
  process.exit(1);
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function build() {
  console.log('[baseline] 构建 Skill 包…');
  const run = spawnSync('python', ['tools/build_skill_ts.py', '--zip'], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  if (run.error) fail(`无法执行 python：${run.error.message}`);
  if (run.status !== 0) fail(`构建失败（退出码 ${run.status}）`);
}

function readCurrent() {
  const manifestPath = path.join(DIST, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`找不到 ${manifestPath}`);
  if (!existsSync(ZIP)) fail(`找不到 ${ZIP}（构建时没带 --zip？）`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = {};
  for (const item of manifest.files || []) files[item.path] = item.bytes;
  return {
    version: manifest.version,
    fileCount: (manifest.files || []).length,
    totalBytes: manifest.total_bytes,
    zipBytes: statSync(ZIP).size,
    files,
  };
}

function compare(current, baseline) {
  const problems = [];
  const notes = [];

  if (baseline.version !== current.version) {
    notes.push(`版本：${baseline.version} → ${current.version}`);
  }

  const currentNames = Object.keys(current.files);
  for (const name of Object.keys(baseline.files || {})) {
    if (!(name in current.files)) problems.push(`基线里的文件不见了：${name}`);
  }
  for (const name of currentNames) {
    if (!(name in (baseline.files || {}))) notes.push(`新文件：${name}（${mb(current.files[name])}）`);
  }

  const drift = baseline.totalBytes
    ? (current.totalBytes - baseline.totalBytes) / baseline.totalBytes
    : 0;
  const sign = drift >= 0 ? '+' : '';
  console.log(`[baseline] 合计 ${mb(current.totalBytes)}（基线 ${mb(baseline.totalBytes)}，`
    + `${sign}${(drift * 100).toFixed(1)}%）`);
  console.log(`[baseline] zip  ${mb(current.zipBytes)}（基线 ${mb(baseline.zipBytes)}）`);

  if (Math.abs(drift) >= TOTAL_DRIFT_FAIL) {
    problems.push(`合计体积漂移 ${(drift * 100).toFixed(1)}%，超过 ${(TOTAL_DRIFT_FAIL * 100).toFixed(0)}%`);
  } else if (Math.abs(drift) >= TOTAL_DRIFT_WARN) {
    notes.push(`合计体积漂移 ${(drift * 100).toFixed(1)}%，请确认是否有意为之`);
  }

  for (const [name, bytes] of Object.entries(current.files)) {
    const before = (baseline.files || {})[name];
    if (!before) continue;
    const one = (bytes - before) / before;
    if (Math.abs(one) >= FILE_DRIFT_WARN) {
      notes.push(`${name}：${mb(before)} → ${mb(bytes)}（${one >= 0 ? '+' : ''}${(one * 100).toFixed(0)}%）`);
    }
  }

  for (const note of notes) console.log(`  注意  ${note}`);
  for (const problem of problems) console.error(`  失败  ${problem}`);
  return problems.length === 0;
}

function main() {
  build();
  const current = readCurrent();

  console.log(`[baseline] 当前：${current.fileCount} 个文件，合计 ${mb(current.totalBytes)}，`
    + `exe ${mb(current.files['vdl.exe'] || 0)}，zip ${mb(current.zipBytes)}`);

  if (update) {
    const payload = {
      // 只记体积，不记哈希：哈希每次构建都会变，完整性看 manifest.json / SHA256SUMS
      note: '体积基线；完整性由 dist/video-acquire-ts/manifest.json + SHA256SUMS 负责',
      version: current.version,
      fileCount: current.fileCount,
      totalBytes: current.totalBytes,
      zipBytes: current.zipBytes,
      files: current.files,
    };
    writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[baseline] 已写入 ${path.relative(ROOT, BASELINE)}`);
    return;
  }

  if (!existsSync(BASELINE)) {
    console.log('[baseline] 还没有基线文件；确认数字后用 --update 建立');
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  if (!compare(current, baseline)) process.exit(1);
  console.log('[baseline] OK（没有超出阈值的漂移）');
}

main();
