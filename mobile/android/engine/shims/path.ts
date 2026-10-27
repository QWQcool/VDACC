/**
 * `node:path` 的浏览器侧替身。
 *
 * 为什么只实现这一小撮：端上引擎只用到 `join`（core/dest.ts 拼输出路径），
 * 其余函数是给 M1 之后的命名/落盘留的最小面。宁可缺函数直接报错，
 * 也不要静默返回错路径——错路径在下载器里等于把文件写到别处。
 *
 * 语义按 POSIX 走：Android 文件系统就是 POSIX，桌面端 Windows 的
 * `join` 会补反斜杠，而端上必须用正斜杠。
 */
export const sep = '/';
export const delimiter = ':';

/** 与 node:path.join 一致：拼完再规范化，空片段忽略。 */
export function join(...parts: string[]): string {
  return normalize(parts.filter((p) => p !== '').join('/'));
}

export function basename(p: string): string {
  const clean = trimTrailingSlash(p);
  const i = clean.lastIndexOf('/');
  return i < 0 ? clean : clean.slice(i + 1);
}

/** 与 node:path 一致：`.bashrc` 这类点开头的隐藏文件不算扩展名。 */
export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

export function dirname(p: string): string {
  const clean = trimTrailingSlash(p);
  const i = clean.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return clean.slice(0, i);
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

/** 规范化，不做磁盘访问（端上没有 cwd 概念，相对路径按原样保留）。 */
export function normalize(p: string): string {
  const absolute = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const body = out.join('/');
  if (absolute) return '/' + body;
  return body || '.';
}

function trimTrailingSlash(p: string): string {
  if (p === '/') return p;
  return p.replace(/\/+$/, '');
}

const path = { sep, delimiter, join, basename, extname, dirname, isAbsolute, normalize };
export default path;
