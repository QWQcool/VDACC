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

// 真机上桥由壳在 UI 脚本之前注入，引擎加载时就会把 `fetch` 换成走桥的实现。
// 这里补一个占位 `post` 复现同样的加载顺序；真正的应答由下面的 transport 负责。
// 不这么做的话 `fetch` 会留在 Bun 原生实现上，专辑这类「要发请求」的能力就没法离线验证。
globalThis.VDACC_BRIDGE = { post() {} };

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
    case 'fs.readHead': {
      const all = staging.get(payload.name);
      if (!all) return { ok: false, error: { code: 'ENOENT', message: `暂存文件不存在：${payload.name}` } };
      const want = Math.min(payload.bytes ?? 65536, all.length);
      return {
        ok: true,
        data: { size: all.length, bytes: want, base64: all.subarray(0, want).toString('base64'), truncated: all.length > want },
      };
    }
    case 'fs.rewrite': {
      const all = staging.get(payload.name);
      if (!all) return { ok: false, error: { code: 'ENOENT', message: `暂存文件不存在：${payload.name}` } };
      const skip = payload.skip ?? 0;
      const prefix = Buffer.from(payload.base64 ?? '', 'base64');
      const next = Buffer.concat([prefix, all.subarray(skip)]);
      staging.set(payload.name, next);
      return { ok: true, data: { bytes: next.length, prefixBytes: prefix.length, skip } };
    }
    case 'http.request': {
      // 只喂「专辑」两条真实接口的响应形状；其它 URL 一律 404，避免自检偷偷依赖外网
      const url = String(payload.url || '');
      let body = null;
      if (/\/api\/album\/\d+/.test(url)) {
        body = {
          album: {
            name: '自检专辑', picUrl: 'https://p1.music.126.net/cover.jpg',
            songs: Array.from({ length: 25 }, (_, i) => ({
              id: 1000 + i, name: `曲目 ${i + 1}`,
              artists: [{ name: i % 2 ? '歌手B' : '歌手A' }],
            })),
          },
        };
      } else if (/fcg_v8_album_info_cp/.test(url)) {
        body = {
          code: 0,
          data: {
            name: 'QQ 自检专辑',
            list: [
              { songmid: '0039MnYb0qxYhV', songname: 'Q1', singer: [{ name: '甲' }] },
              { songmid: '004Z8Ihr0JIu5s', songname: 'Q2', singer: [{ name: '乙' }] },
              { songmid: '001OyHbk2MSIi4', songname: 'Q3', singer: [{ name: '丙' }] },
            ],
          },
        };
      } else if (/\/api\/v6\/playlist\/detail/.test(url)) {
        // 与真实接口同形：n=0 时 tracks 为空、trackIds 全量
        body = {
          code: 200,
          playlist: {
            name: '自检歌单',
            coverImgUrl: 'https://p1.music.126.net/playlist.jpg',
            trackCount: 25,
            trackIds: Array.from({ length: 25 }, (_, i) => ({ id: 2000 + i })),
            tracks: [],
          },
        };
      } else if (/\/api\/song\/detail/.test(url)) {
        // 故意**倒序**返回：端上必须按 trackIds 还原，不能直接用返回顺序
        const raw = decodeURIComponent(url);
        const ids = (/ids=\[([^\]]*)\]/.exec(raw)?.[1] || '').split(',').filter(Boolean).map(Number);
        body = {
          code: 200,
          songs: ids.slice().reverse().map((id) => ({
            id,
            name: `歌 ${id - 2000 + 1}`,
            ar: [{ name: id % 2 ? '歌手B' : '歌手A' }],
          })),
        };
      } else if (/musicu\.fcg/.test(url)) {
        // QQ 歌单：按 body 里的 song_begin 分页（与真实请求同一个字段）
        const rawBody = Buffer.from(payload.bodyBase64 || '', 'base64').toString('utf8');
        const begin = Number(/"song_begin":(\d+)/.exec(rawBody)?.[1] || 0);
        const all = Array.from({ length: 25 }, (_, i) => ({
          mid: `qqmid${String(i).padStart(9, '0')}`,
          name: `Q歌 ${i + 1}`,
          singer: [{ name: '甲' }],
        }));
        body = {
          req: {
            code: 0,
            data: {
              dirinfo: { title: 'QQ 自检歌单', songnum: 25, picurl: 'https://p1/cover.jpg' },
              songlist: all.slice(begin, begin + 100),
            },
          },
        };
      }
      const text = body ? JSON.stringify(body) : JSON.stringify({ code: -404 });
      return {
        ok: true,
        data: {
          status: body ? 200 : 404, url,
          headers: { 'content-type': 'application/json' },
          setCookie: [], bodyBase64: Buffer.from(text, 'utf8').toString('base64'),
          bytes: Buffer.byteLength(text),
        },
      };
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

/* ─────────────── 4. 标签写入探针（假 fs，验字段名与偏移） ─────────────── */

// 造一个「没有标签」的 mp3：写标签不需要解析音频帧，只要头部不是 ID3/fLaC 即可
const rawMp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(4096, 0x11)]);
staging.set('tag-probe.mp3', rawMp3);
const tagged = await engine.tagProbe('tag-probe.mp3', {
  title: '花海 (DJ 阿若版)', artist: '周杰伦', album: '魔杰座', year: '2008',
});
const tagBytes = staging.get('tag-probe.mp3');

// 再造一个「已有旧 ID3v2.3 标签（body 64 字节）」的文件：必须跳过旧标签而不是叠加
const oldTag = Buffer.alloc(74);
oldTag.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 64]);
const withOld = Buffer.concat([oldTag, rawMp3]);
staging.set('tag-probe-old.mp3', withOld);
const retagged = await engine.tagProbe('tag-probe-old.mp3', { title: '只改标题' });
const retagBytes = staging.get('tag-probe-old.mp3');

