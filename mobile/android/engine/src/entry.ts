/**
 * 端上引擎入口（M0）。被 `mobile/android/engine/build.mjs` 打成单个 IIFE，
 * 以 `globalThis.VDACC_ENGINE` 挂到 WebView 页面上。
 *
 * 设计原则：
 * 1. **不复制引擎**。命名/路由/限速/落盘规则一律 import 桌面端 `ts/src/core/*`，
 *    两端漂移的风险交给「同一份源码」而不是「两边小心点」。
 * 2. **不碰 Node 桌面专属**。http/ffmpeg/auth/doctor/storage 不进来；
 *    M0 只验「纯函数 + 桥」这条链路能不能在端上跑通。
 * 3. 页面上能看到的数字必须是**算出来的**，不是写死的：自检失败就如实红。
 */
import { safeName } from '../../../../ts/src/core/naming';
import { firstUrl, platformOf } from '../../../../ts/src/core/platform';
import { currentLimitBytesPerSec, parseLimit, setLimitBytesPerSec } from '../../../../ts/src/core/rate';
import { activeDestCount, releaseDest, reserveDest } from '../../../../ts/src/core/dest';
import { CookieJar, request } from '../../../../ts/src/core/http';
import { runOperation } from '../../../../ts/src/core/operation';
import { previewDouyin, probeDouyin } from '../../../../ts/src/engines/douyin';
import { bytesToBase64, createHash, randomBytes } from '../shims/crypto';
import { md5Hex, toBytes, toHex } from '../shims/md5';
import { BridgeError, call, pendingBridgeCalls, setBridgeTransport } from '../shims/bridge';
import { bridgeFetchInstalled, installBridgeFetch } from '../shims/fetch';
import { cancelTransferById, startTransfer } from '../shims/transfer';

/**
 * 页面一加载就把 `fetch` 换成走原生的实现。
 * 必须在任何引擎代码发起请求之前执行——放在模块顶层最稳（入口只会被加载一次）。
 * 桥不存在时（例如 `bun selftest.mjs`）这里是空操作，不影响纯函数自检。
 */
const FETCH_BRIDGED = installBridgeFetch();

export { setBridgeTransport, pendingBridgeCalls, BridgeError };
export { safeName, firstUrl, platformOf, parseLimit, currentLimitBytesPerSec, setLimitBytesPerSec };
export { md5Hex };

export type Check = {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
  /** 失败时给人看的原因（成功时留空）。 */
  note?: string;
};

export type SelfTestReport = {
  ok: boolean;
  passed: number;
  total: number;
  checks: Check[];
  /** 桥是否可用；不可用时只有纯函数断言。 */
  bridge: boolean;
};

/** M0 的 golden 值全部由桌面端引擎实算得出（2026-10-27 用 bun 跑出来），不是手编的。 */
const GOLDEN = {
  safeNameMixed: '你好 _ 世界_.mp4',
  safeNameEmpty: 'media',
  urlFromText: 'https://v.douyin.com/abc123/',
  md5Vdacc: '6a6195763bd4605b39fe3f7606165d9b',
  md5Chinese: '653438b29823075c5a903c8c84853f8a',
};

function check(name: string, actual: unknown, expected: unknown, note?: string): Check {
  const a = stringify(actual);
  const e = stringify(expected);
  return { name, ok: a === e, expected: e, actual: a, ...(a === e || !note ? {} : { note }) };
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  return JSON.stringify(value);
}

/**
 * 自检：纯函数 11 条 + 桥 1 条。
 * 纯函数部分不需要设备也能跑（`bun selftest.mjs`），这是「打包对不对」的判据；
 * 桥的部分只有真机才有，用来判「原生接得对不对」。
 */
