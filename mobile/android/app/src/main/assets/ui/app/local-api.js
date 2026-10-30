/*
 * 端上的 `VDACC_API`：把界面用的 HTTP 接口换成对**本机引擎**的调用。
 *
 * 为什么只换这一层：`web/vue/app.js` 只通过 `window.VDACC_API.request(token, path, opts)`
 * 发请求（`api.js` 全部内容就是这一层）。所以端上不需要改界面代码、也不需要起本地 HTTP 服务，
 * 只要让同样的 path 返回同样的 JSON 形状。
 *
 * 支持范围（M1-d）：
 *   /api/health  /api/probe  /api/jobs(GET/POST)  /api/jobs/:id/cancel|retry|DELETE
 *   /api/jobs/clear-finished  /api/jobs/retry-failed  /api/events(SSE)
 * 未支持的返回 `{ok:false, error:{code:'unsupported', message:…}}`，界面会显示这条消息——
 * 不假装成功，也不静默丢按钮。
 */
(function () {
  const engine = () => globalThis.VDACC_ENGINE;
  const STORE = 'vdacc-mobile-jobs';
  const MAX_JOBS = 100;

  let jobs = [];          // 新→旧
  let seq = 0;
  let chain = Promise.resolve();
  const listeners = [];

  function nowId() {
    seq += 1;
    return `m${Date.now().toString(36)}${seq}`;
  }

  /** 同一任务最多自动续传几次：永久失败的链接不该每次开 App 都白下一次。 */
  const RESUME_MAX = 2;

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.map((job) => {
        // 上次没跑完的：进程已经没了。这里不再直接标死，而是「自动续传」
        // ——.part 还在 staging 里，引擎重算的同一个文件名会让 startTransfer 带上 Range 续上。
        if (job.status === 'running' || job.status === 'queued') {
          const attempts = (job.attempts || 0) + 1;
          if (attempts <= RESUME_MAX) {
            return { ...job, status: 'queued', attempts, percent: 0, bytes: 0, total: 0,
              error: undefined, finishedAt: undefined };
          }
          return { ...job, status: 'failed', attempts, finishedAt: job.finishedAt || Date.now(),
            error: { code: 'interrupted',
              message: `上次中断（已自动续传 ${RESUME_MAX} 次仍未完成，不再自动重试）` } };
        }
        return job;
      });
    } catch {
      return [];
    }
  }

  function save() {
    try {
      jobs = jobs.slice(0, MAX_JOBS);
      localStorage.setItem(STORE, JSON.stringify(jobs));
    } catch {
      /* 配额满了也不该让下载失败 */
    }
  }

  function emit(payload) {
    for (const fn of listeners.slice()) {
      try {
        fn(payload);
      } catch {
        /* 单个监听器坏了不影响别的 */
      }
    }
  }

  function upsert(job) {
    const at = jobs.findIndex((one) => one.id === job.id);
    if (at >= 0) jobs[at] = job;
    else jobs.unshift(job);
    save();
    emit({ type: 'job', job });
  }

  function find(id) {
    return jobs.find((one) => one.id === id);
  }

  /** 一次只跑一个：端上并发下载会抢带宽，也会让 .part 的进度互相干扰。 */
  function enqueue(job) {
    chain = chain.then(() => download(job)).catch(() => undefined);
    return chain;
  }

  async function download(job) {
    if (job.cancelRequested) return;
    job.status = 'running';
    job.startedAt = Date.now();
    upsert(job);
    try {
      // downloadAny：平台差异由引擎路由；附属产物开关原样带下去（B站的 subs/danmaku）
      const result = await engine().downloadAny(job.url, job.formatId, {
        onProgress: (bytes, total) => {
          job.bytes = bytes;
          job.total = total;
          job.percent = total ? Math.min(100, Math.round((bytes * 100) / total)) : 0;
          upsert(job);
        },
        onReady: (transferId, resumeFrom) => {
          job.transferId = transferId;
          // 续传要如实：上次下到一半却从 0 开始（文件名变了/暂存被清），不能假装是续传
          if (job.attempts && !resumeFrom) {
            job.warnings = [...(job.warnings || []),
              '上次的暂存文件对不上（可能换了档位或标题），这次从头下载'];
          }
          // 取消可能发生在 onReady 之前：补一次
          if (job.cancelRequested) engine().cancelTransfer(transferId).catch(() => undefined);
        },
      }, { subs: job.subs, danmaku: job.danmaku, cover: job.cover });
      job.status = 'done';
      job.percent = 100;
      job.path = result.path;
      job.bytes = result.bytes;
      job.total = result.bytes;
      job.finishedAt = Date.now();
      // 引擎的 warning 要透出来（标签写失败、封面跳过…），不能一律清空
      job.warnings = result.warnings || [];
      // 完成通知：真正的完成时刻在这里（补标签/合并都在引擎里做完了）
      const label = result.name || job.name
        || String(result.path || '').split(/[\\/]/).pop() || '';
      engine().notifyDone(label, String(result.path || '')).catch(() => undefined);
    } catch (error) {
      const code = (error && error.code) || 'error';
      if (code === 'cancelled') {
        job.status = 'cancelled';
      } else {
        job.status = 'failed';
        job.error = { code, message: String((error && error.message) || error) };
      }
      job.finishedAt = Date.now();
    }
    delete job.transferId;
    delete job.cancelRequested;
    upsert(job);
  }

  function unsupported(message) {
    return { status: 200, data: { ok: false, error: { code: 'unsupported', message } } };
  }

  function ok(data) {
    return { status: 200, data: Object.assign({ ok: true }, data) };
  }

  /* ───────────────────────── 假 SSE ───────────────────────── */

  class FakeEventSource {
    constructor() {
      this.readyState = 1; // OPEN
      this.onopen = null;
      this.onerror = null;
      this.onmessage = null;
      const listener = (payload) => {
        if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
      };
      listeners.push(listener);
      this._listener = listener;
      // 构造函数返回后 app.js 才挂 onopen/onmessage，所以推到下一拍
      setTimeout(() => {
        if (this.onopen) this.onopen();
        for (const job of jobs.slice().reverse()) listener({ type: 'job', job });
      }, 0);
    }

    close() {
      this.readyState = 2; // CLOSED
      const at = listeners.indexOf(this._listener);
      if (at >= 0) listeners.splice(at, 1);
    }
  }
  FakeEventSource.OPEN = 1;
  FakeEventSource.CLOSED = 2;
  window.EventSource = FakeEventSource;

  /* ───────────────────────── 路由 ───────────────────────── */

  async function handle(path, opts) {
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body || {};

    if (path === '/api/health') {
      // 保存位置以原生为准：用户可能选了自选目录（SAF）
      let outDir = 'Download/VDACC';
      try {
        outDir = (await engine().paths()).out || outDir;
      } catch {
        /* 取不到就显示默认，不让健康检查失败 */
      }
      return ok({
        version: engine().engineInfo().version,
        schema: 2,
        outDir,
        jobs: jobs.length,
        engine: 'mobile',
        theme: localStorage.getItem('vdl-theme') || 'light',
        limitRate: 0,
        warnings: [],
      });
    }

    if (path === '/api/events') {
      return { status: 200, data: { ok: true } }; // 真正的推送走 FakeEventSource
    }

    if (path === '/api/probe' && method === 'POST') {
      const target = String(body.url || '').trim();
      if (!target) return { status: 400, data: { ok: false, error: { code: 'bad_input', message: '缺少 url' } } };
      try {
        // probeAny：平台识别在 core/platform.ts，界面不重复判断（否则会出现两边认成不同平台）
        const result = await engine().probeAny(target);
        return { status: 200, data: result };
      } catch (error) {
        return {
          status: 200,
          data: {
            schema: 2, ok: false, platform: 'mobile', engine: 'mobile',
            media: null, formats: [], warnings: [],
            error: { code: (error && error.code) || 'error', message: String((error && error.message) || error) },
          },
        };
      }
    }

    if (path === '/api/jobs' && method === 'GET') {
      return ok({ jobs: jobs.slice(), warnings: [] });
    }

    if (path === '/api/jobs' && method === 'POST') {
      const target = String(body.url || '').trim();
      if (!target) return { status: 400, data: { ok: false, error: { code: 'bad_input', message: '缺少 url' } } };
      const ids = Array.isArray(body.formatIds) && body.formatIds.length
        ? body.formatIds.filter((one) => typeof one === 'string')
        : [String(body.formatId || '')];
      const created = ids.map((formatId) => {
        const job = {
          id: nowId(), url: target, formatId,
          // 附属产物开关与桌面 /api/jobs 同名字段；端上目前只有 B站 认它们
          subs: !!body.subs, danmaku: !!body.danmaku, cover: !!body.cover,
          status: 'queued', percent: 0, bytes: 0, total: 0, createdAt: Date.now(),
        };
        jobs.unshift(job);
        enqueue(job);
        return job;
      });
      save();
      return { status: 202, data: { ok: true, jobs: created, reused: [], job: created[0] } };
    }

    if (path === '/api/jobs/clear-finished' && method === 'POST') {
      const gone = jobs.filter((one) => ['done', 'failed', 'cancelled'].includes(one.status)).map((one) => one.id);
      jobs = jobs.filter((one) => !gone.includes(one.id));
      save();
      emit({ type: 'job-removed', ids: gone });
      return ok({ removed: gone.length });
    }

    if (path === '/api/jobs/retry-failed' && method === 'POST') {
      const failed = jobs.filter((one) => one.status === 'failed');
      for (const job of failed) {
        const next = { ...job, id: nowId(), status: 'queued', percent: 0, bytes: 0, total: 0,
          createdAt: Date.now(), error: undefined, finishedAt: undefined };
        jobs.unshift(next);
        enqueue(next);
      }
      save();
      return ok({ created: failed.length });
    }

    const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (cancel && method === 'POST') {
      const job = find(cancel[1]);
      if (!job) return { status: 404, data: { ok: false, error: { code: 'not_found', message: '任务不存在' } } };
      job.cancelRequested = true;
      if (job.transferId) await engine().cancelTransfer(job.transferId).catch(() => undefined);
      // 还在排队（没有 transferId）的直接标取消
      if (!job.transferId && job.status === 'queued') {
        job.status = 'cancelled';
        job.finishedAt = Date.now();
        upsert(job);
      }
      return ok({ job });
    }

    const retry = /^\/api\/jobs\/([^/]+)\/retry$/.exec(path);
    if (retry && method === 'POST') {
      const job = find(retry[1]);
      if (!job) return { status: 404, data: { ok: false, error: { code: 'not_found', message: '任务不存在' } } };
      const next = { ...job, id: nowId(), status: 'queued', percent: 0, bytes: 0, total: 0,
        createdAt: Date.now(), error: undefined, finishedAt: undefined, path: undefined };
      jobs.unshift(next);
      save();
      enqueue(next);
      return { status: 202, data: { ok: true, job: next } };
    }

    const del = /^\/api\/jobs\/([^/]+)$/.exec(path);
    if (del && method === 'DELETE') {
      const job = find(del[1]);
      if (!job) return { status: 404, data: { ok: false, error: { code: 'not_found', message: '任务不存在' } } };
      if (job.status === 'running') {
        return { status: 409, data: { ok: false, error: { code: 'busy', message: '任务还在运行，先取消' } } };
      }
      jobs = jobs.filter((one) => one.id !== job.id);
      save();
      emit({ type: 'job-removed', ids: [job.id] });
      return ok({ removed: 1 });
    }

    if (path === '/api/components') {
      return ok({ components: { ytdlp: { installed: false, bytes: 0 } } });
    }

    if (path === '/api/settings') {
      if (method === 'POST') {
        if (body.theme) localStorage.setItem('vdl-theme', body.theme);
        return ok({ theme: body.theme || localStorage.getItem('vdl-theme') || 'light', limitRate: 0 });
      }
      return ok({ theme: localStorage.getItem('vdl-theme') || 'light', limitRate: 0, concurrency: 1 });
    }

    return unsupported(`本地引擎模式暂不支持：${path.split('?')[0]}`);
  }

  window.VDACC_API = {
    async request(token, path, opts = {}) {
      try {
        return await handle(path, opts);
      } catch (error) {
        return { status: 500, data: { ok: false, error: { code: 'internal', message: String((error && error.message) || error) } } };
      }
    },
  };

  jobs = load();
  save();
  // 上次没跑完的任务：load 已把可续传的置成 queued，这里按原来的先后（旧→新）接着跑。
  // 不弹窗、不打断：用户上次点过下载，这次只是把它做完。
  for (const job of jobs.slice().reverse()) {
    if (job.status === 'queued') enqueue(job);
  }
})();
