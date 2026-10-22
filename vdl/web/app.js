/* VDACC Web UI —— 纯原生，无构建。
   安全：所有服务端数据一律 textContent，绝不 innerHTML。 */
(() => {
  'use strict';

  // PWA 从桌面图标启动时没有 ?token=，所以首次带 token 打开后要记住
  const queryToken = new URLSearchParams(location.search).get('token') || '';
  const token = queryToken || localStorage.getItem('vdl-token') || '';
  if (token) localStorage.setItem('vdl-token', token);
  const $ = (s) => document.querySelector(s);

  const els = {
    url: $('#url'), probe: $('#probe'), result: $('#result'),
    chips: $('#chips'), jobsSection: $('#jobs-section'), jobs: $('#jobs'),
    empty: $('#empty'), outdir: $('#outdir'), status: $('#status'),
    theme: $('#theme'), ver: $('#ver'), clearDone: $('#clear-done'),
    doneBanner: $('#done-banner'), doneText: $('#done-text'),
    preview: $('#preview'), previewVideo: $('#preview-video'),
    previewClose: $('#preview-close'), previewTitle: $('#preview-title'),
  };

  let current = null;              // 最近一次 probe 结果
  const selected = new Set();      // 选中的档位 id
  const jobEls = new Map();
  let probing = false;

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

  function toast(msg) {
    els.status.textContent = msg;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { els.status.textContent = ''; }, 4200);
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      ...opts,
      headers: Object.assign({ 'X-VDL-Token': token }, (opts && opts.headers) || {}),
    });
    try {
      return await res.json();
    } catch {
      return { ok: false, error: { code: 'bad_response', message: `HTTP ${res.status}` } };
    }
  }

  // ---------------------------------------------------------------- 解析

  async function doProbe() {
    const url = els.url.value.trim();
    if (!url || probing) return;
    if (!url) return toast('先粘贴一个链接');

    probing = true;
    els.probe.disabled = true;
    els.probe.textContent = '解析中';
    els.url.disabled = true;
    els.result.classList.remove('hidden');
    els.result.textContent = '正在解析…';

    try {
      const r = await api('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      current = r;
      selected.clear();
      if (r.ok) {
        const rec = r.formats.find((f) => f.recommended) || r.formats[0];
        if (rec) selected.add(rec.id);
      }
      renderResult(r);
    } catch (e) {
      toast(`请求失败：${e.message}`);
      els.result.textContent = '';
      els.result.classList.add('hidden');
    } finally {
      probing = false;
      els.probe.disabled = false;
      els.probe.textContent = '解析';
      els.url.disabled = false;
    }
  }

  function renderResult(r) {
    els.result.textContent = '';
    els.chips.textContent = '';
    els.chips.classList.add('hidden');

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

    // ---- 媒体卡
    const m = r.media;
    const media = el('div', 'media');
    if (m.thumbnail) {
      const img = el('img', 'thumb');
      img.src = m.thumbnail;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';      // 抖音图床会校验 Referer
      img.loading = 'lazy';
      media.append(img);
    }

    const meta = el('div', 'meta');
    meta.append(el('h3', '', m.title));
    meta.append(el('div', 'sub', [m.author || '未知作者', fmtDur(m.duration_ms)]
      .filter(Boolean).join(' · ')));

    const tags = el('div', 'tags');
    tags.append(el('span', 'tag accent', r.platform));
    tags.append(el('span', 'tag', r.engine));
    tags.append(el('span', 'tag', m.id));
    meta.append(tags);

    // 多P/合集：切换后重新解析（URL 带 ?p=N）
    if (m.parts && m.parts.length > 1) {
      const picker = el('select', 'part-select');
      m.parts.forEach((p) => {
        const opt = el('option', '', `P${p.index} ${p.title}`);
        opt.value = p.url;
        opt.selected = !!p.selected;
        picker.append(opt);
      });
      picker.addEventListener('change', () => {
        els.url.value = picker.value;
        doProbe();
      });
      meta.append(picker);
    }

    media.append(meta);
    els.result.append(media);

    // ---- 画质 chips（与列表勾选双向同步）
    renderChips(r.formats);

    // ---- 素材列表
    const list = el('div', 'materials');
    r.formats.forEach((f) => {
      const row = el('label', 'material');
      row.dataset.id = f.id;

      const box = el('input');
      box.type = 'checkbox';
      box.checked = selected.has(f.id);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(f.id); else selected.delete(f.id);
        row.classList.toggle('is-picked', box.checked);
        syncChips();
        syncActions();
      });
      row.classList.toggle('is-picked', box.checked);

      const text = el('div');
      text.append(el('div', 'title', f.label));
      text.append(el('div', 'desc', [
        f.width && f.height ? `${f.width}×${f.height}` : '',
        f.vcodec,
        f.fps ? `${f.fps}fps` : '',
        f.watermark ? '带水印' : '',
      ].filter(Boolean).join(' · ')));

      const size = el('span', 'size', f.bytes ? mb(f.bytes) : '未知');

      const prev = el('button', 'preview-btn', '预览');
      prev.type = 'button';
      prev.addEventListener('click', (e) => { e.preventDefault(); preview(f.id); });

      row.append(box, text, size, prev);
      list.append(row);
    });
    els.result.append(list);

    // ---- 动作
    const actions = el('div', 'actions');
    const all = el('button', 'link', '全选');
    all.type = 'button';
    all.addEventListener('click', () => {
      const allOn = selected.size === r.formats.length;
      selected.clear();
      if (!allOn) r.formats.forEach((f) => selected.add(f.id));
      [...list.children].forEach((row) => {
        const box = row.querySelector('input');
        box.checked = selected.has(row.dataset.id);
        row.classList.toggle('is-picked', box.checked);
      });
      all.textContent = allOn ? '全选' : '清空';
      syncChips();
      syncActions();
    });

    if (r.formats.some((f) => (f.subtitles || []).length)) {
      const lab = el('label', 'subs');
      const box = el('input');
      box.type = 'checkbox';
      box.id = 'subs-box';
      box.checked = true;
      lab.append(box, el('span', '', '字幕'));
      actions.append(lab);
    }

    if (m.thumbnail) {
      const lab = el('label', 'subs');
      const box = el('input');
      box.type = 'checkbox';
      box.id = 'cover-box';
      box.checked = true;
      lab.append(box, el('span', '', '封面'));
      actions.append(lab);
    }

    const spacer = el('span', 'spacer');
    const go = el('button', 'primary', '下载选中');
    go.id = 'download';
    go.addEventListener('click', submitSelected);

    actions.append(all, spacer, go);
    els.result.append(actions);
    syncActions();
  }

  function renderChips(formats) {
    els.chips.textContent = '';
    formats.forEach((f) => {
      const chip = el('button', 'chip', f.label);
      chip.type = 'button';
      chip.dataset.id = f.id;
      chip.setAttribute('aria-pressed', selected.has(f.id) ? 'true' : 'false');
      chip.append(el('small', '', f.bytes ? mb(f.bytes) : ''));
      chip.addEventListener('click', () => {
        if (selected.has(f.id)) selected.delete(f.id); else selected.add(f.id);
        [...els.result.querySelectorAll('.material')].forEach((row) => {
          if (row.dataset.id === f.id) {
            const box = row.querySelector('input');
            box.checked = selected.has(f.id);
            row.classList.toggle('is-picked', box.checked);
          }
        });
        syncChips();
        syncActions();
      });
      els.chips.append(chip);
    });
    els.chips.classList.toggle('hidden', formats.length === 0);
  }

  function syncChips() {
    [...els.chips.children].forEach((chip) => {
      chip.setAttribute('aria-pressed', selected.has(chip.dataset.id) ? 'true' : 'false');
    });
  }

  function syncActions() {
    const go = $('#download');
    if (!go) return;
    go.disabled = selected.size === 0;
    go.textContent = selected.size ? `下载选中 (${selected.size})` : '下载选中';
  }

  // ---------------------------------------------------------------- 下载

  async function submitSelected() {
    if (!current || !current.ok || selected.size === 0) return;
    const btn = $('#download');
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: (current.media && current.media.source_url) || els.url.value.trim(),
          formatIds: [...selected],
          subs: !!(document.getElementById('subs-box') || {}).checked,
          cover: !!(document.getElementById('cover-box') || {}).checked,
        }),
      });
      if (!r.ok) {
        toast((r.error && r.error.message) || '提交失败');
      } else {
        (r.jobs || [r.job]).forEach(upsertJob);
        toast(`已提交 ${(r.jobs || []).length} 个任务`);
      }
    } catch (e) {
      toast(`提交失败：${e.message}`);
    } finally {
      if (btn) syncActions();
    }
  }

  // ---------------------------------------------------------------- 预览

  async function preview(formatId) {
    const r = await api('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: (current.media && current.media.source_url) || els.url.value.trim(),
        formatId,
      }),
    });
    if (!r.ok) {
      const e = r.error || {};
      return toast(`预览失败 [${e.code || 'error'}] ${e.message || ''}`);
    }
    els.previewTitle.textContent = `预览 · ${r.formatId}`;
    els.previewVideo.src = r.url;
    els.preview.showModal();
    els.previewVideo.play().catch(() => { /* 自动播放被拦就等用户点 */ });
  }

  function closePreview() {
    els.previewVideo.pause();
    els.previewVideo.removeAttribute('src');
    els.previewVideo.load();
    els.preview.close();
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
    const save = el('button', 'link hidden', '下载');
    save.type = 'button';
    save.addEventListener('click', () => {
      // 走了 token 才能取；手机/其它设备也可用这个链接
      window.open(`/api/files/${job.id}?token=${encodeURIComponent(token)}`, '_blank');
    });
    const cancel = el('button', 'link hidden', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      api(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    });
    const retry = el('button', 'link hidden', '重试');
    retry.type = 'button';
    retry.addEventListener('click', async () => {
      const r = await api(`/api/jobs/${job.id}/retry`, { method: 'POST' });
      if (r.ok && r.job) upsertJob(r.job);
    });
    const reveal = el('button', 'link', '打开');
    reveal.type = 'button';
    reveal.addEventListener('click', () => {
      if (node.dataset.path) {
        api('/api/reveal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: node.dataset.path }),
        });
      }
    });
    foot.append(info, save, cancel, retry, reveal);

    node.append(head, bar, foot);
    node._refs = { title, state, pct, fill, info, save, cancel, retry, reveal };
    return node;
  }

  function updateJob(node, job) {
    const r = node._refs;
    if (job.title) r.title.textContent = job.title;

    const labels = { queued: '排队', running: '下载中', done: '完成',
                     failed: '失败', cancelled: '已取消' };
    const active = job.status === 'queued' || job.status === 'running';
    r.state.className = `state ${job.status}`;
    r.state.textContent = labels[job.status] || job.status;
    r.cancel.classList.toggle('hidden', !active);
    r.retry.classList.toggle('hidden',
      !(job.status === 'failed' || job.status === 'cancelled'));
    r.reveal.classList.toggle('hidden', job.status !== 'done');
    r.save.classList.toggle('hidden', job.status !== 'done');

    const pct = job.status === 'done' ? 100 : (job.percent || 0);
    r.pct.textContent = `${pct}%`;
    r.fill.style.width = `${pct}%`;

    if (job.status === 'failed') {
      const e = job.error || {};
      r.info.textContent = `[${e.code || 'error'}] ${e.message || '失败'}`;
      r.fill.style.background = 'var(--danger)';
    } else if (job.status === 'done') {
      r.info.textContent = [job.bytes ? mb(job.bytes) : '', job.path]
        .filter(Boolean).join(' · ');
      r.fill.style.background = 'var(--ok)';
      r.save.classList.remove('hidden');
      if (node.dataset.state !== 'done') showDoneBanner(job);
    } else {
      const bits = [];
      if (job.bytes) bits.push(job.total ? `${mb(job.bytes)} / ${mb(job.total)}` : mb(job.bytes));
      if (job.speed) bits.push(`${(job.speed / 1048576).toFixed(1)} MB/s`);
      if (job.eta) bits.push(`剩余 ${job.eta}s`);
      r.info.textContent = bits.join(' · ');
      r.fill.style.background = 'var(--accent)';
    }

    if (job.path) node.dataset.path = job.path;
    node.dataset.state = job.status;
  }

  function upsertJob(job) {
    let node = jobEls.get(job.id);
    if (!node) {
      node = buildJob(job);
      jobEls.set(job.id, node);
      els.jobs.prepend(node);
    }
    updateJob(node, job);
    const has = jobEls.size > 0;
    els.empty.classList.toggle('hidden', has);
    els.jobsSection.classList.toggle('hidden', !has);
  }

  function showDoneBanner(job) {
    els.doneText.textContent = [job.title, job.bytes ? mb(job.bytes) : '']
      .filter(Boolean).join(' · ');
    els.doneBanner.classList.remove('hidden');
    clearTimeout(showDoneBanner._t);
    showDoneBanner._t = setTimeout(() => els.doneBanner.classList.add('hidden'), 5000);
  }

  // ---------------------------------------------------------------- 启动

  function connect() {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'job') upsertJob(data.job);
      } catch { /* 忽略畸形事件 */ }
    };
  }

  function showGate() {
    const gate = $('#gate');
    gate.classList.remove('hidden');
    document.querySelector('.input-card').classList.add('hidden');
    els.empty.classList.add('hidden');
    els.jobsSection.classList.add('hidden');

    const input = $('#gate-token');
    const go = () => {
      const value = input.value.trim();
      if (!value) return;
      localStorage.setItem('vdl-token', value);
      location.replace('/');
    };
    $('#gate-go').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    input.focus();
  }

  async function boot() {
    if (!token) {
      showGate();
      return;
    }

    const health = await api('/api/health', { method: 'GET' });
    if (health.ok) {
      els.outdir.textContent = `输出目录：${health.outDir}`;
      els.ver.textContent = `v${health.version}`;
    } else {
      localStorage.removeItem('vdl-token');
      showGate();
      return;
    }

    // 优先级：用户上次在前端切的主题 > 服务端配置 > 浅色
    const saved = localStorage.getItem('vdl-theme');
    document.documentElement.dataset.theme =
      saved || (health.ok && health.theme) || 'light';
    els.theme.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('vdl-theme', next);
    });

    els.probe.addEventListener('click', doProbe);
    els.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') doProbe(); });

    els.clearDone.addEventListener('click', () => {
      [...jobEls.entries()].forEach(([id, node]) => {
        if (node.dataset.state === 'done' || node.dataset.state === 'failed') {
          node.remove();
          jobEls.delete(id);
        }
      });
      const has = jobEls.size > 0;
      els.empty.classList.toggle('hidden', has);
      els.jobsSection.classList.toggle('hidden', !has);
    });

    els.previewClose.addEventListener('click', closePreview);
    els.preview.addEventListener('cancel', (e) => { e.preventDefault(); closePreview(); });
    els.previewVideo.addEventListener('error', () => {
      // FLAC 之类的音频浏览器多半解不了；如实提示，不假装在加载
      if (els.previewVideo.getAttribute('src')) {
        toast('这个格式浏览器可能无法预览（如 FLAC），下载后用本地播放器打开');
      }
    });

    const list = await api('/api/jobs', { method: 'GET' });
    if (list.ok) list.jobs.slice().reverse().forEach(upsertJob);

    connect();

    // PWA：只在 https / localhost 生效（局域网 http 下浏览器会拒绝）
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    // 深链：?url=... 自动解析（方便测试与分享）
    const pre = new URLSearchParams(location.search).get('url');
    if (pre) {
      els.url.value = pre;
      doProbe();
    }
  }

  // ---- 设置面板（TS 后端才有 /api/settings；legacy 会 404） ----
  const settingsBtn = document.getElementById('settings');
  const settingsDlg = document.getElementById('settings-dialog');
  if (settingsBtn && settingsDlg) {
    const ref = (id) => document.getElementById(id);

    const refreshComponents = async () => {
      const box = ref('comp-status');
      const r = await api('/api/components', { method: 'GET' });
      if (!r.ok) { box.textContent = '当前后端不支持组件管理'; return; }
      const y = r.components.ytdlp;
      box.textContent = y.installed
        ? `通用组件已安装（${(y.bytes / 1048576).toFixed(1)} MB）`
        : '通用组件未安装';
      ref('comp-install').textContent = y.installed ? '重新下载' : '下载组件';
    };

    settingsBtn.addEventListener('click', async () => {
      const r = await api('/api/settings', { method: 'GET' });
      if (!r.ok) { toast('当前后端不支持设置（legacy Python）'); return; }
      const s = r.settings || {};
      ref('set-out').value = s.outDir || '';
      ref('set-theme').value = s.theme || 'light';
      ref('set-concurrency').value = String(s.concurrency || 1);
      ref('set-generic').checked = !!s.allowGeneric;
      settingsDlg.showModal();
      refreshComponents();
    });

    ref('settings-close').addEventListener('click', () => settingsDlg.close());

    ref('set-save').addEventListener('click', async () => {
      const theme = ref('set-theme').value;
      const r = await api('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outDir: ref('set-out').value.trim(),
          theme,
          concurrency: Number(ref('set-concurrency').value),
          allowGeneric: ref('set-generic').checked,
        }),
      });
      if (r.ok) {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('vdl-theme', theme);
        toast('设置已保存');
        settingsDlg.close();
      } else {
        toast(r.error?.message || '保存失败');
      }
    });

    ref('comp-install').addEventListener('click', async () => {
      const btn = ref('comp-install');
      btn.disabled = true;
      btn.textContent = '下载中…';
      const r = await api('/api/components/ytdlp/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      btn.disabled = false;
      toast(r.ok ? `组件已安装（${(r.bytes / 1048576).toFixed(1)} MB）`
        : (r.error?.message || '下载失败'));
      refreshComponents();
    });
  }

  boot();
})();