export async function selfTest(): Promise<SelfTestReport> {
  const checks: Check[] = [];

  checks.push(check('safeName 清非法字符', safeName('  你好 / 世界?.mp4  '), GOLDEN.safeNameMixed));
  checks.push(check('safeName 空串兜底', safeName('   '), GOLDEN.safeNameEmpty));
  checks.push(check('firstUrl 从分享文案抽链接', firstUrl('复制打开抖音 https://v.douyin.com/abc123/ 看看'), GOLDEN.urlFromText));
  checks.push(check('firstUrl 裸 ID 无链接', firstUrl('7698929587975146788'), ''));
  checks.push(check('platformOf 抖音裸 ID', platformOf('7698929587975146788'), 'douyin'));
  checks.push(check('platformOf 网易云域名', platformOf('https://music.163.com/song?id=123'), 'netease'));
  checks.push(check('platformOf B站短链', platformOf('复制此链接 https://b23.tv/xyz 打开'), 'bilibili'));
  checks.push(check('platformOf 未知输入不猜', platformOf('https://example.com/x'), 'unsupported'));
  checks.push(check('parseLimit 1.5M', parseLimit('1.5M'), 1572864));
  checks.push(check('parseLimit 非法返回 null', parseLimit('abc'), null));

  // dest 的分隔符随平台（端上是 POSIX），所以只断言「文件名 + 并发预留后缀」这条契约
  const first = reserveDest('/download', 'a.mp4');
  const second = reserveDest('/download', 'a.mp4');
  releaseDest(first);
  releaseDest(second);
  checks.push(check('reserveDest 并发加后缀', second.endsWith('a (2).mp4'), true));
  checks.push(check('reserveDest 结束后无残留', activeDestCount(), 0));

  checks.push(check('md5 纯 JS（ASCII）', md5Hex('vdacc'), GOLDEN.md5Vdacc));
  checks.push(check('md5 纯 JS（UTF-8 中文）', md5Hex('你好，VDACC'), GOLDEN.md5Chinese));

  // 桥交叉校验：JS 侧 md5 与原生 MessageDigest 必须一致，否则签名类引擎在端上必错
  let bridgeOk = true;
  try {
    const native = await call<string>('crypto.md5Hex', { text: '你好，VDACC' }, { timeoutMs: 5000 });
    checks.push(check('桥 crypto.md5Hex 与 JS 一致', native, GOLDEN.md5Chinese, '原生 MessageDigest 结果不同'));
  } catch (error) {
    bridgeOk = false;
    const reason = error instanceof Error ? error.message : String(error);
    checks.push({ name: '桥 crypto.md5Hex 可用', ok: false, expected: '可用', actual: '不可用', note: reason });
  }

  const passed = checks.filter((c) => c.ok).length;
  return { ok: passed === checks.length, passed, total: checks.length, checks, bridge: bridgeOk };
}

export type PathsInfo = {
  /** 用户可见的输出位置（Android 10+ 是 MediaStore 里的 Download/VDACC，不是可直接 File 写的路径）。 */
  out: string;
  /** 写入方式：mediastore / file —— 页面上要如实显示，避免让人以为 out 一定能 File 打开。 */
  outKind: string;
  /** 私有暂存目录（.part 落这里，M1 的续传依赖它）。 */
  staging: string;
  cache: string;
};

export function paths(): Promise<PathsInfo> {
  return call<PathsInfo>('paths');
}

export type ProbeResult = {
  /** 用户可见位置（`Download/VDACC/xxx`）：Android 10+ 这是 MediaStore 里的条目名，不是能 File 打开的路径。 */
  path: string;
  /** 私有暂存路径：证明「先写 .part 再 publish」两段式真的走了。 */
  stagingPath: string;
  bytes: number;
  chunks: number;
  md5: string;
  text: string;
  outKind: string;
};

/**
 * M0 的落盘探针：openWrite → writeChunk(16KB×N) → closeWrite → publish → stat。
 *
 * 为什么非要分块：M1 的下载器就是按块写的，如果 M0 用「一次写整串」，
 * 分块路径在真机上就是第一次运行——M0 的意义就是把这条路径提前跑通。
 * 为什么要 publish：Android 10+ 不能直接 File 写公共下载目录，这一段没有替代方案；
 * M0 不通它，M1 的「下载/VDACC 里能看到文件」就是未验证的。
 */
export async function writeProbe(text?: string): Promise<ProbeResult> {
  // 默认内容刻意做到 ~40KB（>2 个 chunk）：M0 要验证的是**分块**这条路，
  // 只写 141 字节等于「一次写完」，chunk 顺序与句柄生命周期都没被跑到。
  // 前四行是人看的说明，后面是填充行，保证每次都能拆成 3 块。
  const head = [
    'VDACC Android M0 probe',
    `engine=${engineInfo().version}`,
    `builtAt=${new Date().toISOString()}`,
    '这条内容是 JS 引擎算出来后经 Kotlin 桥分块写盘的。',
  ].join('\n');
  const padding = Array.from({ length: 900 }, (_, i) => `padding line ${i} - 用于把探针撑到多个 16KB 分块`).join('\n');
  const body = text ?? `${head}\n${padding}`;
  const bytes = toBytes(body);
  const chunkSize = 16 * 1024;
  const name = 'm0-probe.txt';

  // 注意：openWrite 返回的是对象（{handle, stagingPath}），不是 handle 字符串。
  // 直接把它当 handle 用会让原生侧收到一个对象，报 EBADHANDLE —— 真机上踩过一次。
  const opened = await call<{ handle: string; stagingPath: string }>('fs.openWrite', { name });
  const handle = opened.handle;
  let written = 0;
  let chunks = 0;
  let stagingPath = opened.stagingPath || '';
  try {
    for (let at = 0; at < bytes.length; at += chunkSize) {
      const slice = bytes.subarray(at, Math.min(at + chunkSize, bytes.length));
      const res = await call<{ bytes: number }>('fs.writeChunk', { handle, base64: bytesToBase64(slice) });
      written += res.bytes;
      chunks += 1;
    }
  } finally {
    // 出错也要关句柄，否则原生侧会一直占着输出流
    const closed = await call<{ bytes: number; path: string }>('fs.closeWrite', { handle }).catch(() => null);
    if (closed) {
      written = closed.bytes;
      stagingPath = closed.path || stagingPath;
    }
  }

  // 第二段：把 .part 落进用户可见的 Download/VDACC（失败必须抛出，不能报「成功」）
  const published = await call<{ path: string; name: string; outKind: string; bytes: number }>('fs.publish', { name });

  // 再 stat 一次：publish 只证明「我调用了」，stat 才证明「文件真的在」
  const stat = await call<{ size: number; path: string }>('fs.stat', { name }).catch(() => null);
  return {
    path: stat?.path || published.path,
    stagingPath,
    bytes: stat?.size ?? published.bytes ?? written,
    chunks,
    md5: md5Hex(body),
    text: body,
    outKind: published.outKind,
  };
}

