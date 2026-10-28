/**
 * `node:fs` 的端上占位实现：**一律抛错，不做任何假装成功的降级**。
 *
 * 为什么不是「空实现」：这些是**同步** API，而端上的文件能力全在 Kotlin 桥后面，
 * 桥是异步的（reqId + 回投），同步 API 在 WebView 里无法桥接。
 * 如果 `existsSync` 恒返回 false、`mkdirSync` 静默 no-op，后果是：
 * 「已存在就跳过」静默失效（重复下载）、目录没建成但流程继续——比报错难查得多。
 *
 * 所以 M1-b（只做 probe）阶段，任何走到写盘的代码都会在这里得到明确报错；
 * M1-c 会把下载改成 `transfer.*`（原生流式写 staging `.part`），
 * 到那时这些函数**依然不该被调用**——真正的写盘不经过 JS 的 fs。
 */
function unsupported(name: string): never {
  const error = new Error(
    `端上没有同步 fs.${name}：文件能力在 Kotlin 桥后面且是异步的。`
    + `下载请走 transfer.*（原生流式写盘），不要在 JS 里直接读写文件。`,
  ) as Error & { code?: string };
  error.code = 'EUNSUPPORTED';
  throw error;
}

export function existsSync(..._args: unknown[]): boolean {
  return unsupported('existsSync');
}

export function statSync(..._args: unknown[]): never {
  return unsupported('statSync');
}

export function mkdirSync(..._args: unknown[]): never {
  return unsupported('mkdirSync');
}

export function renameSync(..._args: unknown[]): never {
  return unsupported('renameSync');
}

export function unlinkSync(..._args: unknown[]): never {
  return unsupported('unlinkSync');
}

export function writeFileSync(..._args: unknown[]): never {
  return unsupported('writeFileSync');
}

export function readFileSync(..._args: unknown[]): never {
  return unsupported('readFileSync');
}

export function readdirSync(..._args: unknown[]): never {
  return unsupported('readdirSync');
}
