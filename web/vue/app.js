/* Vue 3 迁移切片：无构建，直接由服务端托管。与旧版共用 /api 契约。 */
const I18N = window.VDACC_I18N;

const { createApp, ref, computed, watch, nextTick, onMounted, onBeforeUnmount } = Vue;

createApp({
  setup() {
    const token = new URLSearchParams(location.search).get('token') ||
      localStorage.getItem('vdl-token') || '';
    if (token) localStorage.setItem('vdl-token', token);

    const lang = ref(localStorage.getItem('vdl-lang') || 'zh');
    const t = (key) => (I18N[lang.value] && I18N[lang.value][key]) || key;

    const url = ref(new URLSearchParams(location.search).get('url') || '');
    const partUrl = ref('');
    const result = ref(null);
    const selected = ref([]);
    const jobs = ref([]);
    const busy = ref(false);
    const submitting = ref(false);
    const reconnecting = ref(false);
    const settingsError = ref('');
    const message = ref('');
    const version = ref('');
    const connected = ref(false);
    // 右栏「运行状态」用：/api/health 里已经带了 outDir 与 limitRate
    const outDir = ref('');
    const limitRate = ref(0);
    const withCover = ref(true);
    // 附属产物开关：只对 B站 生效，持久化免得每次重开都要勾
    const withSubs = ref(localStorage.getItem('vdl-subs') === '1');
    const withDanmaku = ref(localStorage.getItem('vdl-danmaku') === '1');
    // 专辑：与单条结果互斥，独立走 /api/album；默认一首都不勾（防误点整张专辑）
    const album = ref(null);
    const albumTracks = ref([]);
    const checkedTracks = ref([]);
    const loadingMore = ref(false);
    const allTracks = computed(() =>
      albumTracks.value.length > 0 && checkedTracks.value.length === albumTracks.value.length);
    const settingsOpen = ref(false);
    const sOutDir = ref('');
    const sTheme = ref('light');
    // 限速用 MB/s 呈现（后端是字节/秒）；空串 = 不限速
    const sLimitRateMB = ref('');
    const sConcurrency = ref(1);
    const sGeneric = ref(false);
    const compStatus = ref('');
    const compBusy = ref(false);
    const previewUrl = ref('');
    // 账号状态（/api/auth）：本地凭据 + 在线校验结果
    const authRows = ref([]);
    const authBusy = ref(false);
    const checkedParts = ref([]);
    const isBatch = computed(() =>
      !!(result.value && result.value.media.parts.length > 1));
    const allChecked = computed(() =>
      isBatch.value && checkedParts.value.length === result.value.media.parts.length);
    const someChecked = computed(() =>
      checkedParts.value.length > 0 && !allChecked.value);
    const estimated = computed(() => {
      const fmt = result.value && result.value.formats.find((f) => f.id === selected.value[0]);
      return fmt && fmt.bytes ? fmt.bytes * checkedParts.value.length : 0;
    });
    // 任务按状态分组：进行中置顶，已结束在后；组内保持原有先后
    const activeJobs = computed(() =>
      jobs.value.filter((j) => j.status === 'running' || j.status === 'queued'));
    const finishedJobs = computed(() =>
      jobs.value.filter((j) => j.status !== 'running' && j.status !== 'queued'));
    const orderedJobs = computed(() => [...activeJobs.value, ...finishedJobs.value]);

    const size = (bytes) => {
      if (!bytes) return '—';
      return bytes >= 1048576
        ? `${(bytes / 1048576).toFixed(2)} MB`
        : `${(bytes / 1024).toFixed(0)} KB`;
    };
    const dur = (ms) => {
      if (!ms) return '';
      const total = Math.round(ms / 1000);
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    };

    const rateText = computed(() => {
      if (!limitRate.value) return t('unlimited');
      const mb = limitRate.value / 1048576;
      return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(limitRate.value / 1024)} KB/s`;
    });

    // 平台标签的语义色：B站粉、抖音蓝、音乐紫、嗅探/其它中性
    const platformClass = (p) => ({
      bilibili: 'accent', douyin: 'sky',
      netease: 'purple', qq: 'purple', kuwo: 'purple', kugou: 'purple',
      sniff: 'sky',
    }[p] || 'neutral');

    // 任务标题：优先用落盘文件名（去掉目录与扩展名），没有就退回清晰度/ID
    const jobName = (j) => {
      const p = j && j.path ? String(j.path) : '';
      if (!p) return (j && (j.formatId || j.id)) || '';
      const base = p.split(/[\\/]/).pop() || p;
      return base.replace(/\.[a-z0-9]{2,5}$/i, '');
    };

    function toggleAll() {
      if (!result.value) return;
      const parts = result.value.media.parts;
      checkedParts.value = allChecked.value ? [] : parts.slice(0, 20).map((p) => p.index);
    }

    function togglePart(index) {
      const at = checkedParts.value.indexOf(index);
      if (at >= 0) { checkedParts.value.splice(at, 1); return; }
      if (checkedParts.value.length >= 20) { message.value = t('limitHint'); return; }
      checkedParts.value.push(index);
    }
    const statusLabel = (status) => ({
      queued: t('queued_s'), running: t('running'),
      done: t('done'), failed: t('failed'), cancelled: t('cancelled'),
    }[status] || status);

    async function api(path, opts = {}) {
      try {
        const res = await fetch(path, {
          method: opts.method || 'GET',
          headers: Object.assign({ 'X-VDL-Token': token }, opts.headers || {}),
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        if (res.status === 401) connected.value = false;
        try { return await res.json(); }
        catch { return { ok: false, error: { message: `HTTP ${res.status}` } }; }
      } catch {
        // 单次接口失败不等于 SSE 已断开；在线状态以持有的连接为准。
        if (!events || events.readyState !== EventSource.OPEN) connected.value = false;
        return { ok: false, error: { code: 'network_error', message: t('networkError') } };
      }
    }

    const errorText = (data) => [data?.error?.message, data?.error?.next_action].filter(Boolean).join(' · ') || t('failed');

    function toggleLang() {
      lang.value = lang.value === 'zh' ? 'en' : 'zh';
      localStorage.setItem('vdl-lang', lang.value);
    }

    function toggleTheme() {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('vdl-theme', next);
    }

    function toggleFormat(id) {
      const at = selected.value.indexOf(id);
      if (at >= 0) selected.value.splice(at, 1);
      else selected.value.push(id);
    }

    const isAlbumUrl = (value) =>
      /music\.163\.com\/(?:#\/)?album/i.test(value) || /y\.qq\.com\/.*albumDetail/i.test(value);

    async function probeUrl(target) {
      const value = (target || url.value).trim();
      if (!value || busy.value || submitting.value) return;
      busy.value = true;
      message.value = '';

      // 专辑链接：先列曲目（上限 20），再按勾选逐首建任务
      if (isAlbumUrl(value)) {
        const data = await api('/api/album', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { url: value },
        });
        busy.value = false;
        if (!data.ok) {
          message.value = errorText(data);
          return;
        }
        // dropped / hasMore 在响应顶层，挂到 album 上给模板用（分批必须让用户看到）
        album.value = {
          ...data.album,
          dropped: data.dropped || 0,
          hasMore: !!data.hasMore,
          nextOffset: data.nextOffset || 0,
        };
        albumTracks.value = data.tracks || [];
        checkedTracks.value = [];
        result.value = null;
        selected.value = [];
        url.value = value;
        return;
      }
      album.value = null;
      albumTracks.value = [];
      checkedTracks.value = [];

      const data = await api('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { url: value },
      });
      busy.value = false;
      if (!data.ok) {
        message.value = errorText(data);
        return;
      }
      result.value = data;
      url.value = value;
      partUrl.value = data.media.source_url || value;
      selected.value = data.formats.filter((f) => f.available && f.recommended).map((f) => f.id);
      if (!selected.value.length) {
        selected.value = data.formats.filter((f) => f.available).slice(0, 1).map((f) => f.id);
      }
      checkedParts.value = data.media.parts.length > 1
        ? (data.media.parts.length <= 20 ? data.media.parts.map((p) => p.index) : [])
        : [];
    }

    const probe = () => probeUrl(url.value);
    const probePart = () => probeUrl(partUrl.value);

    function toggleTrack(id) {
      const at = checkedTracks.value.indexOf(id);
      if (at >= 0) { checkedTracks.value.splice(at, 1); return; }
      checkedTracks.value.push(id);
    }

    function toggleAllTracks() {
      checkedTracks.value = allTracks.value ? [] : albumTracks.value.map((x) => x.id);
    }

    /** 专辑超过 20 首时按批追加；已勾选的曲目保留，不清空用户的选择。 */
    async function loadMoreTracks() {
      if (!album.value || !album.value.hasMore || loadingMore.value) return;
      loadingMore.value = true;
      const data = await api('/api/album', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { url: url.value, offset: album.value.nextOffset },
      });
      loadingMore.value = false;
      if (!data.ok) {
        message.value = (data.error && data.error.message) || 'failed';
        return;
      }
      const known = new Set(albumTracks.value.map((t) => t.id));
      const added = (data.tracks || []).filter((t) => !known.has(t.id));
      albumTracks.value = [...albumTracks.value, ...added];
      album.value = {
        ...album.value,
        dropped: data.dropped || 0,
        hasMore: !!data.hasMore,
        nextOffset: data.nextOffset || albumTracks.value.length,
      };
    }

    async function download() {
      if (submitting.value || busy.value) return;
      const requests = [];
      const platform = result.value?.platform;
      const sidecars = {
        cover: withCover.value && ['douyin', 'bilibili'].includes(platform),
        subs: withSubs.value && platform === 'bilibili',
        danmaku: withDanmaku.value && platform === 'bilibili',
      };
      if (album.value) {
        // 音乐封面由引擎内嵌；独立视频封面开关不冒充音乐 sidecar 能力。
        for (const track of albumTracks.value.filter((x) => checkedTracks.value.includes(x.id))) {
          requests.push({ url: track.url, formatIds: [''] });
        }
      } else if (result.value && selected.value.length) {
        if (isBatch.value) {
          const parts = result.value.media.parts.filter((p) => checkedParts.value.includes(p.index));
          for (const part of parts) requests.push({ url: part.url, formatIds: [selected.value[0]], ...sidecars });
        } else {
          requests.push({ url: result.value.media.source_url || url.value, formatIds: [...selected.value], ...sidecars });
        }
      }
      if (!requests.length) return;
      submitting.value = true;
      let ok = 0;
      let deduped = 0;
      const errors = [];
      try {
        for (const body of requests) {
          const data = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          if (data.ok) {
            for (const job of data.jobs || []) upsert(job);
            // 后端遇到「同链接 + 同档位已在队列」会复用原任务，这里只提示，不重复计数
            deduped += (data.reused || []).length;
            ok += 1;
          } else errors.push(errorText(data));
        }
        message.value = `${t('queued')} ${ok}/${requests.length}`
          + (deduped ? ` · ${t('deduped')} ${deduped}` : '')
          + (errors.length ? ` · ${[...new Set(errors)].join('；')}` : '');
      } finally {
        submitting.value = false;
      }
    }

    function persistSidecars() {
      localStorage.setItem('vdl-subs', withSubs.value ? '1' : '0');
      localStorage.setItem('vdl-danmaku', withDanmaku.value ? '1' : '0');
    }

    function upsert(job) {
      if (!job) return;
      const at = jobs.value.findIndex((j) => j.id === job.id);
      // 快速完成的 SSE 可能先于提交响应到达；迟到的 queued/running 快照不能覆盖终态。
      if (at >= 0 && ['done', 'failed', 'cancelled'].includes(jobs.value[at].status)
          && ['queued', 'running'].includes(job.status)) return;
      if (at >= 0) jobs.value[at] = job;
      else jobs.value.unshift(job);
    }

    async function cancel(id) {
      const data = await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
      if (data.ok) upsert(data.job);
      else message.value = errorText(data);
    }
    async function retry(id) {
      const data = await api(`/api/jobs/${id}/retry`, { method: 'POST' });
      if (data.ok) upsert(data.job);
      else message.value = errorText(data);
    }

    async function refreshComponents() {
      const data = await api('/api/components');
      if (!data.ok) { compStatus.value = t('notSupported'); return; }
      const y = data.components.ytdlp;
      compStatus.value = y.installed
        ? `${t('installed')}（${(y.bytes / 1048576).toFixed(1)} MB）`
        : t('notInstalled');
    }

    async function openSettings() {
      const data = await api('/api/settings');
      if (!data.ok) { message.value = t('notSupported'); return; }
      settingsError.value = '';
      const s = data.settings || {};
      sOutDir.value = s.outDir || '';
      sTheme.value = s.theme || 'light';
      sLimitRateMB.value = s.limitRate
        ? String(Number((s.limitRate / 1048576).toFixed(2)))
        : '';
      sConcurrency.value = s.concurrency || 1;
      sGeneric.value = !!s.allowGeneric;
      await refreshComponents();
      // 在线校验要打三个站点，别阻塞面板打开
      loadAuth();
      settingsOpen.value = true;

    }

    async function saveSettings() {
      // 空/0 = 不限速；后端存字节/秒
      const mb = Number(sLimitRateMB.value);
      if (!Number.isFinite(mb) || mb < 0 || !Number.isSafeInteger(Math.round(mb * 1048576))) {
        settingsError.value = t('invalidLimit'); return;
      }
      settingsError.value = '';
      // 别叫 limitRate：会遮蔽外面的 ref，赋值静默失效（这里踩过）
      const limitBytes = Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1048576) : 0;
      const data = await api('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: {
          outDir: sOutDir.value.trim(), theme: sTheme.value,
          concurrency: sConcurrency.value, allowGeneric: sGeneric.value,
          limitRate: limitBytes,
        },
      });
      if (!data.ok) { settingsError.value = errorText(data); return; }
      document.documentElement.dataset.theme = sTheme.value;
      localStorage.setItem('vdl-theme', sTheme.value);
      limitRate.value = (data.settings && data.settings.limitRate) || limitBytes;
      settingsOpen.value = false;
      message.value = t('saved');
    }

    async function installComponent() {
      compBusy.value = true;
      const data = await api('/api/components/ytdlp/install', { method: 'POST' });
      compBusy.value = false;
      if (data.ok) sGeneric.value = true;
      message.value = data.ok ? t('installed') : ((data.error && data.error.message) || 'failed');
      await refreshComponents();
    }

    async function previewSelected() {
      if (!result.value || !selected.value.length) return;
      const data = await api('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          url: result.value.media.source_url || url.value,
          formatId: selected.value[0],
        },
      });
      if (data.ok) previewUrl.value = data.url;
      else message.value = errorText(data);
    }

    async function loadAuth() {
      authBusy.value = true;
      const data = await api('/api/auth');
      authBusy.value = false;
      if (data.ok) authRows.value = data.sites || [];
      else message.value = (data.error && data.error.message) || 'failed';
    }

    async function loginSite(site) {
      const data = await api(`/api/auth/${site}/login`, { method: 'POST' });
      message.value = data.message || (data.ok ? t('login') : 'failed');
      if (data.ok && data.started) {
        // 扫码在电脑上完成，这里过几秒自动刷新一次，用户也可以手动点刷新
        setTimeout(() => { loadAuth(); }, 6000);
      }
    }

    const authBadge = (a) => (a.online && a.online.ok ? 'ok'
      : a.online && a.online.ok === false ? 'fail' : 'neutral');
    const authText = (a) => {
      if (a.online && a.online.ok) {
        return `${t('authOk')}${a.online.message ? ` · ${a.online.message}` : ''}`;
      }
      if (a.online && a.online.ok === false) return t('authBad');
      return a.loggedIn ? t('authUnchecked') : t('authNone');
    };

    /** 只有 B站 的成品任务才有附属可重取。 */
    const isBiliJob = (j) => /bilibili\.com|b23\.tv|^BV[0-9A-Za-z]{10}$/.test(String(j.url || ''));

    async function refetchJobSidecars(job) {
      const data = await api(`/api/jobs/${job.id}/sidecar`, { method: 'POST' });
      if (data.ok) {
        upsert(data.job);
        message.value = `${t('sidecarDone')}：${data.srtCount || 0} / ${data.danmakuCount || 0}`;
      } else {
        message.value = (data.error && data.error.message) || 'failed';
      }
    }

    function previewJob(job) {
      if (!job.path) return;
      previewUrl.value = `/api/preview?token=${encodeURIComponent(token)}&path=${encodeURIComponent(job.path)}`;
    }
    function closePreview() { previewUrl.value = ''; }

    // 同一套浮层焦点规则用于设置和预览；背景 inert 防止 Tab 和读屏越过面板。
    let returnFocus = null;
    const activeDialog = () => document.querySelector(previewUrl.value ? '.preview-box' : '.slideover');
    const closeOverlays = () => {
      if (previewUrl.value) { previewUrl.value = ''; return; }
      settingsOpen.value = false;
    };
    const onKeydown = (e) => {
      if (!settingsOpen.value && !previewUrl.value) return;
      if (e.key === 'Escape') { e.preventDefault(); closeOverlays(); }
      if (e.key !== 'Tab') return;
      const nodes = [...(activeDialog()?.querySelectorAll('button:not(:disabled), input:not(:disabled), select, a[href], video[controls]') || [])]
        .filter((el) => el.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    watch([settingsOpen, previewUrl], async ([s, p], [wasSettings, wasPreview]) => {
      const opened = s || p;
      if (opened && !wasSettings && !wasPreview) returnFocus = document.activeElement;
      document.body.style.overflow = opened ? 'hidden' : '';
      document.querySelector('.app').inert = !!opened;
      await nextTick();
      if (s || p) activeDialog()?.querySelector('button')?.focus();
      else if (returnFocus?.isConnected) returnFocus.focus();
    });

    let events = null;
    onMounted(async () => {
      window.addEventListener('keydown', onKeydown);
      document.documentElement.dataset.theme =
        localStorage.getItem('vdl-theme') || 'light';
      if (!token) {
        message.value = t('needToken');
        return;
      }
      const health = await api('/api/health');
      if (health.ok) {
        version.value = health.version;
        connected.value = true;
        outDir.value = health.outDir || '';
        limitRate.value = health.limitRate || 0;
        document.documentElement.dataset.theme =
          localStorage.getItem('vdl-theme') || health.theme || 'light';
      } else {
        // 带了 token 却被拒，不能说成「缺少 token」——通常是服务重启换了新 token
        message.value = t(token ? 'badToken' : 'needToken');
        return;
      }
      // 右栏要显示组件状态，挂载时就查一次（不必等用户打开设置）
      refreshComponents();
      const list = await api('/api/jobs');
      if (list.ok) {
        jobs.value = (list.jobs || []).slice().reverse();
        if (list.warnings?.length) message.value = list.warnings.join('；');
      }
      events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      events.onopen = () => { connected.value = true; reconnecting.value = false; };
      events.onerror = () => { connected.value = false; reconnecting.value = true; };
      events.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.job) upsert(data.job);
        } catch { /* ignore */ }
      };
      if (url.value.trim()) await probe();
    });

    onBeforeUnmount(() => {
      if (events) events.close();
      window.removeEventListener('keydown', onKeydown);
      document.body.style.overflow = '';
    });

    return {
      t, lang, url, partUrl, result, selected, jobs, busy, submitting, message, version, reconnecting, settingsError,
      withCover, withSubs, withDanmaku, size, statusLabel, dur,
      connected, outDir, limitRate, rateText, platformClass, jobName,
      settingsOpen, sOutDir, sTheme, sLimitRateMB, sConcurrency, sGeneric,
      compStatus, compBusy, previewUrl,
      authRows, authBusy, loadAuth, loginSite, authBadge, authText,
      isBiliJob, refetchJobSidecars,
      checkedParts, isBatch, allChecked, someChecked, estimated, toggleAll, togglePart,
      activeJobs, finishedJobs, orderedJobs,
      album, albumTracks, checkedTracks, allTracks, toggleTrack, toggleAllTracks,
      loadingMore, loadMoreTracks,
      toggleLang, toggleTheme, toggleFormat, persistSidecars, probe, probePart, download, cancel, retry,
      openSettings, saveSettings, installComponent, previewSelected, previewJob, closePreview,
    };
  },
}).mount('#app');
