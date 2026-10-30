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
import { readId3v2 } from '../../../../ts/src/core/tags';
import { previewDouyin, probeDouyin } from '../../../../ts/src/engines/douyin';
import { bytesToBase64, createHash, randomBytes } from '../shims/crypto';
import { md5Hex, toBytes, toHex } from '../shims/md5';
import { BridgeError, call, pendingBridgeCalls, setBridgeTransport } from '../shims/bridge';
import { bridgeFetchInstalled, installBridgeFetch } from '../shims/fetch';
import { cancelTransferById, startTransfer } from '../shims/transfer';
import {
  buildAudioTag, buildFlacTag, buildMp3Tag, existingId3Size, imageSize, parseFlacChain,
} from './audiometa';
import { downloadNetease, probeNetease } from './netease';
import {
  aggregateProgress, bucketOf, chooseFormat as chooseBilibiliFormat, countDanmaku,
  downloadBilibili, foldDash, parseContentRangeTotal, parseTarget, probeBilibili, srtTime, toSrt,
} from './bilibili';
import { downloadKuwo, probeKuwo, parseRid, toLrc } from './kuwo';
import { downloadKugou, probeKugou, parseHash } from './kugou';
import { downloadQQ, probeQQ, parseSongmid } from './qq';
import { readHead, rewriteStaged } from './staging';

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

/**
 * 标签写入的自检（纯函数，连设备都不需要）。
 *
 * 为什么值得占几条断言：端上没有 ffmpeg，标签是**我们自己拼字节**。
 * 拼错了在手机上只是「播放器显示不出来」，很难归因；这里用桌面端的
 * `readId3v2`（另一个独立解析器）把 mp3 标签反解回来对拍，
 * flac 则检查块链结构（STREAMINFO 必须在首位、音频起点 = 前缀长度）。
 */
function tagChecks(): Check[] {
  const checks: Check[] = [];
  const join = (...parts: Uint8Array[]) => {
    let size = 0;
    for (const part of parts) size += part.length;
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  };
  const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

  checks.push(check('existingId3Size 无标签返回 0', existingId3Size(new Uint8Array(32)), 0));

  // v2.3 空标签：header + 100 字节 body，占用 110 字节
  const oldTag = new Uint8Array(110);
  oldTag.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 100]);
  checks.push(check('existingId3Size 认出旧 ID3v2.3', existingId3Size(oldTag), 110));

  const cover = {
    mime: 'image/jpeg',
    data: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9),
    width: 600, height: 600, depth: 24,
  };
  const mp3 = buildMp3Tag(new Uint8Array(0), {
    title: '花海 (DJ 阿若版)', artist: '周杰伦', album: '魔杰座', year: '2008', cover,
  });
  const back = readId3v2(mp3.prefix);
  checks.push(check(
    'mp3 标签被桌面端解析器读回（含中文）',
    `${back.title}|${back.artist}|${back.album}`,
    '花海 (DJ 阿若版)|周杰伦|魔杰座',
  ));
  const declared = ((mp3.prefix[6] & 0x7f) << 21) | ((mp3.prefix[7] & 0x7f) << 14)
    | ((mp3.prefix[8] & 0x7f) << 7) | (mp3.prefix[9] & 0x7f);
  checks.push(check('mp3 标签长度与 syncsafe 头一致', declared + 10, mp3.prefix.length));
  checks.push(check('mp3 封面字节原样进 APIC', mp3.prefix.length > cover.data.length, true));
  checks.push(check('mp3 旧标签会被跳过而不是叠加', buildMp3Tag(oldTag, { title: 'x' }).skip, 110));

  // 假 flac：fLaC + STREAMINFO(34) + VORBIS_COMMENT(8) + 4 字节「音频」
  const flacHead = join(
    ascii('fLaC'),
    Uint8Array.of(0x00, 0, 0, 34), new Uint8Array(34),
    Uint8Array.of(0x84, 0, 0, 8), new Uint8Array(8),
    ascii('AUDI'),
  );
  const flac = buildFlacTag(flacHead, { title: '花海', artist: '周杰伦', album: '魔杰座', year: '2008', cover });
  const chain = parseFlacChain(flac.prefix);
  checks.push(check('flac 重建后块链可解析', chain !== null, true));
  checks.push(check('flac 首个块仍是 STREAMINFO', chain?.blocks[0]?.type ?? -1, 0));
  checks.push(check('flac 写入 VORBIS_COMMENT 块', chain ? chain.blocks.some((b) => b.type === 4) : false, true));
  checks.push(check('flac 写入 PICTURE 块', chain ? chain.blocks.some((b) => b.type === 6) : false, true));
  checks.push(check('flac 跳过原元数据链的长度', flac.skip, 4 + 4 + 34 + 4 + 8));
  checks.push(check('flac 新前缀正好接上音频帧', chain?.audioStart ?? -1, flac.prefix.length));
  const vorbis = chain?.blocks.find((b) => b.type === 4);
  const vorbisText = vorbis ? new TextDecoder('utf-8').decode(vorbis.data) : '';
  checks.push(check('flac 标签是 UTF-8 的 TITLE=', vorbisText.includes('TITLE=花海'), true));
  const picture = chain?.blocks.find((b) => b.type === 6);
  const pictureTail = picture ? [...picture.data.subarray(picture.data.length - 4)] : [];
  checks.push(check('flac 封面字节在 PICTURE 块尾部', pictureTail.join(','), [...cover.data.subarray(cover.data.length - 4)].join(',')));

  // PNG 头：签名 + IHDR，宽 600 / 高 800
  const png = new Uint8Array(26);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  png.set([0, 0, 0x02, 0x58, 0, 0, 0x03, 0x20], 16);
  const pngSize = imageSize(png);
  checks.push(check('imageSize 读出 PNG 宽高', `${pngSize.mime} ${pngSize.width}x${pngSize.height}`, 'image/png 600x800'));

  checks.push(check('buildAudioTag 按魔数选 flac', buildAudioTag(flacHead, { title: 'x' }).format, 'flac'));
  checks.push(check('buildAudioTag 非 flac 走 mp3', buildAudioTag(new Uint8Array(0), { title: 'x' }).format, 'mp3'));

  return checks;
}

