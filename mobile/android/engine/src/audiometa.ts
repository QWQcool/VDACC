/**
 * 端上音频标签写入：mp3 走 ID3v2.3，flac 走 Vorbis comment（+ PICTURE）。
 *
 * 为什么端上要自己写：桌面端用 ffmpeg 打标签，Android 上没有 ffmpeg，
 * 而 M1 的验收要求「落 mp3/flac，标签与封面正确」。两条路可选：
 * 把 ffmpeg 塞进 APK（几十 MB，且与本项目「不打包 ffmpeg」的决策冲突），
 * 或者自己写标签——标签格式是**确定的字节布局**，写错了 `ffprobe` 一眼就能看出来，
 * 属于可验证的工程量，不是猜。
 *
 * 为什么两种格式各写一套：mp3 的 ID3v2 在文件头，替换掉旧的即可；
 * flac 是「fLaC + metadata 块链 + 音频帧」，标签是块链里的一两个块，
 * 必须保留 STREAMINFO（否则整个文件不再是合法 flac），只替换 4 号块（Vorbis comment）
 * 与 6 号块（PICTURE）。用同一段代码硬套两种格式只会写坏 flac。
 *
 * 纯函数、不碰桥：`buildMp3Tag()` / `buildFlacTag()` 只吃「文件头 + 元数据」，
 * 返回「新前缀 + 原文件该从哪个偏移开始接」。于是同一套断言可以在
 * `bun selftest.mjs`（无设备）和真机自检里各跑一遍。
 */

export type Cover = {
  mime: string;
  data: Uint8Array;
  width: number;
  height: number;
  /** 位深（jpeg 一般 24），写 PICTURE 块用；未知填 24。 */
  depth?: number;
};

export type AudioMeta = {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  comment?: string;
  cover?: Cover | null;
};

export type TagPlan = {
  /** 要写到文件开头的新字节（空表示不改文件）。 */
  prefix: Uint8Array;
  /** 原文件要跳过的开头字节数（旧标签长度）。 */
  skip: number;
  format: 'mp3' | 'flac' | 'm4a';
  /** 非空表示没写标签的原因——调用方要如实告诉用户，不能假装写过。 */
  note?: string;
};

