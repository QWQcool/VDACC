import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';

import { planAlbum } from './core/album';
import { DownloadCancelled } from './core/cancel';
import { configPath, loadConfig, saveConfig } from './core/config';
import { fail, VdlError } from './core/errors';
import { fetchMediaStream, jailedPath, originAllowed } from './core/security';
import { writeJsonAtomic } from './core/storage';
import { UA } from './core/http';
import { platformOf } from './core/platform';
import { pickSha256For } from './core/doctor';
import { runOperation } from './core/operation';
import { currentLimitBytesPerSec, setLimitBytesPerSec } from './core/rate';
import { getDouyin, previewDouyin, probeDouyin } from './engines/douyin';
import { albumTracks as neteaseAlbum, previewNetease, getNetease, probeNetease } from './engines/netease';
import { albumTracks as qqAlbum, getQQ, previewQQ, probeQQ } from './engines/qq';
import { getKuwo, probeKuwo } from './engines/kuwo';
import { getKugou, probeKugou } from './engines/kugou';
import { canHandle as canSniff, getSniff, probeSniff } from './engines/sniff';
import { getBilibiliApi, previewBilibili, probeBilibiliApi, refetchSidecars } from './engines/bilibili_api';
import { SITES as AUTH_SITES, login as authLogin, status as authStatus, verify as authVerify } from './auth';
import { componentPath, genericInstalled, getGeneric, probeGeneric } from './engines/generic';
import type { DownloadOptions, Job, ProbeResult } from './core/types';

const argv = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const PORT = Number(flag('--port', '8780'));
const TOKEN = flag('--token', randomBytes(8).toString('hex'));
// 双击启动器时用：服务起来后把带 token 的地址交给默认浏览器，省掉手动复制
const OPEN = argv.includes('--open');
const CONFIG = loadConfig();
const OUT = resolve(flag('-o', CONFIG.outDir || join(process.cwd(), '下载')));
const WEB = join(import.meta.dir, '..', '..', 'web');
const STORE = process.env.VDL_STORE ||
  join(dirname(configPath()), 'ts-jobs.json');
mkdirSync(OUT, { recursive: true });
// 限速是进程级全局状态（下载器单 worker 串行），启动时按配置装一次
setLimitBytesPerSec(CONFIG.limitRate || 0);

const jobs = new Map<string, Job>();
const order: string[] = [];
const queue: string[] = [];
let running = false;
let persistenceWarning = '';

const clients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();

