import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, normalize, resolve } from 'node:path';

import { DownloadCancelled, setCancelCheck } from './core/cancel';
import { loadConfig, saveConfig } from './core/config';
import { VdlError } from './core/errors';
import { UA } from './core/http';
import { platformOf } from './core/platform';
import { setProgressSink } from './core/progress';
import { getDouyin, previewDouyin, probeDouyin } from './engines/douyin';
import { formatUrls, getNetease, probeNetease } from './engines/netease';
import { getBilibiliApi, previewBilibili, probeBilibiliApi } from './engines/bilibili_api';
import { componentPath, genericInstalled, getGeneric, probeGeneric } from './engines/generic';
import type { ProbeResult } from './core/types';

const argv = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const PORT = Number(flag('--port', '8780'));
const TOKEN = flag('--token', randomBytes(8).toString('hex'));
const CONFIG = loadConfig();
const OUT = resolve(flag('-o', CONFIG.outDir || join(process.cwd(), '下载')));
const WEB = join(import.meta.dir, '..', '..', 'vdl', 'web');
const STORE = process.env.VDL_STORE ||
  join(process.env.LOCALAPPDATA || '', 'vdl', 'ts-jobs.json');
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
  cancelRequested?: boolean;
}

const jobs = new Map<string, Job>();
const order: string[] = [];
const queue: string[] = [];
let running = false;

const clients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();

function loadStore() {
  if (!existsSync(STORE)) return;
  try {
    const data = JSON.parse(readFileSync(STORE, 'utf8'));
    for (const job of (data.jobs || []).slice(-100)) {
      if (!job || !job.id) continue;
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'failed';
        job.error = { code: 'interrupted', message: '上次会话中断，未完成' };
        job.finishedAt = Date.now();
      }
      jobs.set(job.id, job);
      order.push(job.id);
    }
  } catch {
    // 坏存档当没有历史
  }
}

function saveStore() {
  try {
    const payload = { jobs: order.slice(-100).map((id) => jobs.get(id)) };
    writeFileSync(STORE, JSON.stringify(payload), 'utf8');
  } catch {
    // 存档失败不影响下载
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveStore(); }, 500);
}

loadStore();

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
  switch (platformOf(url)) {
    case 'douyin': return probeDouyin(url);
    case 'netease': return probeNetease(url);
    case 'bilibili': return probeBilibiliApi(url);
    default: {
      if (loadConfig().allowGeneric && genericInstalled()) return probeGeneric(url);
      throw new VdlError('engine_unavailable', `暂不支持这个站点: ${url}`,
        genericInstalled() ? '在设置里启用「通用解析」后重试' : '在设置里下载 yt-dlp 组件');
    }
  }
}

async function downloadUrl(url: string, formatId: string) {
  switch (platformOf(url)) {
    case 'douyin': return getDouyin(url, formatId, OUT);
    case 'netease': return getNetease(url, formatId, OUT);
    case 'bilibili': return getBilibiliApi(url, formatId, OUT);
    default: {
      if (loadConfig().allowGeneric && genericInstalled()) {
        return getGeneric(url, formatId, OUT);
      }
      throw new VdlError('engine_unavailable', `暂不支持这个站点: ${url}`,
        '在设置里启用通用解析并下载组件');
    }
  }
}

