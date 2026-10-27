/**
 * `node:crypto` 的浏览器侧替身。**只支持 md5**，其余算法显式报错。
 *
 * 为什么只做 md5：端上引擎只有抖音/酷狗签名要 md5；SHA-256 只出现在
 * 桌面端的组件校验与 doctor（不移植）。少实现一种算法，就少一处
 * 「以为算了其实算错」的风险。
 *
 * randomBytes / randomUUID 走 WebCrypto（WebView 与 Bun 都有），不经过桥：
 * 随机数不需要原生参与，跨进程反而更慢。
 */
import { md5Bytes, toBytes, toHex } from './md5';

type Encoding = 'hex' | 'base64';

export function createHash(algorithm: string) {
  const alg = (algorithm || '').toLowerCase();
  if (alg !== 'md5') {
    throw new Error(`mobile shim: 不支持的摘要算法 ${algorithm}（端上只实现了 md5）`);
  }
  const chunks: Uint8Array[] = [];
  const hash = {
    update(data: string | Uint8Array) {
      chunks.push(toBytes(data));
      return hash;
    },
    digest(encoding: Encoding = 'hex'): string {
      let size = 0;
      for (const c of chunks) size += c.length;
      const all = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      const out = md5Bytes(all);
      if (encoding === 'hex') return toHex(out);
      if (encoding === 'base64') return bytesToBase64(out);
      throw new Error(`mobile shim: 不支持的编码 ${encoding}`);
    },
  };
  return hash;
}

export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  getRandomValues(out);
  return out;
}

/** 只声明用到的两个成员，避免 shim 依赖 lib.dom 的类型定义。 */
type CryptoLike = {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
  randomUUID?: () => string;
};

/** 直接复用 WebCrypto 的 v4 实现；没有的话按 RFC 4122 自己拼。 */
export function randomUUID(): string {
  if (cryptoOf()?.randomUUID) return cryptoOf()!.randomUUID!();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = toHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getRandomValues(out: Uint8Array): void {
  const api = cryptoOf();
  if (!api?.getRandomValues) {
    throw new Error('mobile shim: 当前环境没有 WebCrypto，无法生成随机数');
  }
  api.getRandomValues(out);
}

function cryptoOf(): CryptoLike | undefined {
  return (globalThis as unknown as { crypto?: CryptoLike }).crypto;
}

/** 小工具，桥的 chunk 协议与 md5 的 base64 编码共用。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000; // 分块，避免 apply 参数过多爆栈
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const cryptoShim = { createHash, randomBytes, randomUUID };
export default cryptoShim;