function loadStore() {
  if (!existsSync(STORE)) return;
  try {
    const data = JSON.parse(readFileSync(STORE, 'utf8'));
    if (!Array.isArray(data.jobs)) throw new Error('invalid job store');
    for (const job of data.jobs) {
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
    // 损坏时停止启动，避免一次新下载覆盖用户仍可能恢复的历史。
    throw new VdlError('history_invalid', '任务历史无法读取或格式无效', '备份并修复 ts-jobs.json 后重启；原文件未改动');
  }
}

function saveStore() {
  // 活跃任务不能被“最近 100 条”挤出，否则重启会悄悄丢掉已接受的队列。
  const finished = order.filter((id) => !['queued', 'running'].includes(jobs.get(id)!.status)).slice(-100);
  const keep = new Set([...finished, ...order.filter((id) => ['queued', 'running'].includes(jobs.get(id)!.status))]);
  writeJsonAtomic(STORE, { jobs: order.filter((id) => keep.has(id)).map((id) => jobs.get(id)) });
  persistenceWarning = '';
}

// 账号在线校验要打三个站点的网络，缓存 20 秒，避免界面每次打开都等十几秒
let authCache: { at: number; rows: Awaited<ReturnType<typeof authVerify>> } | null = null;
const authLogins = new Set<string>();

/** 状态迁移立即落盘；运行中的磁盘失败可见，但不把已下载文件误判成失败。 */
function scheduleSave() {
  try { saveStore(); }
  catch {
    persistenceWarning = '任务历史保存失败，请检查用户数据目录权限和磁盘空间';
    console.error('[storage_write_failed] ' + persistenceWarning);
  }
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
  return fail(platform, 'ts-server', err);
}

async function probeUrl(url: string): Promise<ProbeResult> {
  switch (platformOf(url)) {
    case 'douyin': return probeDouyin(url);
    case 'netease': return probeNetease(url);
    case 'qq': return probeQQ(url);
    case 'kuwo': return probeKuwo(url);
    case 'kugou': return probeKugou(url);
    case 'bilibili': return probeBilibiliApi(url);
    default: {
      if (canSniff(url)) return probeSniff(url);
      if (loadConfig().allowGeneric && genericInstalled()) return probeGeneric(url);
      throw new VdlError('engine_unavailable', `暂不支持这个站点: ${url}`,
        genericInstalled() ? '在设置里启用「通用解析」后重试' : '在设置里下载 yt-dlp 组件');
    }
  }
}

async function downloadUrl(url: string, formatId: string,
                             opts: DownloadOptions = {}) {
  switch (platformOf(url)) {
    case 'douyin': return getDouyin(url, formatId, OUT, opts);
    case 'netease': return getNetease(url, formatId, OUT);
    case 'qq': return getQQ(url, formatId, OUT);
    case 'kuwo': return getKuwo(url, formatId, OUT);
    case 'kugou': return getKugou(url, formatId, OUT);
    case 'bilibili': return getBilibiliApi(url, formatId, OUT, opts);
    default: {
      if (canSniff(url)) return getSniff(url, formatId, OUT);
      if (loadConfig().allowGeneric && genericInstalled()) {
        return getGeneric(url, formatId, OUT);
      }
      throw new VdlError('engine_unavailable', `暂不支持这个站点: ${url}`,
        '在设置里启用通用解析并下载组件');
    }
  }
}

function createJob(url: string, formatId: string, opts: DownloadOptions = {}): Job {
  const job: Job = {
    id: randomBytes(4).toString('hex'), url, formatId: formatId || '',
    status: 'queued', percent: 0, bytes: 0, total: 0, createdAt: Date.now(),
    ...(opts.subs ? { subs: true } : {}),
    ...(opts.danmaku ? { danmaku: true } : {}),
    ...(opts.cover ? { cover: true } : {}),
  };
  jobs.set(job.id, job);
  order.push(job.id);
  return job;
}

/** 先整体持久化再启动；写盘失败时回滚，避免客户端收不到成功却已经开始下载。 */
function submitJobs(url: string, ids: string[], opts: DownloadOptions): Job[] {
  const created = ids.map((id) => createJob(url, id, opts));
  try { saveStore(); }
  catch (err) {
    for (const job of created) jobs.delete(job.id);
    order.splice(order.length - created.length, created.length);
    throw err;
  }
  for (const job of created) queue.push(job.id);
  void pump();
  return created;
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
    scheduleSave();
    emit(job);
    try {
      const out = await runOperation(() => downloadUrl(job.url, job.formatId,
        { cover: job.cover, subs: job.subs, danmaku: job.danmaku }), {
        cancelled: () => !!job.cancelRequested,
        progress(written, total) {
          job.bytes = written;
          job.total = total;
          job.percent = total ? Math.min(99.9, Math.round((written / total) * 1000) / 10) : 0;
          emit(job);
        },
      });
      const extra = out as any;
      Object.assign(job, {
        status: 'done', percent: 100, bytes: out.bytes, total: out.bytes,
        path: out.path, finishedAt: Date.now(),
        ...(extra.srtCount ? { srtCount: extra.srtCount } : {}),
        ...(extra.danmakuCount ? { danmakuCount: extra.danmakuCount } : {}),
        warnings: extra.warnings || [],
      });
    } catch (err) {
      if (err instanceof DownloadCancelled) {
        job.status = 'cancelled';
        job.error = { code: 'cancelled', message: '用户取消' };
      } else {
        job.status = 'failed';
        job.error = failBody('ts', err).error;
      }
      job.finishedAt = Date.now();
    } finally {
      scheduleSave();
      if (persistenceWarning) job.warnings = [...(job.warnings || []), persistenceWarning];
      emit(job);
    }
  }
  running = false;
}

