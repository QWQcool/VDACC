/**
 * 输出路径预留：并发下载时，两个任务落到同一个文件名是唯一会互相毁数据的地方。
 * 这里只登记「当前正在写」的路径（不检查磁盘上已存在的文件）——顺序重下仍然覆盖旧文件，
 * 只有同时在写才追加 ` (2)`、` (3)`。用完必须 release，否则会一直加后缀。
 */
import { join } from 'node:path';

const active = new Set<string>();

const keyOf = (path: string) => path.replace(/\\/g, '/').toLowerCase();

export function reserveDest(dir: string, filename: string): string {
  const ext = /\.[^.\\/]+$/.exec(filename)?.[0] || '';
  const base = ext ? filename.slice(0, -ext.length) : filename;
  let candidate = join(dir, filename);
  for (let n = 2; active.has(keyOf(candidate)); n += 1) {
    candidate = join(dir, `${base} (${n})${ext}`);
  }
  active.add(keyOf(candidate));
  return candidate;
}

export function releaseDest(path: string): void {
  active.delete(keyOf(path));
}

/** 仅供测试：当前仍有预留（正常流程结束时应为空）。 */
export function activeDestCount(): number {
  return active.size;
}
