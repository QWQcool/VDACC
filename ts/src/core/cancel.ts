export class DownloadCancelled extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = 'DownloadCancelled';
  }
}

let check: (() => boolean) | null = null;

export function setCancelCheck(fn: (() => boolean) | null) {
  check = fn;
}

export function throwIfCancelled() {
  if (check && check()) throw new DownloadCancelled();
}
