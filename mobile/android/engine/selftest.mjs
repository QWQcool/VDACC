/**
 * 无设备自检：在 Bun 里加载**构建产物**（不是源码），用一个假桥跑引擎自检 + 落盘探针。
 *
 * 为什么值得写：`assembleDebug` 成功只证明 Kotlin/Java 能编译，不证明「打进 APK 的那份 JS
 * 算出来的东西是对的」，也不证明「JS 调桥时传的字段形状与原生约定一致」。
 * 这里用 node:crypto 当 md5 参照物、用内存假 fs 模仿 Kotlin 侧的返回结构，
 * 于是「打包错 / shim 错 / 字段名错」在命令行就会红，不必等到真机上猜。
 *
 * 用法：bun run build && bun run selftest
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

const here = import.meta.dir;
const bundlePath = path.resolve(here, '../app/src/main/assets/engine/engine.bundle.js');

const code = await Bun.file(bundlePath).text();
if (!code.includes('VDACC_ENGINE')) {
  console.error('[selftest] 产物里找不到 VDACC_ENGINE —— build 配置被改坏了？');
  process.exit(1);
}

// 产物是经典 script（给 WebView 用），不是 ES module，所以用 Function 执行而不是 import
new Function(code)();
const engine = globalThis.VDACC_ENGINE;
if (!engine) {
  console.error('[selftest] 产物没有把 VDACC_ENGINE 挂到 globalThis');
  process.exit(1);
}

/* ─────────────── 假桥：字段形状必须与 Kotlin 侧逐字一致 ─────────────── */

const staging = new Map(); // name -> Buffer
const openHandles = new Map(); // handle -> {name, chunks: Buffer[]}
let seq = 0;
let publishCalls = 0;

function fakeBridge(method, payload) {
  switch (method) {
    case 'crypto.md5Hex':
      // 参照物用 node:crypto，不是再抄一份 JS 实现（抄一份等于自己验自己）
      return { ok: true, data: createHash('md5').update(payload.text ?? '').digest('hex') };

    case 'fs.openWrite': {
      seq += 1;
      const handle = `h${seq}`;
      openHandles.set(handle, { name: payload.name, chunks: [] });
      return { ok: true, data: { handle, stagingPath: `/fake/staging/${payload.name}.part` } };
    }
    case 'fs.writeChunk': {
      const one = openHandles.get(payload.handle);
      if (!one) return { ok: false, error: { code: 'EBADHANDLE', message: `句柄不存在：${payload.handle}` } };
      const bytes = Buffer.from(payload.base64 ?? '', 'base64');
      one.chunks.push(bytes);
      return { ok: true, data: { bytes: bytes.length } };
    }
    case 'fs.closeWrite': {
      const one = openHandles.get(payload.handle);
      if (!one) return { ok: false, error: { code: 'EBADHANDLE', message: `句柄不存在：${payload.handle}` } };
      openHandles.delete(payload.handle);
      const all = Buffer.concat(one.chunks);
      staging.set(one.name, all);
      return { ok: true, data: { bytes: all.length, path: `/fake/staging/${one.name}.part`, name: one.name } };
    }
    case 'fs.publish': {
      publishCalls += 1;
      const all = staging.get(payload.name);
      if (!all) return { ok: false, error: { code: 'ENOENT', message: `暂存文件不存在：${payload.name}` } };
      return {
        ok: true,
        data: { path: `Download/VDACC/${payload.name}`, name: payload.name, outKind: 'mediastore', bytes: all.length },
      };
    }
    case 'fs.stat': {
      const all = staging.get(payload.name);
      if (!all) return { ok: true, data: { exists: false, size: 0, path: '', staging: false } };
      return { ok: true, data: { exists: true, size: all.length, path: `Download/VDACC/${payload.name}`, staging: false } };
    }
    case 'paths':
      return {
        ok: true,
        data: { out: 'Download/VDACC', outKind: 'mediastore', staging: '/fake/staging', cache: '/fake/cache' },
      };
    default:
      return { ok: false, error: { code: 'unsupported_method', message: `selftest 假桥没有实现 ${method}` } };
  }
}

engine.setBridgeTransport((reqId, method, payloadJson) => {
  const payload = JSON.parse(payloadJson || '{}');
  const envelope = fakeBridge(method, payload);
  // 真实桥是异步回投，这里也用微任务模拟，避免掩盖「忘了 await」这类错误
  queueMicrotask(() => globalThis.__VDACC_BRIDGE_RESOLVE__(reqId, JSON.stringify(envelope)));
});

/* ─────────────────────────── 1. 引擎自检 ─────────────────────────── */

const info = engine.engineInfo();
const report = await engine.selfTest();

console.log(`[selftest] engine ${info.version} builtAt=${info.builtAt}`);
console.log(`[selftest] ${report.passed}/${report.total} 通过（桥=${report.bridge ? '可用' : '不可用'}）`);
for (const c of report.checks) {
  const mark = c.ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${c.name}${c.ok ? '' : `  期望=${c.expected} 实际=${c.actual}${c.note ? ` (${c.note})` : ''}`}`);
}

/* ──────────────────── 2. 落盘探针（假 fs，验字段形状） ──────────────────── */

const probeText = 'VDACC selftest 探针\n中文与符号：/\\ "quotes" <tag>\n';
const probe = await engine.writeProbe(probeText);
const expectBytes = new TextEncoder().encode(probeText).length;
const expectChunks = Math.ceil(expectBytes / 16384);
const expectMd5 = createHash('md5').update(probeText).digest('hex');

const probeChecks = [
  ['openWrite 返回的 handle 被正确解构', probe.chunks > 0 || expectBytes === 0, true],
  ['分块数与 16KB 一致', probe.chunks, expectChunks],
  ['字节数与 UTF-8 长度一致', probe.bytes, expectBytes],
  ['publish 后的路径正确', probe.path, 'Download/VDACC/m0-probe.txt'],
  ['落盘方式如实上报', probe.outKind, 'mediastore'],
  ['内容 md5 一致', probe.md5, expectMd5],
  ['publish 被调用且只调一次', publishCalls, 1],
  ['暂存文件名带 .part 后缀', String(probe.stagingPath || ''), '/fake/staging/m0-probe.txt.part'],
];

console.log('[selftest] 落盘探针（假 fs）');
for (const [name, actual, expected] of probeChecks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`}`);
  if (!ok) report.ok = false;
}

/* ─────────────────────────── 3. 汇总 ─────────────────────────── */

const failures = [];
if (!report.ok) failures.push(`引擎自检未全过：${report.passed}/${report.total}`);
if (!report.bridge) failures.push('桥交叉校验没有跑到（假桥应该能应答 crypto.md5Hex）');
if (report.total < 15) failures.push(`断言数变少了（${report.total}），是不是有人删了检查项`);
if (info.builtAt === 'unknown') failures.push('BUILD_STAMP 没有被 define 注入');
if (engine.pendingBridgeCalls() !== 0) failures.push(`还有 ${engine.pendingBridgeCalls()} 个调用挂着`);

if (failures.length) {
  console.error('[selftest] 失败：');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[selftest] OK');