/**
 * B站纯函数自检（M2）。
 *
 * 为什么这些值得进自检：DASH 折叠决定了「用户看到几个档位、点下去下的是哪条流」，
 * 折错了在真机上表现为「明明选了 1080P 却下到 720P」——这类错不会被下载本身暴露。
 * 断言用的 dash 是**手写的最小结构**（不是真实响应），所以还要有一次真机 probe 与桌面端
 * 逐档对比作为外部证据。
 */
function bilibiliChecks(): Check[] {
  const checks: Check[] = [];

  checks.push(check('bucketOf 1920 → 1080P', bucketOf(1920).join('|'), '1920|1080P'));
  checks.push(check('bucketOf 1080 → 480P（按宽度归档）', bucketOf(1080).join('|'), '854|480P'));

  const dash = {
    video: [
      { width: 1920, height: 1080, codecs: 'hev1.1.6', bandwidth: 3_000_000, baseUrl: 'v-hev' },
      { width: 1920, height: 1080, codecs: 'avc1.640028', bandwidth: 2_000_000, baseUrl: 'v-avc' },
      { width: 1280, height: 720, codecs: 'avc1.64001F', bandwidth: 1_000_000, baseUrl: 'v-720' },
      // 竖屏：宽度 720 落不到任何档位，label 必须用「宽×高」而不是「1280P」
      { width: 720, height: 1280, codecs: 'avc1.64001F', bandwidth: 900_000, baseUrl: 'v-portrait' },
    ],
    audio: [{ codecs: 'mp4a.40.2', bandwidth: 128_000, baseUrl: 'a-main' }],
  };
  const folded = foldDash(dash, 10_000);
  checks.push(check('foldDash 按宽度折成 3 档', folded.formats.map((f) => f.id).join(','),
    'bili-1920,bili-1280,bili-sd'));
  checks.push(check('foldDash 同档优先 avc', folded.formats[0].vcodec, 'avc1'));
  checks.push(check('foldDash 竖屏用宽×高当标签', folded.formats[2].label, '720×1280'));
  checks.push(check('foldDash 体积 = (视频+音频带宽)×秒/8', folded.formats[0].bytes, 2_660_000));
  checks.push(check('foldDash 推荐 1080P', folded.formats.find((f) => f.recommended)?.id, 'bili-1920'));
  checks.push(check('foldDash 地址表取到 avc 那条', folded.urls.get('bili-1920')?.video, 'v-avc'));
  checks.push(check('foldDash 音轨地址挂到每档', folded.urls.get('bili-1280')?.audio, 'a-main'));

  // 无声视频：没有 audio 时也要出档位（产物会是无声视频，由警告说明）
  const silent = foldDash({ video: dash.video, audio: [] }, 10_000);
  checks.push(check('foldDash 无音轨仍出档位', silent.formats.length, 3));
  checks.push(check('foldDash 无音轨时 audio 为空', silent.urls.get('bili-1920')?.audio, ''));

  checks.push(check('chooseFormat 命中显式档位', chooseBilibiliFormat(folded.formats, 'bili-1280').id, 'bili-1280'));
  checks.push(check('chooseFormat 缺省取 recommended', chooseBilibiliFormat(folded.formats, null).id, 'bili-1920'));
  let missingCode = 'ok';
  try {
    chooseBilibiliFormat(folded.formats, 'bili-4096');
  } catch (error) {
    missingCode = (error as { code?: string }).code || 'no_code';
  }
  checks.push(check('chooseFormat 缺档位报 no_stream（不静默换档）', missingCode, 'no_stream'));

  checks.push(check('srtTime 带毫秒与逗号', srtTime(3661.5), '01:01:01,500'));
  checks.push(check('srtTime 负数钳到 0', srtTime(-3), '00:00:00,000'));
  const srt = toSrt([{ from: 1, to: 2.5, content: '第一句' }, { from: 3, to: 4, content: '第二句\r' }]);
  checks.push(check('toSrt 序号与时间轴', srt.split('\n').slice(0, 3).join('|'),
    '1|00:00:01,000 --> 00:00:02,500|第一句'));
  checks.push(check('toSrt 去掉 \\r', srt.includes('\r'), false));

  checks.push(check('countDanmaku 数 <d 标签', countDanmaku('<d p="1">a</d><d p="2">b</d>'), 2));
  checks.push(check('parseContentRangeTotal 取总数', parseContentRangeTotal('bytes 0-0/21154992'), 21_154_992));
  checks.push(check('parseContentRangeTotal 畸形值返回 0', parseContentRangeTotal('bytes */'), 0));

  checks.push(check('aggregateProgress 用两轨总字节当分母',
    aggregateProgress(100, 50, 1000, 400).join('|'), '150|1000'));
  checks.push(check('aggregateProgress 没探到总量时退回单流',
    aggregateProgress(0, 50, 0, 400).join('|'), '50|400'));

  // 分P 与番剧：界面靠 `?p=` 选分P，靠 ep/ss 认番剧，认错就是下错集
  checks.push(check('parseTarget 认裸 BV', parseTarget('BV1SknF6KE5g').bvid, 'BV1SknF6KE5g'));
  checks.push(check('parseTarget 取 ?p=3', parseTarget('https://www.bilibili.com/video/BV1SknF6KE5g?p=3').page, 3));
  checks.push(check('parseTarget 认番剧 ep', parseTarget('https://www.bilibili.com/bangumi/play/ep12345').epId, '12345'));
  checks.push(check('parseTarget 认番剧 ss', parseTarget('https://www.bilibili.com/bangumi/play/ss678').seasonId, '678'));
  let badCode = 'ok';
  try {
    parseTarget('https://example.com/nothing');
  } catch (error) {
    badCode = (error as { code?: string }).code || 'no_code';
  }
  checks.push(check('parseTarget 认不出时报 bad_input', badCode, 'bad_input'));

  return checks;
}

