import { AsyncLocalStorage } from 'node:async_hooks';

interface Operation {
  state: Map<symbol, unknown>;
  progress?: (written: number, total: number) => void;
  cancelled?: () => boolean;
}
const operations = new AsyncLocalStorage<Operation>();
export const currentOperation = () => operations.getStore();

/** HTTP 请求与下载任务分别创建作用域，避免异步 probe 改写另一任务的字幕、地址或取消回调。 */
export function runOperation<T>(work: () => T, callbacks: Omit<Operation, 'state'> = {}): T {
  return operations.run({ state: new Map(), ...callbacks }, work);
}

/** 引擎可直接被 CLI/测试调用；get 内部调用 probe 时复用当前任务，不再新开状态。 */
export function scopedOperation<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => currentOperation() ? fn(...args) : runOperation(() => fn(...args));
}

/** 每个引擎只声明状态工厂，实例随作用域释放，不保留“上一次媒体”的进程全局缓存。 */
export function operationState<T>(create: () => T): () => T {
  const key = Symbol();
  return () => {
    const scope = currentOperation();
    if (!scope) throw new Error('引擎状态需要 operation 作用域');
    if (!scope.state.has(key)) scope.state.set(key, create());
    return scope.state.get(key) as T;
  };
}
