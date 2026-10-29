/**
 * 暂存区（staging）读写原语：`fs.readHead` / `fs.rewrite` / 小文本落盘。
 *
 * 为什么单独一层：下载本身走 `transfer.*`（原生流式写 `.part`），但**改文件开头**
 * 与**写附属小文件**不是下载。把它们收在这个文件里，引擎代码就不用关心
 * base64 与分块协议——协议细节只出现在这里和 Kotlin 侧。
 *
 * 边界：这里只能操作 staging 里的 `<name>.part`，路径由原生按纯文件名拼，
 * 不接受任何带分隔符的名字（原生侧 `safeName` 会拒）。
 */
import { call } from '../shims/bridge';
import { base64ToBytes, bytesToBase64 } from '../shims/crypto';

export type HeadResult = {
  /** 读到的头部字节（最多请求的字节数）。 */
  bytes: Uint8Array;
  /** 文件总大小。 */
  size: number;
  /** 文件比读到的多（说明读完这一截还没到 EOF）。 */
  truncated: boolean;
};

/** 读暂存文件开头。原生上限 4MB，超了会截断并置 `truncated`。 */
export async function readHead(name: string, bytes = 64 * 1024): Promise<HeadResult> {
  const reply = await call<{ size: number; bytes: number; base64: string; truncated: boolean }>(
    'fs.readHead',
    { name, bytes },
    { timeoutMs: 20_000 },
  );
  return {
    bytes: base64ToBytes(reply.base64 || ''),
    size: reply.size ?? 0,
    truncated: !!reply.truncated,
  };
}

/**
 * 用「新前缀 + 原文件 [skip, EOF)」替换暂存文件。
 *
 * 调用方负责算 `skip`：mp3 是旧 ID3v2 标签长度（没有就是 0），
 * flac 是原 metadata 块链长度。算错会让文件损坏，所以拒绝是不可能的——
 * 只能靠上层用「读头 + 解析」算准，这也是 audiometa 存在的理由。
 */
export async function rewriteStaged(
  name: string,
  prefix: Uint8Array,
  skip: number,
): Promise<{ bytes: number; prefixBytes: number }> {
  return call<{ bytes: number; prefixBytes: number }>(
    'fs.rewrite',
    { name, base64: bytesToBase64(prefix), skip },
    // 大文件要按 64KB 拷一遍（4MB 的 flac 约 1 秒），别用 15s 默认值把人卡在边界上
    { timeoutMs: 120_000 },
  );
}

/**
 * 写一个小的文本附属文件（歌词 `.lrc` 等）并直接 publish 到公共目录。
 *
 * 为什么复刻 openWrite/writeChunk/closeWrite：M0 已经用这条路径验证过真机落盘，
 * 这里不引入第二条写盘路径——**只有一条路会被测到**，多一条就多一条没人走的路。
 */
export async function writeTextAndPublish(
  name: string,
  text: string,
  chunkSize = 16 * 1024,
): Promise<{ path: string; bytes: number }> {
  const data = new TextEncoder().encode(text);
  const opened = await call<{ handle: string }>('fs.openWrite', { name });
  try {
    for (let at = 0; at < data.length; at += chunkSize) {
      const slice = data.subarray(at, Math.min(at + chunkSize, data.length));
      await call('fs.writeChunk', { handle: opened.handle, base64: bytesToBase64(slice) });
    }
  } finally {
    await call('fs.closeWrite', { handle: opened.handle }).catch(() => null);
  }
  const published = await call<{ path: string; bytes: number }>('fs.publish', { name });
  return { path: published.path, bytes: published.bytes };
}