/* ───────────────────────────── 小工具 ───────────────────────────── */

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function beUint32(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function beUint24(value: number): Uint8Array {
  return Uint8Array.of((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function leUint32(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/** ID3 的 size 是 syncsafe：每字节只用低 7 位。 */
function syncsafe(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f,
  );
}

function readSyncsafe(buf: Uint8Array, at: number): number {
  return ((buf[at] & 0x7f) << 21) | ((buf[at + 1] & 0x7f) << 14)
    | ((buf[at + 2] & 0x7f) << 7) | (buf[at + 3] & 0x7f);
}

function readBeUint32(buf: Uint8Array, at: number): number {
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** UTF-16LE（不带 BOM），ID3 的 encoding=1 由调用方补 BOM。 */
function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = (code >>> 8) & 0xff;
  }
  return out;
}

function isPureAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/* ───────────────────────────── mp3 / ID3v2.3 ───────────────────────────── */

function id3Frame(id: string, body: Uint8Array): Uint8Array {
  // v2.3 的帧长度是**普通大端**（v2.4 才是 syncsafe），写错会让解析器读到垃圾
  return concat([latin1(id), beUint32(body.length), Uint8Array.of(0, 0), body]);
}

/**
 * 文本帧：纯 ASCII 用 encoding=0（ISO-8859-1，兼容性最好），
 * 含中文一律 encoding=1（UTF-16 + BOM）——v2.3 规范没有 UTF-8，
 * 而 Android 自带播放器/MediaStore 对 UTF-16 的中文支持是稳的。
 */
function id3TextFrame(id: string, value: string | undefined): Uint8Array | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const body = isPureAscii(text)
    ? concat([Uint8Array.of(0), latin1(text)])
    : concat([Uint8Array.of(1), Uint8Array.of(0xff, 0xfe), utf16le(text)]);
  return id3Frame(id, body);
}

/** APIC：encoding=0 + mime\0 + 图片类型 3（正面封面）+ 空描述\0 + 图片数据。 */
function id3ApicFrame(cover: Cover): Uint8Array {
  return id3Frame('APIC', concat([
    Uint8Array.of(0),
    latin1(cover.mime), Uint8Array.of(0),
    Uint8Array.of(3),
    Uint8Array.of(0),
    cover.data,
  ]));
}

/** 旧 ID3v2 标签占多少字节（没有就是 0）。v2.4 的 footer 也要算进去。 */
export function existingId3Size(head: Uint8Array): number {
  if (head.length < 10) return 0;
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  const version = head[3];
  if (version < 2 || version > 4) return 0;
  const size = readSyncsafe(head, 6);
  const footer = version === 4 && (head[5] & 0x10) ? 10 : 0;
  return 10 + size + footer;
}

export function buildMp3Tag(head: Uint8Array, meta: AudioMeta): TagPlan {
  const skip = existingId3Size(head);
  const frames: Uint8Array[] = [];
  // 只写最简单的四个文本帧：COMM 的 body 是「语言 + 描述 + 文本」三段编码，
  // 为一条注释引入三段编码的歧义不值（桌面端才写 comment）
  for (const [id, value] of [
    ['TIT2', meta.title],
    ['TPE1', meta.artist],
    ['TALB', meta.album],
    ['TYER', meta.year],
  ] as Array<[string, string | undefined]>) {
    const frame = id3TextFrame(id, value);
    if (frame) frames.push(frame);
  }
  if (meta.cover && meta.cover.data.length) frames.push(id3ApicFrame(meta.cover));

  if (!frames.length) {
    return { prefix: new Uint8Array(0), skip: 0, format: 'mp3', note: '没有可写的标签字段' };
  }
  const body = concat(frames);
  const header = concat([latin1('ID3'), Uint8Array.of(3, 0, 0), syncsafe(body.length)]);
  return { prefix: concat([header, body]), skip, format: 'mp3' };
}

/* ───────────────────────────── flac / Vorbis comment ───────────────────────────── */

const FLAC_BLOCK_STREAMINFO = 0;
const FLAC_BLOCK_PADDING = 1;
const FLAC_BLOCK_VORBIS = 4;
const FLAC_BLOCK_PICTURE = 6;

type FlacBlock = { type: number; data: Uint8Array };

export type FlacChain = { blocks: FlacBlock[]; audioStart: number };

/**
 * 解析 flac 的 metadata 块链。返回 null 表示头部不完整（读到的字节不够覆盖整条链）。
 *
 * 为什么必须整条链都读到：音频帧的起点 = 链尾，偏移算错就会把音频头当成元数据、
 * 或者把元数据当音频（文件直接坏）。所以宁可「读不全就不写」。
 */
export function parseFlacChain(head: Uint8Array): FlacChain | null {
  if (head.length < 8) return null;
  if (head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43) return null;
  const blocks: FlacBlock[] = [];
  let pos = 4;
  while (pos + 4 <= head.length) {
    const flag = head[pos];
    const last = (flag & 0x80) !== 0;
    const type = flag & 0x7f;
    const len = (head[pos + 1] << 16) | (head[pos + 2] << 8) | head[pos + 3];
    const at = pos + 4;
    if (at + len > head.length) return null; // 读不全
    blocks.push({ type, data: head.subarray(at, at + len) });
    pos = at + len;
    if (last) return { blocks, audioStart: pos };
  }
  return null;
}

function flacVorbisComment(meta: AudioMeta): Uint8Array {
  const vendor = utf8('VDACC');
  const fields: string[] = [];
  const push = (key: string, value?: string) => {
    const text = (value ?? '').trim();
    if (text) fields.push(`${key}=${text}`);
  };
  push('TITLE', meta.title);
  push('ARTIST', meta.artist);
  push('ALBUM', meta.album);
  push('DATE', meta.year);
  push('COMMENT', meta.comment);

  const parts: Uint8Array[] = [leUint32(vendor.length), vendor, leUint32(fields.length)];
  for (const field of fields) {
    const bytes = utf8(field);
    parts.push(leUint32(bytes.length), bytes);
  }
  return concat(parts);
}

function flacPicture(cover: Cover): Uint8Array {
  const mime = utf8(cover.mime);
  return concat([
    beUint32(3),                 // 图片类型：正面封面
    beUint32(mime.length), mime,
    beUint32(0),                 // 空描述
    beUint32(cover.width & 0xffffffff),
    beUint32(cover.height & 0xffffffff),
    beUint32(cover.depth ?? 24),
    beUint32(0),                 // 调色板颜色数：非索引图填 0
    beUint32(cover.data.length), cover.data,
  ]);
}

export function buildFlacTag(head: Uint8Array, meta: AudioMeta): TagPlan {
  const chain = parseFlacChain(head);
  if (!chain) {
    return {
      prefix: new Uint8Array(0), skip: 0, format: 'flac',
      note: '读不全 flac 元数据块（可能已有超大封面），未写标签，音频仍完整',
    };
  }
  const streamInfo = chain.blocks.find((b) => b.type === FLAC_BLOCK_STREAMINFO);
  if (!streamInfo) {
    return {
      prefix: new Uint8Array(0), skip: 0, format: 'flac',
      note: 'flac 缺少 STREAMINFO 块（不是标准文件），未写标签',
    };
  }

  // 旧标签/旧封面/padding 全部丢弃后重建；其余块（SEEKTABLE/APPLICATION 等）原样保留
  const kept = chain.blocks.filter((b) => b.type !== FLAC_BLOCK_VORBIS
    && b.type !== FLAC_BLOCK_PICTURE && b.type !== FLAC_BLOCK_PADDING
    && b.type !== FLAC_BLOCK_STREAMINFO);

  const rebuilt: FlacBlock[] = [{ type: FLAC_BLOCK_STREAMINFO, data: streamInfo.data }];
  const hasMeta = !!(meta.title || meta.artist || meta.album || meta.year || meta.comment);
  if (hasMeta) rebuilt.push({ type: FLAC_BLOCK_VORBIS, data: flacVorbisComment(meta) });
  if (meta.cover && meta.cover.data.length) rebuilt.push({ type: FLAC_BLOCK_PICTURE, data: flacPicture(meta.cover) });
  rebuilt.push(...kept);

  if (!hasMeta && !meta.cover) {
    return { prefix: new Uint8Array(0), skip: 0, format: 'flac', note: '没有可写的标签字段' };
  }

  const parts: Uint8Array[] = [latin1('fLaC')];
  rebuilt.forEach((block, index) => {
    const last = index === rebuilt.length - 1 ? 0x80 : 0;
    parts.push(Uint8Array.of(last | block.type), beUint24(block.data.length), block.data);
  });
  return { prefix: concat(parts), skip: chain.audioStart, format: 'flac' };
}

/**
 * 按文件头自动选格式：flac 认 `fLaC` 魔数，其余按 mp3 处理。
 *
 * 为什么不信扩展名：网易云接口的 `type` 偶尔与真实文件不符（实测 128K/96K 会
 * 返回不同 URL 但字节完全相同，`type` 也只写了一种）。魔数比扩展名可靠。
 */
export function buildAudioTag(head: Uint8Array, meta: AudioMeta, extHint = ''): TagPlan {
  // m4a/mp4 的结构是「大小+类型」的 box 链，开头不是 ID3；往它前面塞 ID3 会直接毁掉文件。
  // 端上只实现 ID3v2 与 Vorbis comment，所以这里如实报告「没写」而不是硬写。
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    return {
      prefix: new Uint8Array(0),
      skip: 0,
      format: 'm4a',
      note: 'm4a 容器的标签暂不支持（端上只写 ID3v2 与 Vorbis comment），音频已保留',
    };
  }
  const isFlac = (head.length >= 4 && head[0] === 0x66 && head[1] === 0x4c
    && head[2] === 0x61 && head[3] === 0x43) || extHint.toLowerCase() === 'flac';
  return isFlac ? buildFlacTag(head, meta) : buildMp3Tag(head, meta);
}

/* ───────────────────────────── 封面尺寸（PICTURE 块必填） ───────────────────────────── */

/**
 * 从 jpeg / png 头部读宽高。
 *
 * 为什么必须读：flac 的 PICTURE 块要求 width/height，填 0 有些播放器（含 ffprobe）
 * 会认为块损坏。自己解析 SOF/IHDR 比引一个图像库划算——只需要两个数字。
 */
export function imageSize(data: Uint8Array): { mime: string; width: number; height: number } {
  // PNG：8 字节签名 + IHDR（宽高各 4 字节大端）
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { mime: 'image/png', width: readBeUint32(data, 16), height: readBeUint32(data, 20) };
  }
  // JPEG：扫段，SOF0..SOF15（跳过 0xC4/0xC8/0xCC 这三个非 SOF 标记）
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < data.length) {
      if (data[pos] !== 0xff) { pos += 1; continue; }
      const marker = data[pos + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
      const len = (data[pos + 2] << 8) | data[pos + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          mime: 'image/jpeg',
          height: (data[pos + 5] << 8) | data[pos + 6],
          width: (data[pos + 7] << 8) | data[pos + 8],
        };
      }
      if (len <= 0) break;
      pos += 2 + len;
    }
    return { mime: 'image/jpeg', width: 0, height: 0 };
  }
  return { mime: 'application/octet-stream', width: 0, height: 0 };
}
