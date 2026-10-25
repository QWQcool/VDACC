import { currentOperation } from './operation';

export class DownloadCancelled extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = 'DownloadCancelled';
  }
}

export function throwIfCancelled() {
  const check = currentOperation()?.cancelled;
  if (check && check()) throw new DownloadCancelled();
}
