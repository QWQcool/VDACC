/**
 * `node:async_hooks` 的端上近似实现。
 *
 * 引擎用 `AsyncLocalStorage` 表达「一次 probe/download 的状态作用域」
 * （`core/operation.ts` 的字幕、地址缓存、取消回调都挂在上面）。
 * 端上没有 async_hooks，也不该有——我们只有一条 JS 线程。
 *
 * 实现方式与限制（**必须知道**）：
 * - 用栈模拟：`run()` 压栈，同步返回就弹栈；返回 Promise 则在它 settle 后弹栈。
 * - 所以**异步期间 store 一直可见**，这正是引擎需要的（下载要跨很多 await）。
 * - 局限：两个 operation **交错执行**时，内层会临时覆盖外层（单线程栈的固有行为）。
 *   M1 的 probe / 下载都是一次一个，够用；等 M4 做并发下载时，这里必须换成
 *   「按 jobId 显式传状态」，否则会串任务——那时这段注释就是提醒。
 */
export class AsyncLocalStorage<T> {
  private stack: T[] = [];

  run<R>(store: T, fn: () => R): R {
    this.stack.push(store);
    let result: R;
    try {
      result = fn();
    } catch (error) {
      this.stack.pop();
      throw error;
    }

    const maybePromise = result as unknown as { then?: unknown; finally?: unknown };
    if (maybePromise && typeof maybePromise.then === 'function' && typeof maybePromise.finally === 'function') {
      // 异步体：等它结束再弹栈，模拟「异步上下文里 store 仍然可见」
      return (result as unknown as Promise<unknown>).finally(() => {
        this.stack.pop();
      }) as unknown as R;
    }

    this.stack.pop();
    return result;
  }

  getStore(): T | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** 引擎没用，但 Node 的 API 有；留着避免将来调用时是 undefined 而不是明确报错。 */
  enterWith(store: T): void {
    this.stack.push(store);
  }

  exit<R>(fn: () => R): R {
    const saved = this.stack.pop();
    try {
      return fn();
    } finally {
      if (saved !== undefined) this.stack.push(saved);
    }
  }

  disable(): void {
    this.stack.length = 0;
  }
}
