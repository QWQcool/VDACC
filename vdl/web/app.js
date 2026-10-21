/* VDACC Web UI —— 纯原生，无构建。
   安全：数据一律 textContent，绝不 innerHTML。 */
(() => {
  'use strict';

  const token = new URLSearchParams(location.search).get('token') || '';
  const $ = (s) => document.querySelector(s);

  const els = {
    url: $('#url'), probe: $('#probe'), result: $('#result'),
    jobs: $('#jobs'), empty: $('#jobs-empty'), outdir: $('#outdir'),
    status: $('#status'), theme: $('#theme'), ver: $('#ver'),
  };

  let current = null;      // 最近一次 probe 结果
  let picked = null;       // 选中档位 id
  const jobEls = new Map();

  // ---------------------------------------------------------------- 工具

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

  const fmtDur = (ms) => {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const fmtEta = (sec) => (sec === null || sec === undefined ? '' : `${sec}s`);

  function toast(msg) {
    els.status.textContent = msg;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { els.status.textContent = ''; }, 4000);
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      ...opts,
      headers: Object.assign({ 'X-VDL-Token': token }, (opts && opts.headers) || {}),
    });
    try { return await res.json(); } catch { return { ok: false, error: { code: 'bad_response', message: `HTTP ${res.status}` } }; }
  }

  // ---------------------------------------------------------------- 解析

  async function doProbe() {
    const url = els.url.value.trim();
    if (!url) return toast('先粘贴一个链接');
    els.probe.disabled = true;
    els.probe.textContent = '解析中';
    try {
      const r = await api('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      current = r;
      const list = r.formats || [];
      picked = (list.find((f) => f.recommended) || list[0] || {}).id || null;
      renderResult(r);
    } catch (e) {
      toast(`请求失败：${e.message}`);
    } finally {
      els.probe.disabled = false;
      els.probe.textContent = '解析';
    }
  }

  function renderResult(r) {
    els.result.textContent = '';
    els.result.classList.remove('hidden');

    if (!r.ok) {
      const e = r.error || {};
      const box = el('div', 'error-box');
      box.append(
        el('div', 'code', `[${e.code || 'error'}]`),
        el('div', 'msg', e.message || '解析失败'),
      );
      if (e.next_action) box.append(el('div', 'next', `下一步：${e.next_action}`));
      els.result.append(box);
      return;
    }

    const m = r.media;
    const media = el('div', 'media');
    if (m.thumbnail) {
      const img = el('img');
      img.src = m.thumbnail;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';   // 抖音图床会校验 Referer
      img.loading = 'lazy';
      media.append(img);
    }

    const meta = el('div', 'meta');
    meta.append(el('h3', '', m.title));
    meta.append(el('div', 'sub', [m.author || '未知作者', fmtDur(m.duration_ms), r.platform]
      .filter(Boolean).join(' · ')));

    if (m.source_url) {
      const tags = el('div', 'tags');
      tags.append(el('span', 'tag', m.id));
      tags.append(el('span', 'tag', r.engine));
      meta.append(tags);
    }
    media.append(meta);
    els.result.append(media);

    const list = el('div', 'formats');
    r.formats.forEach((f) => {
      const row = el('label', 'format-row' + (f.id === picked ? ' is-picked' : ''));
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'fmt';
      radio.value = f.id;
      radio.checked = f.id === picked;
      radio.addEventListener('change', () => {
        picked = f.id;
        [...list.children].forEach((c) => c.classList.toggle('is-picked', c.contains(radio)));
      });

      const text = el('div');
      text.append(el('div', 'name', f.label));
      text.append(el('div', 'desc', [
        f.width && f.height ? `${f.width}×${f.height}` : '',
        f.vcodec,
        f.fps ? `${f.fps}fps` : '',
        f.watermark ? '带水印' : '',
      ].filter(Boolean).join(' · ')));

      row.append(
        radio,
        text,
        el('span', 'size', f.bytes ? mb(f.bytes) : '未知'),
        el('span', 'tag', f.recommended ? '推荐' : ''),
      );
      list.append(row);
    });
    els.result.append(list);

    const actions = el('div', 'actions');
    const btn = el('button', 'primary', '下载');
    btn.id = 'download';
    btn.addEventListener('click', doDownload);
    actions.append(btn, el('span', 'hint', '多选在下一版；当前一次下一个档位'));
    els.result.append(actions);
  }

  // ---------------------------------------------------------------- 下载

  async function doDownload() {
    if (!current || !current.ok || !picked) return;
    const btn = $('#download');
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: (current.media && current.media.source_url) || els.url.value.trim(),
          formatId: picked,
        }),
      });
      if (!r.ok) toast((r.error && r.error.message) || '提交失败');
      else upsertJob(r.job);
    } catch (e) {
      toast(`提交失败：${e.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- 任务

  function buildJob(job) {
    const node = el('article', 'job');
    node.dataset.id = job.id;

    const head = el('div', 'job-head');
    const title = el('div', 'title', job.title || job.url);
    const state = el('span', 'state queued', '排队');
    const pct = el('span', 'pct', '0%');
    head.append(title, state, pct);

    const bar = el('div', 'bar');
    const fill = el('i');
    bar.append(fill);

    const foot = el('div', 'job-foot');
    const info = el('span', 'info', '');
    const reveal = el('button', 'link', '打开');
    reveal.addEventListener('click', () => {
      const path = node.dataset.path;
      if (!path) return;
      api('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
    });
    foot.append(info, spacer, reveal);

    node.append(head, bar, foot);
    node._refs = { title, state, pct, fill, info, reveal };
    return node;
  }

  function updateJob(node, job) {
    const r = node._refs;
    if (job.title) r.title.textContent = job.title;

    const labels = { queued: '排队', running: '下载中', done: '完成', failed: '失败' };
    r.state.className = `state ${job.status}`;
    r.state.textContent = labels[job.status] || job.status;

    const pct = job.status === 'done' ? 100 : (job.percent || 0);
    r.pct.textContent = `${pct}%`;
    r.fill.style.width = `${pct}%`;

    if (job.status === 'failed') {
      const e = job.error || {};
      r.info.textContent = `[${e.code || 'error'}] ${e.message || '失败'}`;
      r.fill.style.background = 'var(--danger)';
    } else if (job.status === 'done') {
      const size = job.bytes ? mb(job.bytes) : '';
      r.info.textContent = [size, job.path].filter(Boolean).join(' · ');
      r.fill.style.background = 'var(--ok)';
      r.reveal.classList.remove('hidden');
    } else {
      const bits = [];
      if (job.bytes) bits.push(job.total ? `${mb(job.bytes)} / ${mb(job.total)}` : mb(job.bytes));
      if (job.speed) bits.push(`${(job.speed / 1048576).toFixed(1)} MB/s`);
      if (job.eta) bits.push(`剩余 ${fmtEta(job.eta)}`);
      r.info.textContent = bits.join(' · ');
    }

    if (job.path) node.dataset.path = job.path;
  }

  function upsertJob(job) {
    let node = jobEls.get(job.id);
    if (!node) {
      node = buildJob(job);
      jobEls.set(job.id, node);
      els.jobs.prepend(node);
    }
    updateJob(node, job);
    els.empty.classList.toggle('hidden', jobEls.size > 0);
  }

  // ---------------------------------------------------------------- 实时

  function connect() {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'job') upsertJob(data.job);
      } catch { /* 忽略畸形事件 */ }
    };
  }

  async function boot() {
    const health = await api('/api/health', { method: 'GET' });
    if (health.ok) {
      els.outdir.textContent = `输出目录：${health.outDir}`;
      els.ver.textContent = `v${health.version}`;
    } else {
      toast('token 无效：请用启动时打印的完整地址打开');
    }

    const saved = localStorage.getItem('vdl-theme');
    if (saved) document.documentElement.dataset.theme = saved;
    els.theme.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('vdl-theme', next);
    });

    els.probe.addEventListener('click', doProbe);
    els.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') doProbe(); });

    const list = await api('/api/jobs', { method: 'GET' });
    if (list.ok) list.jobs.slice().reverse().forEach(upsertJob);

    connect();
  }

  boot();
})();
