import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, normalize, resolve } from 'node:path';

import { VdlError } from './core/errors';
import { setProgressSink } from './core/progress';
import { probeDouyin, getDouyin } from './engines/douyin';
import { probeNetease } from './engines/netease';
import { getBilibiliApi, probeBilibiliApi } from './engines/bilibili_api';
import type { ProbeResult } from './core/types';

const argv = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const PORT = Number(flag('--port', '8780'));
const TOKEN = flag('--token', randomBytes(8).toString('hex'));
const OUT = resolve(flag('-o', join(process.cwd(), '下载')));
const WEB = join(import.meta.dir, '..', '..', '..', 'vdl', 'web');
mkdirSync(OUT, { recursive: true });

interface Job {
  id: string;
  url: string;
  formatId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  percent: number;
  bytes: number;
  total: number;
  path?: string;
  error?: { code: string; message: string };
  createdAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, Job>();
const order: string[] = [];
const queue: string[] = [];
let running = false;

const clients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();

function emit(job: Job) {
  const payload = `data: ${JSON.stringify({ type: 'job', job })}\n\n`;
  for (const client of clients) {
    try { client.enqueue(encoder.encode(payload)); } catch { clients.delete(client); }
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function failBody(platform: string, err: unknown) {
  const e = err as VdlError;
  return {
    schema: 2, ok: false, platform, engine: 'ts-ts', media: null, formats: [],
    warnings: [],
    error: {
      code: e?.code || 'internal',
      message: e?.message || String(err),
      next_action: e?.nextAction || '',
    },
  };
}

async function probeUrl(url: string): Promise<ProbeResult> {
  const raw = url.trim();
  if (/^\d{15,20}$/.test(raw) || /douyin\.com/.test(raw)) return probeDouyin(raw);
  if (/^\d{1,12}$/.test(raw) || /music\.163\.com|163cn\.tv/.test(raw)) return probeNetease(raw);
  return probeBilibiliApi(raw);
}

async function downloadUrl(url: string, formatId: string) {
  if (/douyin\.com/.test(url) || /^\d{15,20}$/.test(url.trim())) {
    return getDouyin(url, formatId, OUT);
  }
  if (/music\.163\.com/.test(url)) {
    throw new VdlError('not_implemented', 'TS spike 暂未实现网易云下载（probe 可用）');
  }
  return getBilibiliApi(url, formatId, OUT);
}

function createJob(url: string, formatId: string): Job {
  const job: Job = {
    id: randomBytes(4).toString('hex'), url, formatId: formatId || '',
    status: 'queued', percent: 0, bytes: 0, total: 0, createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  order.push(job.id);
  return job;
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = jobs.get(queue.shift()!);
    if (!job) continue;
    job.status = 'running';
    emit(job);
    setProgressSink((written, total) => {
      job.bytes = written;
      job.total = total;
      job.percent = total ? Math.min(99.9, Math.round((written / total) * 1000) / 10) : 0;
      emit(job);
    });
    try {
      const out = await downloadUrl(job.url, job.formatId);
      Object.assign(job, {
        status: 'done', percent: 100, bytes: out.bytes, total: out.bytes,
        path: out.path, finishedAt: Date.now(),
      });
    } catch (err) {
      const e = err as VdlError;
      job.status = 'failed';
      job.error = { code: e?.code || 'internal', message: e?.message || String(err) };
      job.finishedAt = Date.now();
    } finally {
      setProgressSink(null);
      emit(job);
    }
  }
  running = false;
}

function enqueue(id: string) {
  queue.push(id);
  void pump();
}

function authorized(req: Request, url: URL): boolean {
  const token = url.searchParams.get('token') || req.headers.get('x-vdl-token') || '';
  return token === TOKEN;
}

function originOk(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  return origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost') ||
    origin === (process.env.VDL_ALLOW_ORIGIN || '');
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // 静态页不需要 token（前端自己带 token 调接口）
    if (!path.startsWith('/api/')) {
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
      const rel = path === '/' ? '/index.html' : path;
      const file = normalize(join(WEB, rel));
      if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) {
        return new Response('not found', { status: 404 });
      }
      return new Response(Bun.file(file));
    }

    if (!authorized(req, url)) return json({ ok: false, error: { code: 'unauthorized', message: 'token 无效' } }, 401);
    if (!originOk(req)) return json({ ok: false, error: { code: 'forbidden', message: 'Origin 不被允许' } }, 403);

    if (path === '/api/health') {
      return json({
        ok: true, version: '2.2.0-ts-spike', schema: 2, outDir: OUT,
        jobs: order.length, engine: 'ts',
      });
    }

    if (path === '/api/events') {
      let controller: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) { controller = c; clients.add(c); },
        cancel() { clients.delete(controller); },
      });
      const timer = setInterval(() => {
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { clearInterval(timer); }
      }, 15000);
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    if (path === '/api/probe' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as any;
      const target = String(body.url || '').trim();
      if (!target) return json({ ok: false, error: { code: 'bad_input', message: '缺少 url' } }, 400);
      try {
        return json(await probeUrl(target));
      } catch (err) {
        return json(failBody('ts', err));
      }
    }

    if (path === '/api/jobs' && req.method === 'GET') {
      return json({ ok: true, jobs: order.map((id) => jobs.get(id)) });
    }

    if (path === '/api/jobs' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as any;
      const target = String(body.url || '').trim();
      if (!target) return json({ ok: false, error: { code: 'bad_input', message: '缺少 url' } }, 400);
      const ids: string[] = Array.isArray(body.formatIds) && body.formatIds.length
        ? body.formatIds.filter((x: any) => typeof x === 'string')
        : [String(body.formatId || '')];
      const created = ids.map((formatId) => createJob(target, formatId));
      for (const job of created) enqueue(job.id);
      return json({ ok: true, jobs: created, job: created[0] }, 202);
    }

    const jobMatch = /^\/api\/jobs\/([0-9a-f]+)$/.exec(path);
    if (jobMatch && req.method === 'GET') {
      const job = jobs.get(jobMatch[1]);
      return job ? json({ ok: true, job }) : json({ ok: false, error: { code: 'not_found' } }, 404);
    }

    const fileMatch = /^\/api\/files\/([0-9a-f]+)$/.exec(path);
    if (fileMatch) {
      const job = jobs.get(fileMatch[1]);
      if (!job || job.status !== 'done' || !job.path) {
        return json({ ok: false, error: { code: 'not_found', message: '任务不存在或未完成' } }, 404);
      }
      const target = resolve(job.path);
      if (!target.startsWith(OUT) || !existsSync(target)) {
        return json({ ok: false, error: { code: 'bad_input', message: '路径不在输出目录内' } }, 403);
      }
      return new Response(Bun.file(target), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(statSync(target).size),
          'Content-Disposition':
            `attachment; filename*=UTF-8''${encodeURIComponent(target.split(/[\\/]/).pop() || 'file')}`,
        },
      });
    }

    if (path === '/api/reveal' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as any;
      const target = resolve(String(body.path || ''));
      if (!target.startsWith(OUT) || !existsSync(target)) {
        return json({ ok: false, error: { code: 'bad_input', message: '路径不在输出目录内' } }, 400);
      }
      spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' }).unref();
      return json({ ok: true });
    }

    return json({ ok: false, error: { code: 'not_found', message: `没有这个接口: ${path}` } }, 404);
  },
});

console.log(`vdl-ts ${server.port} 已启动`);
console.log(`  地址: http://127.0.0.1:${server.port}/?token=${TOKEN}`);
console.log(`  输出: ${OUT}`);
