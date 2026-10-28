/**
 * `node:fs/promises` 的端上占位实现：同样一律抛错。
 *
 * 引擎里 `open()` 用来按块写下载文件（`streamTo`）。端上这块改为原生流式写盘
 * （桥的 `transfer.*`，Kotlin 侧直接写 staging 的 `.part`），JS 不持有文件句柄。
 * 在此之前任何调用都应立刻暴露，而不是产生一个「文件只写了一半却报成功」的结果。
 */
export async function open(..._args: unknown[]): Promise<never> {
  const error = new Error(
    '端上没有 fs/promises.open：下载走 transfer.*（原生流式写盘），JS 不持有文件句柄。',
  ) as Error & { code?: string };
  error.code = 'EUNSUPPORTED';
  throw error;
}