/** 引擎自述：页面上直接显示，防止「看起来在跑其实是旧包」。 */
export function engineInfo() {
  return {
    version: '0.1.0-m1a',
    builtAt: typeof BUILD_STAMP === 'string' ? BUILD_STAMP : 'unknown',
    randomProbe: toHex(randomBytes(4)),
    md5Available: typeof createHash === 'function',
    fetchBridged: bridgeFetchInstalled(),
  };
}

export type NetProbeResult = {
  /** 抖音 ttwid 注册接口的 HTTP 状态码。 */
  status: number;
  /** 有没有从 Set-Cookie 里真的拿到 ttwid——这一步同时验证了 CookieJar 与多值 Set-Cookie。 */
  ttwid: boolean;
  bytes: number;
  ms: number;
  bridged: boolean;
};

/**
 * M1-a 的验收探针：用**引擎自己的 `core/http.request`**（不是手写 fetch）请求抖音，
 * 走完整链路：JS → 桥 → HttpURLConnection → 抖音 → Set-Cookie 回收到 CookieJar。
 *
 * 为什么选 ttwid：抖音的详情接口必须先有这个 cookie，拿不到它后面全免谈；
 * 而且它是 POST + JSON body + Set-Cookie，一次覆盖三种能力。
 */
export async function netProbe(): Promise<NetProbeResult> {
  const jar = new CookieJar();
  const started = Date.now();
  const res = await request('https://www.douyin.com/ttwid/register', {
    method: 'POST',
    jar,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
    },
    body: JSON.stringify({ aid: 6383, service: 'www.douyin.com' }),
    timeoutMs: 15000,
  });
  const text = await res.text();
  return {
    status: res.status,
    ttwid: !!jar.get('ttwid'),
    bytes: text.length,
    ms: Date.now() - started,
    bridged: bridgeFetchInstalled(),
  };
}

declare const BUILD_STAMP: string | undefined;

/**
 * M1-b 验收：把**整段分享文案**喂给抖音引擎，拿回标题/封面/档位。
 *
 * 这一步只证明「引擎在端上跑得起来、网络桥够用」——不下载、不落盘。
 * 返回的就是桌面端同一份 `ProbeResult`，不做裁剪：字段少一个，界面就会少一个信息，
 * 而且两端契约一旦分叉，后面 M1-d 接 Vue 时还要再对一次。
 */
export async function probeShare(text: string) {
  const started = Date.now();
  const result = await probeDouyin(text);
  return { ...result, ms: Date.now() - started };
}

export type DownloadResult = {
  path: string;
  bytes: number;
  name: string;
  label: string;
  resumeFrom: number;
  ms: number;
};

export type DownloadHooks = {
  onProgress?: (bytes: number, total: number) => void;
  onReady?: (jobId: string, resumeFrom: number) => void;
};