/**
 * 音乐三平台的纯函数自检（M3）。
 *
 * 为什么先验解析：酷我是 rid、酷狗是 32 位 hash、QQ 是 14 位 mid，三者形态完全不同，
 * 而 `core/platform.ts` 只按域名路由。解析错了在真机上表现为「解析出别的歌」，
 * 比报错更难发现。
 */
function musicChecks(): Check[] {
  const checks: Check[] = [];

  checks.push(check('parseRid 认 play_detail', parseRid('https://www.kuwo.cn/play_detail/474678847'), '474678847'));
  checks.push(check('parseRid 认 MUSIC_ 前缀', parseRid('MUSIC_123456'), '123456'));
  checks.push(check('parseRid 认裸数字', parseRid('12345'), '12345'));
  checks.push(check('parseRid 别的站点返回空', parseRid('https://music.163.com/song?id=123456'), ''));

  const kgHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  checks.push(check('parseHash 认 #hash= 片段', parseHash(`https://www.kugou.com/song/#hash=${kgHash}`), kgHash));
  checks.push(check('parseHash 认裸 32 位 hex', parseHash(kgHash), kgHash));
  checks.push(check('parseHash 位数不足返回空', parseHash('https://www.kugou.com/song/#hash=abc'), ''));

  const mid = '0039MnYb0qxYhV';
  checks.push(check('parseSongmid 认 songDetail', parseSongmid(`https://y.qq.com/n/ryqq/songDetail/${mid}`), mid));
  checks.push(check('parseSongmid 认裸 mid', parseSongmid(mid), mid));
  // 任意站点都可能有 ?songmid=，跟着它猜平台会把别的链接当成 QQ 音乐
  checks.push(check('parseSongmid 非 QQ 域名返回空',
    parseSongmid(`https://example.com/?songmid=${mid}`), ''));

  checks.push(check('toLrc 秒 → [mm:ss.cc]', toLrc([{ time: 61.999, lineLyric: '你好' }]), '[01:02.00]你好'));
  checks.push(check('toLrc 空时间钳到 0', toLrc([{ time: 0, lineLyric: 'a' }]), '[00:00.00]a'));

  // m4a 不能塞 ID3：QQ 的 96K AAC / 酷狗的 m4a 档会走到这里，写坏就是整个文件打不开
  const m4aHead = new Uint8Array(16);
  m4aHead.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20], 0);
  const m4aPlan = buildAudioTag(m4aHead, { title: 'x' });
  checks.push(check('buildAudioTag 认 m4a 并拒绝写 ID3', m4aPlan.format, 'm4a'));
  checks.push(check('buildAudioTag m4a 不改文件（prefix 为空）', m4aPlan.prefix.length, 0));
  checks.push(check('buildAudioTag m4a 带原因说明', typeof m4aPlan.note === 'string' && m4aPlan.note.length > 0, true));

  return checks;
}

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

  // 标签写入（M1-e 网易云的前置）：端上没有 ffmpeg，字节是我们自己拼的
  checks.push(...tagChecks());

  // B站（M2）：DASH 折叠、档位选择、SRT、弹幕计数、两轨进度、Range 解析
  checks.push(...bilibiliChecks());

  // 音乐三平台（M3）：链接识别是「能不能下对曲」的第一道门，认错就是下错歌
  checks.push(...musicChecks());

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
    version: '0.1.0-m1e',
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
  /** 非致命问题（标签写失败、封面跳过…）：界面要显示出来，不能吞掉。 */
  warnings?: string[];
  /** 字幕行数（B站 `--subs`）：>0 才说明真的落了 .srt */
  srtCount?: number;
  /** 弹幕条数（B站 `--danmaku`） */
  danmakuCount?: number;
};