function authorized(req: Request, url: URL): boolean {
  const token = url.searchParams.get('token') || req.headers.get('x-vdl-token') || '';
  return token === TOKEN;
}

const LAN = argv.includes('--lan');
const server = Bun.serve({
  hostname: LAN ? '0.0.0.0' : '127.0.0.1',
  port: PORT,
  // SSE 每 15s 才发一次 ping，而 Bun 默认 idleTimeout 是 10s：
  // 到点就把连接掐掉（浏览器报 ERR_INCOMPLETE_CHUNKED_ENCODING），前端只能不停重连。
  // 这里放宽到 120s，给心跳留出余量。
  idleTimeout: 120,
  async fetch(req) {
    return runOperation(async () => {
    try {
    const url = new URL(req.url);
    const path = url.pathname;

    // 静态页不需要 token（前端自己带 token 调接口）
    if (!path.startsWith('/api/')) {
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
      let rel = path === '/' ? '/vue/index.html' : path;
      if (rel.endsWith('/')) rel += 'index.html';
      const file = jailedPath(WEB, normalize(join(WEB, rel)));
      if (!file) {
        return new Response('not found', { status: 404 });
      }
      return new Response(Bun.file(file));
    }

    if (!authorized(req, url)) return json({ ok: false, error: { code: 'unauthorized', message: 'token 无效' } }, 401);
    if (!originAllowed(req, process.env.VDL_ALLOW_ORIGIN)) return json({ ok: false, error: { code: 'forbidden', message: 'Origin 不被允许' } }, 403);

    if (path === '/api/health') {
      return json({
        // 与根 package.json / ts/package.json 保持一致（server 要能单独编译成 exe，不读文件）
        ok: true, version: '3.3.1', schema: 2, outDir: OUT,
        jobs: order.length, engine: 'ts',
        theme: (loadConfig().theme || 'light'),
        limitRate: currentLimitBytesPerSec(),
        warnings: persistenceWarning ? [persistenceWarning] : [],
      });
    }

    if (path === '/api/events') {
      let controller: ReadableStreamDefaultController;
      let timer: ReturnType<typeof setInterval>;
      const stream = new ReadableStream({
        start(c) {
          controller = c;
          clients.add(c);
          // 每次重连立即发送快照，补回断线期间丢失的终态，不依赖后续任务事件。
          for (const job of jobs.values()) c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'job', job })}\n\n`));
          c.enqueue(encoder.encode(': connected\n\n'));
          timer = setInterval(() => {
            try { c.enqueue(encoder.encode(': ping\n\n')); }
            catch { clearInterval(timer); clients.delete(c); }
          }, 15000);
        },
        cancel() { clearInterval(timer); clients.delete(controller); },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    if (path === '/api/probe' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) || {};
      const target = String(body.url || '').trim();
      if (!target) return json({ ok: false, error: { code: 'bad_input', message: '缺少 url' } }, 400);
      try {
        return json(await probeUrl(target));
      } catch (err) {
        return json(failBody('ts', err));
      }
    }

    // 专辑曲目预览：只列前 20（planAlbum），下载仍由 /api/jobs 逐首建任务
    if (path === '/api/album' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) || {};
      const target = String(body.url || '').trim();
      if (!target) return json({ ok: false, error: { code: 'bad_input', message: '缺少 url' } }, 400);
      const platform = platformOf(target);
      if (platform !== 'netease' && platform !== 'qq') {
        return json({
          ok: false,
          error: { code: 'unsupported', message: '专辑只支持 网易云 / QQ 音乐' },
        }, 400);
      }
      // offset 用于「加载下一批」：单批仍最多 20 首，不按整张专辑硬下
      const offset = Number(body.offset) || 0;
      try {
        const info = platform === 'netease' ? await neteaseAlbum(target) : await qqAlbum(target);
        const plan = planAlbum(info.tracks, offset);
        return json({
          ok: true,
          album: {
            id: info.id, title: info.title, cover: info.cover, total: info.tracks.length,
          },
          tracks: plan.take,
          dropped: plan.dropped,
          offset: plan.offset,
          hasMore: plan.hasMore,
          nextOffset: plan.nextOffset,
        });
      } catch (err) {
        return json(failBody('ts', err));
      }
    }

    // 账号状态：本地是否有凭据 + 在线是否仍有效（缓存 20s）
    if (path === '/api/auth' && req.method === 'GET') {
      const local = authStatus();
      if (!authCache || Date.now() - authCache.at > 20000) {
        try {
          authCache = { at: Date.now(), rows: await authVerify() };
        } catch {
          authCache = { at: Date.now(), rows: [] };
        }
      }
      const bySite = new Map((authCache?.rows || []).map((r) => [r.site, r]));
      return json({
        ok: true,
        sites: local.map((r) => ({ ...r, online: bySite.get(r.site) || null })),
        loggingIn: [...authLogins],
      });
    }

    // 重新登录：在电脑上弹出独立 Edge，扫码结果写回凭据（手机端只负责发起与看状态）
    if (path.startsWith('/api/auth/') && path.endsWith('/login') && req.method === 'POST') {
      const site = path.slice('/api/auth/'.length, -'/login'.length);
      if (!AUTH_SITES[site]) {
        return json({ ok: false, error: { code: 'bad_input', message: '未知站点' } }, 400);
      }
      if (authLogins.has(site)) {
        return json({ ok: true, started: false, message: '已经在等待上一次登录完成' });
      }
      authLogins.add(site);
      authCache = null;
      authLogin(site, 300000)
        .then(() => { authCache = null; })
        .catch((err) => { console.error('[auth_login_failed] ' + (err as Error).message); })
        .finally(() => { authLogins.delete(site); });
      return json({
        ok: true, started: true,
        message: '已在电脑上打开 Edge，请完成扫码/登录；完成后点「刷新状态」',
      });
    }

    // 附属重取：只重新拉字幕/弹幕，不重新下载视频
    const sidecarMatch = /^\/api\/jobs\/([^/]+)\/sidecar$/.exec(path);
    if (sidecarMatch && req.method === 'POST') {
      const job = jobs.get(sidecarMatch[1]);
      if (!job) return json({ ok: false, error: { code: 'not_found', message: '任务不存在' } }, 404);
      if (job.status !== 'done' || !job.path || !existsSync(job.path)) {
        return json({
          ok: false,
          error: { code: 'not_ready', message: '只有已完成、且文件还在的任务才能重取附属' },
        }, 409);
      }
      if (platformOf(job.url) !== 'bilibili') {
        return json({ ok: false, error: { code: 'unsupported', message: '附属重取只支持 B站' } }, 400);
      }
      try {
        const out = await refetchSidecars(job.url, job.path, {
          subs: true, danmaku: job.danmaku === true,
        });
        Object.assign(job, {
          ...(out.srtCount ? { srtCount: out.srtCount } : {}),
          ...(out.danmakuCount ? { danmakuCount: out.danmakuCount } : {}),
        });
        scheduleSave();
        return json({
          ok: true, job, srt: out.srt, srtCount: out.srtCount,
          danmaku: out.danmaku, danmakuCount: out.danmakuCount,
          danmakuSupported: out.danmakuSupported,
        });
      } catch (err) {
        return json(failBody('ts', err));
      }
    }

    if (path === '/api/components') {
      const installed = genericInstalled();
      const expected = loadConfig().ytdlpSha256 || '';
      // 只报「记录过校验值且一致」为已校验；旧安装没有记录就如实说未校验
      let verified: boolean | null = null;
      if (installed && expected) {
        try {
          verified = createHash('sha256').update(readFileSync(componentPath())).digest('hex') === expected;
        } catch {
          verified = false;
        }
      }
      return json({
        ok: true,
        components: {
          ytdlp: {
            installed,
            path: componentPath(),
            bytes: installed ? statSync(componentPath()).size : 0,
            verified,
          },
        },
      });
    }

    if (path === '/api/components/ytdlp/install' && req.method === 'POST') {
      const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
      try {
        // 先拿官方校验和，再下二进制：不校验就写盘等于把「装好了」当「可信」
        const sumsRes = await fetch(base + 'SHA2-256SUMS');
        if (!sumsRes.ok) throw new Error(`校验和下载失败 HTTP ${sumsRes.status}`);
        const sums = await sumsRes.text();
        const expected = pickSha256For(sums, 'yt-dlp.exe');
        if (!expected) throw new Error('官方校验和里没有 yt-dlp.exe');

        const res = await fetch(base + 'yt-dlp.exe');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const actual = createHash('sha256').update(buf).digest('hex');
        if (actual !== expected) {
          throw new Error(`SHA256 校验不通过（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
        }

        const target = componentPath();
        mkdirSync(dirname(target), { recursive: true });
        const tmp = target + '.part';
        await Bun.write(tmp, buf);
        const { renameSync } = await import('node:fs');
        renameSync(tmp, target);
        saveConfig({ allowGeneric: true, ytdlpSha256: actual });
        return json({
          ok: true, installed: true, verified: true,
          bytes: statSync(target).size, sha256: actual,
        });
      } catch (err) {
        return json({
          ok: false,
          error: { code: 'download_failed', message: `组件下载失败: ${(err as Error).message}` },
        }, 500);
      }
    }

    if (path === '/api/preview' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) || {};
      const target = String(body.url || '').trim();
      if (!target) return json({ ok: false, error: { code: 'bad_input', message: '缺少 url' } }, 400);
      await probeUrl(target);
      const formatId = String(body.formatId || '');
      let src = '';
      let ref = '';
      switch (platformOf(target)) {
        case 'douyin': src = previewDouyin(formatId); ref = 'https://www.douyin.com/'; break;
        case 'bilibili': src = previewBilibili(formatId); ref = 'https://www.bilibili.com/'; break;
        case 'netease': src = previewNetease(formatId); ref = 'https://music.163.com/'; break;
        case 'qq': src = previewQQ(formatId); ref = 'https://y.qq.com/'; break;
        default: break;
      }
      if (!src) {
        return json({ ok: false, error: { code: 'no_stream', message: '没有可预览的地址' } });
      }
      const q = new URLSearchParams({ token: TOKEN, src, ref });
      return json({ ok: true, formatId, url: `/api/stream?${q}` });
    }

    if (path === '/api/stream') {
      if (!['GET', 'HEAD'].includes(req.method)) return new Response('method not allowed', { status: 405 });
      const src = url.searchParams.get('src') || '';
      const ref = url.searchParams.get('ref') || '';
      const headers: Record<string, string> = { 'User-Agent': UA, Referer: ref || src };
      const range = req.headers.get('range');
      if (range) headers.Range = range;
      const remote = await fetchMediaStream(src, { headers, method: req.method,
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(30000)]) });
      const out = new Headers();
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = remote.headers.get(key);
        if (value) out.set(key, value);
      }
      return new Response(remote.body, { status: remote.status, headers: out });
    }

    if (path === '/api/preview' && req.method === 'GET') {
      const target = jailedPath(OUT, url.searchParams.get('path') || '');
      if (!target) {
        return json({ ok: false, error: { code: 'bad_input', message: '路径不在输出目录内' } }, 403);
      }
      return new Response(Bun.file(target));
    }

    if (path === '/api/settings') {
      if (req.method === 'GET') return json({ ok: true, settings: loadConfig() });
      if (req.method === 'PATCH' || req.method === 'POST') {
        const body = await req.json().catch(() => null);
        const next = saveConfig(body);
        // 改完立即生效：否则用户要重启服务才能看到限速变化，会以为设置没保存
        setLimitBytesPerSec(next.limitRate || 0);
        return json({ ok: true, settings: next });
      }
      return json({ ok: false, error: { code: 'bad_input', message: '只支持 GET/PATCH' } }, 405);
    }

    if (path === '/api/jobs' && req.method === 'GET') {
      return json({ ok: true, jobs: order.map((id) => jobs.get(id)), warnings: persistenceWarning ? [persistenceWarning] : [] });
    }

    if (path === '/api/jobs' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) || {};
      const target = String(body.url || '').trim();
      if (!target) return json({ ok: false, error: { code: 'bad_input', message: '缺少 url' } }, 400);
      const ids: string[] = Array.isArray(body.formatIds) && body.formatIds.length
        ? body.formatIds.filter((x: any) => typeof x === 'string')
        : [String(body.formatId || '')];
      if (!ids.length || ids.length > 20 || (Array.isArray(body.formatIds) && body.formatIds.length !== ids.length)) {
        throw new VdlError('bad_input', '每次提交 1–20 个有效档位');
      }
      // 附属产物开关：只认显式 true，避免字符串 "false" 之类被当成开启
      const opts = { cover: body.cover === true, subs: body.subs === true, danmaku: body.danmaku === true };
      const created = submitJobs(target, [...new Set(ids)], opts);
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

      if (!['done', 'failed', 'cancelled'].includes(job.status)) {
        throw new VdlError('bad_input', '任务尚未结束，不能重复重试');
      }
      const [next] = submitJobs(job.url, [job.formatId], { cover: job.cover, subs: job.subs, danmaku: job.danmaku });
      return json({ ok: true, job: next }, 202);
    }

    const fileMatch = /^\/api\/files\/([0-9a-f]+)$/.exec(path);
    if (fileMatch) {
      const job = jobs.get(fileMatch[1]);
      if (!job || job.status !== 'done' || !job.path) {
        return json({ ok: false, error: { code: 'not_found', message: '任务不存在或未完成' } }, 404);
      }
      const target = jailedPath(OUT, job.path);
      if (!target) {
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
      const body = (await req.json().catch(() => null)) || {};
      const target = jailedPath(OUT, String(body.path || ''), false);
      if (!target) {
        return json({ ok: false, error: { code: 'bad_input', message: '路径不在输出目录内' } }, 400);
      }
      spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' }).unref();
      return json({ ok: true });
    }

    return json({ ok: false, error: { code: 'not_found', message: `没有这个接口: ${path}` } }, 404);
    } catch (err) {
      const status = err instanceof VdlError && err.code === 'forbidden' ? 403
        : err instanceof VdlError && err.code === 'bad_input' ? 400 : 500;
      return json(failBody('ts', err), status);
    }
    });
  },
});

