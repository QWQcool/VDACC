import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 常驻 Python helper：一次启动，多次 probe，避开 exe 的 2.5s 解包。 */
let child: ChildProcessWithoutNullStreams | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let buffer = '';

function repoRoot(): string {
  // spike/ts-core/src/core -> 仓库根
  return join(import.meta.dir, '..', '..', '..', '..');
}

function pythonPath(): string {
  return process.env.VDL_PYTHON ||
    join(repoRoot(), 'venv', 'Scripts', 'python.exe');
}

function start() {
  const py = pythonPath();
  if (!existsSync(py)) throw new Error(`找不到 Python: ${py}`);
  const script = join(import.meta.dir, '..', '..', 'helper', 'ytdlp_helper.py');
  child = spawn(py, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          const slot = pending.get(msg.id);
          if (slot) {
            pending.delete(msg.id);
            msg.ok ? slot.resolve(msg.info) : slot.reject(new Error(msg.error));
          }
        } catch {
          // 忽略脏行
        }
      }
      idx = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', () => { /* helper 的错误通过 JSON 回传 */ });
}

export function probeViaHelper(url: string, timeoutMs = 60000): Promise<any> {
  if (!child) start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('helper 超时'));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child!.stdin.write(JSON.stringify({ id, url }) + '\n');
  });
}

export function closeHelper() {
  if (child) {
    try { child.stdin.end(); } catch { /* ignore */ }
    child = null;
  }
}