/** 附属产物开关：界面提交任务时带上（与桌面端 `/api/jobs` 的字段同名）。 */
export type SidecarOptions = { subs?: boolean; danmaku?: boolean; cover?: boolean };

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

/**
 * 按平台分发 probe：界面只给一段文本，由引擎自己决定走哪个引擎。
 *
 * 为什么不在 `local-api.js` 里判断平台：识别规则在 `core/platform.ts`，
 * 端上再抄一份就会出现「界面认成抖音、引擎认成网易云」的漂移——
 * 这种错在真机上表现为「解析出来的字段莫名其妙」，很难归因。
 */
/** 三家音乐平台分发（酷我/酷狗/QQ 的契约形状一致，差异在各自引擎里）。 */
type MusicPlatform = 'kuwo' | 'kugou' | 'qq';

async function probeMusic(target: string, platform: MusicPlatform) {
  if (platform === 'kuwo') return probeKuwo(target);
  if (platform === 'kugou') return probeKugou(target);
  return probeQQ(target);
}

async function downloadMusic(
  target: string,
  platform: MusicPlatform,
  formatId: string | null,
  hooks: DownloadHooks,
) {
  if (platform === 'kuwo') return downloadKuwo(target, formatId, hooks);
  if (platform === 'kugou') return downloadKugou(target, formatId, hooks);
  return downloadQQ(target, formatId, hooks);
}

export async function probeAny(text: string) {
  const target = firstUrl(text) || (text || '').trim();
  const platform = platformOf(target);
  if (platform === 'netease') {
    const started = Date.now();
    const result = await probeNetease(target);
    return { ...result, ms: Date.now() - started };
  }
  if (platform === 'bilibili') {
    const started = Date.now();
    const result = await probeBilibili(target);
    return { ...result, ms: Date.now() - started };
  }
  if (platform === 'kuwo' || platform === 'kugou' || platform === 'qq') {
    const started = Date.now();
    const result = await probeMusic(target, platform);
    return { ...result, ms: Date.now() - started };
  }
  if (platform === 'douyin') return probeShare(text);
  throw codedError('unsupported', `手机端暂不支持这个平台（识别为 ${platform}）：目前支持抖音、B站、网易云、酷我、酷狗、QQ 音乐`);
}