function createJob(url: string, formatId: string): Job {
  const job: Job = {
    id: randomBytes(4).toString('hex'), url, formatId: formatId || '',
    status: 'queued', percent: 0, bytes: 0, total: 0, createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  order.push(job.id);
  scheduleSave();
  return job;
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = jobs.get(queue.shift()!);
    if (!job) continue;
    if (job.cancelRequested) {
      job.status = 'cancelled';
      job.error = { code: 'cancelled', message: '用户取消' };
      job.finishedAt = Date.now();
      emit(job);
      scheduleSave();
      continue;
    }

    job.status = 'running';
    emit(job);
    setCancelCheck(() => !!job.cancelRequested);
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
      if (err instanceof DownloadCancelled) {
        job.status = 'cancelled';
        job.error = { code: 'cancelled', message: '用户取消' };
      } else {
        const e = err as VdlError;
        job.status = 'failed';
        job.error = { code: e?.code || 'internal', message: e?.message || String(err) };
      }
      job.finishedAt = Date.now();
    } finally {
      setCancelCheck(null);
      setProgressSink(null);
      emit(job);
      scheduleSave();
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
      let rel = path === '/' ? '/index.html' : path;
      if (rel.endsWith('/')) rel += 'index.html';
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
        ok: true, version: '3.0.0-beta.5', schema: 2, outDir: OUT,
        jobs: order.length, engine: 'ts',
        theme: (loadConfig().theme || 'light'),
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

    if (path === '/api/components') {
      const installed = genericInstalled();
      return json({
        ok: true,
        components: {
          ytdlp: {
            installed,
            path: componentPath(),
            bytes: installed ? statSync(componentPath()).size : 0,
          },
        },
      });
    }

    if (path === '/api/components/ytdlp/install' && req.method === 'POST') {
      const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const target = componentPath();
        mkdirSync(dirname(target), { recursive: true });
        const tmp = target + '.part';
        await Bun.write(tmp, await res.arrayBuffer());
        const { renameSync } = await import('node:fs');
        renameSync(tmp, target);
        saveConfig({ allowGeneric: true });
        return json({ ok: true, installed: true, bytes: statSync(target).size });
      } catch (err) {
        return json({
          ok: false,
          error: { code: 'download_failed', message: `组件下载失败: ${(err as Error).message}` },
        }, 500);
      }
    }

    if (path === '/api/preview' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as any;
      const target = String(body.url || '').trim();
      if (!target) return json({ ok: false, error: { code: 'bad_input', message: '缺少 url' } }, 400);
      try { await probeUrl(target); } catch { /* 缓存可能已有 */ }
      const formatId = String(body.formatId || '');
      let src = '';
      let ref = '';
      switch (platformOf(target)) {
        case 'douyin': src = previewDouyin(formatId); ref = 'https://www.douyin.com/'; break;
        case 'bilibili': src = previewBilibili(formatId); ref = 'https://www.bilibili.com/'; break;
        case 'netease': src = formatUrls.get(formatId) || ''; ref = 'https://music.163.com/'; break;
        default: break;
      }
      if (!src) {
        return json({ ok: false, error: { code: 'no_stream', message: '没有可预览的地址' } });
      }
      const q = new URLSearchParams({ token: TOKEN, src, ref });
      return json({ ok: true, formatId, url: `/api/stream?${q}` });
    }

    if (path === '/api/stream') {
      const src = url.searchParams.get('src') || '';
      const ref = url.searchParams.get('ref') || '';
      let host = '';
      try { host = new URL(src).hostname.toLowerCase(); } catch { /* 非法 URL */ }
      const allow = ['douyin.com', 'douyinvod.com', 'byteicdn.com',
        'bilivideo.com', 'bilivideo.cn', '126.net', '127.net'];
      if (!src.startsWith('https://') || !allow.some((h) => host === h || host.endsWith(`.${h}`))) {
        return json({ ok: false, error: { code: 'forbidden', message: '不允许的流地址' } }, 403);
      }
      const headers: Record<string, string> = { 'User-Agent': UA, Referer: ref || src };
      const range = req.headers.get('range');
      if (range) headers.Range = range;
      const remote = await fetch(src, { headers });
      const out = new Headers();
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = remote.headers.get(key);
        if (value) out.set(key, value);
      }
      return new Response(remote.body, { status: remote.status, headers: out });
    }

    if (path === '/api/preview' && req.method === 'GET') {
      const target = resolve(url.searchParams.get('path') || '');
      if (!target.startsWith(OUT) || !existsSync(target) || !statSync(target).isFile()) {
        return json({ ok: false, error: { code: 'bad_input', message: '路径不在输出目录内' } }, 403);
      }
      return new Response(Bun.file(target));
    }

    if (path === '/api/settings') {
      if (req.method === 'GET') return json({ ok: true, settings: loadConfig() });
      if (req.method === 'PATCH' || req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as any;
        const allowed: any = {};
        for (const key of ['outDir', 'theme', 'concurrency', 'limitRate', 'allowGeneric']) {
          if (body[key] !== undefined) allowed[key] = body[key];
        }
        return json({ ok: true, settings: saveConfig(allowed) });
      }
      return json({ ok: false, error: { code: 'bad_input', message: '只支持 GET/PATCH' } }, 405);
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

    const actionMatch = /^\/api\/jobs\/([0-9a-f]+)\/(cancel|retry)$/.exec(path);
    if (actionMatch && req.method === 'POST') {
      const job = jobs.get(actionMatch[1]);
      if (!job) return json({ ok: false, error: { code: 'not_found', message: '任务不存在' } }, 404);

      if (actionMatch[2] === 'cancel') {
        if (['done', 'failed', 'cancelled'].includes(job.status)) {
          return json({ ok: false, error: { code: 'bad_input', message: '任务已结束' } }, 400);
        }
        job.cancelRequested = true;
        if (job.status === 'queued') {
          job.status = 'cancelled';
          job.error = { code: 'cancelled', message: '用户取消' };
          job.finishedAt = Date.now();
        }
        emit(job);
        scheduleSave();
        return json({ ok: true, job });
      }

      const next = createJob(job.url, job.formatId);
      enqueue(next.id);
      return json({ ok: true, job: next }, 202);
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
