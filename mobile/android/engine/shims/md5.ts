/**
 * MD5（RFC 1321）纯 JS 实现，**同步**。
 *
 * 为什么不用桥：引擎里的 `createHash('md5')`（抖音签名 douyin.ts、酷狗签名 kugou.ts）
 * 是同步 API，而 `window.VDACC_BRIDGE` 的调用是异步的（设计稿 §5 的 reqId 协议）。
 * 同步接口没法等异步桥，所以 MD5 必须在 JS 侧算。
 *
 * 那桥上的 `crypto.md5Hex` 干什么：做**双向交叉校验**——同一输入两端摘要必须相等。
 * 这是 M0 里唯一能同时验证「JS 打包正确」和「Kotlin 桥接正确」的断言。
 *
 * 代价：约 2KB JS，远小于一次 base64 往返。SHA-1/256 端上不需要，不实现。
 */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(|sin(i+1)| * 2^32)，RFC 1321 定义的常量表。 */
const K = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  return table;
})();

export function md5Bytes(input: Uint8Array): Uint8Array {
  const len = input.length;
  // 补 0x80 + 8 字节长度，凑到 64 字节整数倍
  const total = (((len + 1 + 8 + 63) >> 6) << 6);
  const buf = new Uint8Array(total);
  buf.set(input);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  const bitLen = len * 8;
  view.setUint32(total - 8, bitLen >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + K[i] + m[g]) | 0;
      a = d;
      d = c;
      c = b;
      const shift = S[i];
      b = (b + ((f << shift) | (f >>> (32 - shift)))) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

export function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** 小写十六进制摘要，与 node:crypto `digest('hex')` 一致。 */
export function md5Hex(data: string | Uint8Array): string {
  return toHex(md5Bytes(toBytes(data)));
}