/** 下载也按平台分发；各引擎的返回形状一致，界面不需要知道差异。 */
export async function downloadAny(
  text: string,
  formatId: string | null = null,
  hooks: DownloadHooks = {},
  sidecars: SidecarOptions = {},
): Promise<DownloadResult> {
  const target = firstUrl(text) || (text || '').trim();
  const platform = platformOf(target);
  if (platform === 'netease') return downloadNetease(target, formatId, hooks);
  if (platform === 'bilibili') {
    return downloadBilibili(target, formatId, hooks, {
      subs: sidecars.subs,
      danmaku: sidecars.danmaku,
    });
  }
  if (platform === 'kuwo' || platform === 'kugou' || platform === 'qq') {
    return downloadMusic(target, platform, formatId, hooks);
  }
  if (platform === 'douyin') return downloadShare(text, formatId, hooks);
  throw codedError('unsupported', `手机端暂不支持这个平台（识别为 ${platform}）：目前支持抖音、B站、网易云、酷我、酷狗、QQ 音乐`);
}

/**
 * 标签写入的端到端探针：读暂存文件头 → 生成标签 → 重写文件。
 *
 * 为什么单独开门：`fs.readHead` / `fs.rewrite` 的**字段名与偏移**一旦和原生约定不一致，
 * 在真机上只表现为「标签没写进去」或「文件坏了」，从日志看不出是哪一边的问题。
 * 这条探针在 selftest 里跑一遍假桥（验字段形状），在真机上跑一遍真文件（验字节）。
 */
export async function tagProbe(name: string, meta: Parameters<typeof buildAudioTag>[1]) {
  const head = await readHead(name, 512 * 1024);
  const plan = buildAudioTag(head.bytes, meta);
  if (plan.note || !plan.prefix.length) {
    return { before: head.size, after: head.size, format: plan.format, skip: plan.skip, bytes: 0, note: plan.note || '没有可写的标签字段' };
  }
  const written = await rewriteStaged(name, plan.prefix, plan.skip);
  return { before: head.size, after: written.bytes, format: plan.format, skip: plan.skip, bytes: plan.prefix.length };
}

/**
 * 端到端标签探针：下载一个**已知格式**的文件（真机验证用 127.0.0.1 + `adb reverse`），
 * 写标签后 publish。
 *
 * 为什么需要它：匿名网易云只给 mp3（实测热歌榜整批 br=320000），所以「端上写 FLAC」在
 * 产品流程里暂时走不到；但 `audiometa` 的 flac 分支与桥的 `fs.rewrite` 必须被真机跑过一次，
 * 否则「桌面脚本验过」就成了唯一证据，而桥的偏移/字段名恰恰是桌面脚本验不到的部分。
 */
export async function tagFileProbe(
  url: string,
  name: string,
  meta: Parameters<typeof buildAudioTag>[1] = {},
  coverUrl = '',
) {
  const handle = await startTransfer({ url, name, publish: false });
  const staged = await handle.done;

  // 封面走真实网络（PICTURE 块的宽度/高度要靠真图解析，不能手填）
  let fullMeta = meta;
  if (coverUrl) {
    const res = await request(coverUrl, { headers: { Referer: 'https://music.163.com/' }, timeoutMs: 15000 });
    const data = new Uint8Array(await res.arrayBuffer());
    const size = imageSize(data);
    fullMeta = { ...meta, cover: { mime: size.mime, data, width: size.width, height: size.height, depth: 24 } };
  }

  const tag = await tagProbe(name, fullMeta);
  const published = await call<{ path: string; name: string; bytes: number }>(
    'fs.publish', { name }, { timeoutMs: 120_000 },
  );
  return { stagedBytes: staged.bytes, staged: staged.staged === true, ...tag, path: published.path };
}

/**
 * 「下载完成」通知（M4）。
 *
 * 为什么由 JS 触发：音乐与 B站 的完成时刻在 publish 之后（补标签/合并都在 JS 里），
 * 传输层过早报完成会误导。通知失败不影响下载结果，所以这里吞掉异常只返回 false。
 */
export async function notifyDone(name: string, path: string): Promise<boolean> {
  try {
    await call('ui.done', { name, path }, { timeoutMs: 8000 });
    return true;
  } catch {
    return false;
  }
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
  probeAny,
  downloadAny,
  probeNetease,
  downloadNetease,
  probeBilibili,
  downloadBilibili,
  probeKuwo,
  downloadKuwo,
  probeKugou,
  downloadKugou,
  probeQQ,
  downloadQQ,
  tagProbe,
  tagFileProbe,
  notifyDone,
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
  // 纯函数面：m0 验证页与后续排查会用
  foldDash,
  bucketOf,
  srtTime,
  toSrt,
  countDanmaku,
  parseContentRangeTotal,
  aggregateProgress,
};

(globalThis as unknown as { VDACC_ENGINE: typeof api }).VDACC_ENGINE = api;