function codedError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`) as Error & { code?: string };
  error.code = code;
  return error;
}

/**
 * M1-c 的下载：probe → 取直链 → 原生流式下载 → publish 到 Download/VDACC。
 *
 * 两个必须知道的点：
 * 1. **直链与 probe 必须在同一个 operation 作用域里取**。抖音的播放地址带 vkey，
 *    引擎把它缓存在 `operationState` 里；`probeDouyin` 是 scopedOperation，单独调用
 *    结束后缓存就没了，`previewDouyin` 会拿到空串。
 * 2. **文件名沿用桌面规则**：`<id>_<safeName(title)>_<safeName(label)>.mp4`，
 *    这样同一链接在两端落盘名一致（M1-d 接界面时不用再对一次）。
 */
export async function downloadShare(
  text: string,
  formatId: string | null = null,
  hooks: DownloadHooks = {},
): Promise<DownloadResult> {
  const started = Date.now();
  let direct = '';
  let name = '';
  let label = '';

  await runOperation(async () => {
    const probe = await probeDouyin(text);
    // 显式点名了档位就必须命中：静默换档会让用户以为下到了 1080P（与桌面端同一条规矩）
    let picked = probe.formats.find((f) => f.recommended) || probe.formats[0];
    if (formatId) {
      picked = probe.formats.find((f) => f.id === formatId);
      if (!picked) {
        const usable = probe.formats.map((f) => f.id).join('、') || '无';
        throw codedError('no_stream', `这个视频没有 ${formatId} 档（可用：${usable}）`);
      }
    }
    if (!picked) throw codedError('no_stream', '这个视频没有可用档位');
    label = picked.label;
    direct = previewDouyin(picked.id);
    name = `${probe.media!.id}_${safeName(probe.media!.title)}`
      + `_${safeName(picked.label, 16, picked.id)}.mp4`;
  });

  if (!direct) throw codedError('no_stream', `档位 ${label} 没有拿到直链（可能已过期，重试一次）`);

  const handle = await startTransfer({
    url: direct,
    name,
    referer: 'https://www.douyin.com/',
    onProgress: hooks.onProgress,
  });
  hooks.onReady?.(handle.jobId, handle.resumeFrom);

  const out = await handle.done;
  return { ...out, label, resumeFrom: handle.resumeFrom, ms: Date.now() - started };
}

/** 取消正在进行的下载；`.part` 会保留，下次同一个文件名就是续传。 */
export async function cancelTransfer(jobId: string): Promise<boolean> {
  return cancelTransferById(jobId);
}

/**
 * 取消能力的确定性验证：拿一个**大文件**（默认 50MB 测速端点）下 800ms 然后取消。
 * 为什么不用抖音视频来验：5.6MB 的片子在本机 wifi 下 1 秒内就完了，
 * 手点/脚本都撞不准时机——用大文件才能稳定证明「取消真的停住了，且已写部分保留」。
 */
export async function cancelProbe(
  url = 'https://proof.ovh.net/files/100Mb.dat',
  afterMs = 800,
): Promise<{ cancelled: boolean; outcome: string; bytes: number; total: number; ms: number }> {
  const started = Date.now();
  let bytes = 0;
  let total = 0;
  const handle = await startTransfer({
    url,
    name: 'cancel-probe.bin',
    referer: '',
    onProgress: (now, all) => { bytes = now; total = all; },
  });
  await new Promise((resolve) => setTimeout(resolve, afterMs));
  const atCancel = bytes;
  const cancelled = await handle.cancel();
  let outcome = 'unknown';
  try {
    await handle.done;
    outcome = 'done（没停住！）';
  } catch (error) {
    outcome = (error as { code?: string })?.code || 'error';
  }
  return { cancelled, outcome, bytes: atCancel, total, ms: Date.now() - started };
}

/**
 * 前台服务/锁屏的验证用：下一个**大文件**（默认 500MB 测速端点）。
 * 为什么需要它：抖音视频 5.6MB 在本机两秒就完了，根本撑不到「锁屏 30 秒」。
 * 500MB 约 20 秒，足够在下载途中熄屏、等半分钟再亮屏看结果。
 */
export type TransferProbeOptions = DownloadHooks & {
  url?: string;
  name?: string;
  /** 字节/秒；限速能让一个 100MB 文件撑到足够长，便于测「锁屏 30 秒」 */
  limitBytesPerSec?: number;
};

export async function transferProbe(options: TransferProbeOptions = {}): Promise<DownloadResult> {
  const started = Date.now();
  const url = options.url ?? 'https://proof.ovh.net/files/100Mb.dat';
  const name = options.name ?? 'speed-probe.bin';
  const handle = await startTransfer({
    url,
    name,
    referer: '',
    limitBytesPerSec: options.limitBytesPerSec ?? 0,
    onProgress: options.onProgress,
  });
  options.onReady?.(handle.jobId, handle.resumeFrom);
  const out = await handle.done;
  return { ...out, label: name, resumeFrom: handle.resumeFrom, ms: Date.now() - started };
}

const api = {
  engineInfo,
  selfTest,
  paths,
  writeProbe,
  netProbe,
  probeShare,
  downloadShare,
  cancelTransfer,
  cancelProbe,
  transferProbe,
  setBridgeTransport,
  pendingBridgeCalls,
  // 纯函数面，M1 的 local-api.js 会直接调这些
  safeName,
  firstUrl,
  platformOf,
  parseLimit,
  reserveDest,
  releaseDest,
  md5Hex,
};

(globalThis as unknown as { VDACC_ENGINE: typeof api }).VDACC_ENGINE = api;