console.log(`vdl-ts ${server.port} 已启动`);
console.log(`  地址: http://127.0.0.1:${server.port}/?token=${TOKEN}`);
if (LAN) {
  // 只报内网地址（10/8、172.16/12、192.168/16）：VPN/虚拟网卡的地址手机连不上，列出来只会误导
  const lan = Object.values(networkInterfaces()).flat()
    .filter((x): x is NonNullable<typeof x> => !!x && x.family === 'IPv4' && !x.internal)
    .map((x) => x.address)
    .filter((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  console.warn('');
  console.warn('  ⚠️  --lan：服务已绑定 0.0.0.0，同一局域网内的设备都能访问（仍需 token）。');
  console.warn('      公共网络下不要开；用完记得关掉服务。');
  console.warn('      Windows 首次运行可能弹防火墙授权，需允许「专用网络」。');
  for (const ip of lan) console.log(`  手机访问: http://${ip}:${server.port}/?token=${TOKEN}`);
  console.warn('');
}
console.log(`  输出: ${OUT}`);

/** 打开默认浏览器。失败不致命——地址已经打印在上面，复制粘贴照样能用。 */
function openBrowser(url: string) {
  const [cmd, args]: [string, string[]] = process.platform === 'win32'
    ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // 忽略
  }
}

if (OPEN) openBrowser(`http://127.0.0.1:${server.port}/?token=${TOKEN}`);
