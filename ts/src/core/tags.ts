/**
 * 读 ID3v2 标签（不依赖 ffprobe）。
 *
 * 为什么需要：酷我的 songinfo 接口会**偶发**返回 `status=301 音乐查询失败`
 * （连续请求时更容易触发；实测同一个 rid 半小时前失败、半小时后正常），
 * 此时标题只能退化成 `kuwo-<rid>`。
 * 但 CDN 给的 mp3 **自己带着 ID3**（实测 `TIT2=花海` / `TPE1=周杰伦`），
 * 那是文件自己的声明，比猜测可靠。
 *
 * 为什么不用 ffprobe：端上（Android）没有 ffmpeg；纯 JS 解析没有子进程开销，
 * 桌面与端上行为一致。只读头部若干字节，不整文件扫。
 */

export interface Id3Tags {
  title?: string;
  artist?: string;
  album?: string;
}

/** ID3v2 的 size 是 syncsafe：每字节只用低 7 位。 */
function syncsafe(buf: Uint8Array, at: number): number {
  return ((buf[at] & 0x7f) << 21) | ((buf[at + 1] & 0x7f) << 14)
    | ((buf[at + 2] & 0x7f) << 7) | (buf[at + 3] & 0x7f);
}

function beUint32(buf: Uint8Array, at: number): number {
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
}

function ascii(buf: Uint8Array, at: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i += 1) out += String.fromCharCode(buf[at + i]);
  return out;
}

/** 去掉文本帧尾部的 0 字节（编码不同，终止符宽度不同）。 */
function trimNul(text: string): string {
  return text.replace(/\u0000+$/g, '').replace(/\uFEFF/g, '').trim();
}

function decodeText(encoding: number, bytes: Uint8Array): string {
  if (encoding === 0) {
    // ISO-8859-1：逐字节映射，不用 TextDecoder（各环境对 'latin1' 命名不一致）
    let out = '';
    for (const b of bytes) out += String.fromCharCode(b);
    return trimNul(out);
  }
  if (encoding === 3) return trimNul(new TextDecoder('utf-8').decode(bytes));
  // 1 = UTF-16（带 BOM），2 = UTF-16BE（无 BOM）
  let little = encoding === 2 ? false : true;
  let start = 0;
  if (encoding === 1 && bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { little = true; start = 2; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { little = false; start = 2; }
  }
  let out = '';
  for (let i = start; i + 1 < bytes.length; i += 2) {
    const code = little ? (bytes[i] | (bytes[i + 1] << 8)) : ((bytes[i] << 8) | bytes[i + 1]);
    if (code === 0) continue;
    out += String.fromCharCode(code);
  }
  return trimNul(out);
}

/**
 * 解析 ID3v2.2/2.3/2.4 的文本帧。只取标题/歌手/专辑，不碰封面。
 * 解析不出来一律返回 `{}`——调用方据此保留原命名，不猜。
 */
export function readId3v2(buf: Uint8Array): Id3Tags {
  if (!buf || buf.length < 10) return {};
  // "ID3"
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return {};
  const version = buf[3];
  if (version < 2 || version > 4) return {};
  const flags = buf[5];
  const tagSize = syncsafe(buf, 6);
  const end = Math.min(buf.length, 10 + tagSize);
  let pos = 10;

  if (flags & 0x40) {
    // 扩展头：v2.3 的 size 不含自身 4 字节，v2.4 是 syncsafe 且含自身
    if (pos + 4 > end) return {};
    const extSize = version === 4 ? syncsafe(buf, pos) : beUint32(buf, pos) + 4;
    pos += Math.max(0, extSize);
  }

  const tag: Id3Tags = {};
  const map: Record<string, keyof Id3Tags> = {
    TIT2: 'title', TPE1: 'artist', TALB: 'album',
    TT2: 'title', TP1: 'artist', TAL: 'album',
  };

  while (pos < end) {
    const headerLen = version === 2 ? 6 : 10;
    if (pos + headerLen > end) break;
    const id = version === 2 ? ascii(buf, pos, 3) : ascii(buf, pos, 4);
    // 空帧（padding 区）直接结束
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const size = version === 2
      ? ((buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5])
      : version === 4 ? syncsafe(buf, pos + 4) : beUint32(buf, pos + 4);
    const bodyAt = pos + headerLen;
    if (size <= 0 || bodyAt + size > end) break;

    const key = map[id];
    if (key && !tag[key]) {
      const encoding = buf[bodyAt];
      const text = decodeText(encoding, buf.subarray(bodyAt + 1, bodyAt + size));
      if (text) tag[key] = text;
    }
    pos = bodyAt + size;
  }

  return tag;
}
