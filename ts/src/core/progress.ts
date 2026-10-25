import { currentOperation } from './operation';

export function report(written: number, total: number) {
  const sink = currentOperation()?.progress;
  if (!sink) return;
  try { sink(written, total); } catch { /* 进度不该影响下载 */ }
}