const tagProbeChecks = [
  ['tagProbe 识别格式 mp3', tagged.format, 'mp3'],
  ['tagProbe 无旧标签时 skip=0', tagged.skip, 0],
  ['tagProbe 报告的新增字节与实际一致', tagBytes.length - rawMp3.length, tagged.bytes],
  ['tagProbe 音频字节原样保留', tagBytes.subarray(tagBytes.length - rawMp3.length).equals(rawMp3), true],
  ['tagProbe 前缀是 ID3v2.3', tagBytes.subarray(0, 5).toString('latin1'), 'ID3\u0003\u0000'],
  ['tagProbe 旧标签被跳过（skip=74）', retagged.skip, 74],
  ['tagProbe 跳过旧标签后音频仍完整', retagBytes.subarray(retagBytes.length - rawMp3.length).equals(rawMp3), true],
  ['tagProbe 旧标签内容没被保留（文件变短）', retagBytes.length < withOld.length, true],
];

console.log('[selftest] 标签写入探针（假 fs）');
for (const [name, actual, expected] of tagProbeChecks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`}`);
  if (!ok) report.ok = false;
}

/* ─────────────── 5. 专辑分批（假 http，验 20 上限与翻批） ─────────────── */

// 25 首：第一批必须正好 20 首且 hasMore=true，第二批 5 首且 hasMore=false。
// 这条断言的意义在「口径」：端上若自己再写一个 20，或把 nextOffset 算成 0，
// 界面「加载下一批」会安静地重复第一批——用户在真机上只会看到重复曲目，不会看到报错。
const albumFirst = await engine.albumAny('https://music.163.com/#/album?id=8888');
const albumSecond = await engine.albumAny('https://music.163.com/#/album?id=8888', albumFirst.nextOffset);
const albumQQ = await engine.albumAny('https://y.qq.com/n/ryqq/albumDetail/002fRO0N4FftzY');
const albumUnsupported = await engine
  .albumAny('https://www.bilibili.com/video/BV1xx411c7mD')
  .then(() => 'resolved', (error) => String(error?.code || 'error'));

const albumChecks = [
  ['首批正好 20 首', albumFirst.tracks.length, 20],
  ['首批还有下一批', albumFirst.hasMore, true],
  ['首批 nextOffset=20', albumFirst.nextOffset, 20],
  ['专辑总曲目数如实上报', albumFirst.album.total, 25],
  ['首批剩余 5 首', albumFirst.dropped, 5],
  ['曲目 url 用桌面同款 /song?id=', albumFirst.tracks[0].url, 'https://music.163.com/song?id=1000'],
  ['曲目作者用 / 连接多歌手', albumFirst.tracks[0].author, '歌手A'],
  ['第二批 5 首', albumSecond.tracks.length, 5],
  ['第二批没有下一批', albumSecond.hasMore, false],
  ['第二批 nextOffset=25', albumSecond.nextOffset, 25],
  ['第二批从第 21 首开始', albumSecond.tracks[0].id, '1020'],
  ['QQ 专辑标题正确', albumQQ.album.title, 'QQ 自检专辑'],
  ['QQ 专辑曲目数正确', albumQQ.tracks.length, 3],
  ['QQ 曲目 url 指向 songDetail 页', albumQQ.tracks[0].url, 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV'],
  ['QQ 封面按 albummid 拼', albumQQ.album.cover,
    'https://y.qq.com/music/photo_new/T002R300x300M000002fRO0N4FftzY.jpg'],
  ['非音乐链接的专辑请求被如实拒绝', albumUnsupported, 'unsupported'],
];

console.log('[selftest] 专辑分批（假 http）');
for (const [name, actual, expected] of albumChecks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`}`);
  if (!ok) report.ok = false;
}

/* ─────────────── 6. 歌单（假 http，验 trackIds 还原与 kind 透传） ─────────────── */

// 与桌面端同一套口径：网易云走 trackIds + 分批 song/detail，QQ 走 musicu 分页。
// 这里最关键的断言是「曲目按 trackIds 顺序还原」——假 http 故意倒序返回。
const plNetease = await engine.albumAny('https://music.163.com/playlist?id=7777');
const plNeteaseSecond = await engine.albumAny('https://music.163.com/playlist?id=7777', plNetease.nextOffset);
const plQQ = await engine.albumAny('https://y.qq.com/n/ryqq/playlist/8888');
const plByKind = await engine.albumAny('9999', 0, 'playlist');

const playlistChecks = [
  ['网易云歌单 kind=playlist', plNetease.album.kind, 'playlist'],
  ['网易云歌单总数如实上报', plNetease.album.total, 25],
  ['网易云歌单首批 20 首', plNetease.tracks.length, 20],
  ['网易云歌单按 trackIds 顺序还原', plNetease.tracks[0].id, '2000'],
  ['网易云歌单第二批从第 21 首开始', plNeteaseSecond.tracks[0].id, '2020'],
  ['网易云歌单只剩 5 首', plNeteaseSecond.tracks.length, 5],
  ['QQ 歌单标题正确', plQQ.album.title, 'QQ 自检歌单'],
  ['QQ 歌单 kind=playlist', plQQ.album.kind, 'playlist'],
  ['QQ 歌单曲目数正确', plQQ.tracks.length, 20],
  ['QQ 歌单曲目 url 指向 songDetail 页', plQQ.tracks[0].url,
    'https://y.qq.com/n/ryqq/songDetail/qqmid000000000'],
  ['裸数字 + kind=playlist 走歌单', plByKind.album.kind, 'playlist'],
];

console.log('[selftest] 歌单（假 http）');
for (const [name, actual, expected] of playlistChecks) {
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
