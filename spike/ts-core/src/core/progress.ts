type Sink = (written: number, total: number) => void;

let sink: Sink | null = null;

export function setProgressSink(fn: Sink | null) {
  sink = fn;
}

export function report(written: number, total: number) {
  if (!sink) return;
  try { sink(written, total); } catch { /* 进度不该影响下载 */ }
}
