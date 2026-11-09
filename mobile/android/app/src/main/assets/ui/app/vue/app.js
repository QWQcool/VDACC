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
    // A1 分析结果（/api/analyze）；analysisBusy 只用于按钮转圈，不阻塞其它操作
    const analysis = ref(null);
    const analysisBusy = ref(false);
    const canAnalyze = ref(true);
    const previewSeek = ref(null);
    const videoEl = ref(null);
    // 账号状态（/api/auth）：本地凭据 + 在线校验结果
    const authRows = ref([]);
    const authBusy = ref(false);
    const diagRows = ref([]);
    const diagBusy = ref(false);
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
    const failedJobs = computed(() => jobs.value.filter((j) => j.status === 'failed'));
    const orderedJobs = computed(() => [...activeJobs.value, ...finishedJobs.value]);

    const { size, dur, platformClass, jobName } = window.VDACC_FORMAT;

    const rateText = computed(() => {
      if (!limitRate.value) return t('unlimited');
      const mb = limitRate.value / 1048576;
      return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(limitRate.value / 1024)} KB/s`;
    });

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
        const { status, data } = await window.VDACC_API.request(token, path, opts);
        if (status === 401) connected.value = false;
        return data;
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
      window.VDACC_JOBS.upsert(jobs.value, job);
    }

    async function removeJob(job) {
      const data = await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
      if (data.ok) jobs.value = jobs.value.filter((j) => j.id !== job.id);
      else message.value = (data.error && data.error.message) || 'failed';
    }

    async function clearFinished() {
      const data = await api('/api/jobs/clear-finished', { method: 'POST' });
      if (data.ok) {
        const gone = new Set(data.removed || []);
        jobs.value = jobs.value.filter((j) => !gone.has(j.id));
        message.value = `${t('clearFinished')} ${data.count || 0}`;
      } else message.value = (data.error && data.error.message) || 'failed';
    }

    async function retryFailed() {
      const data = await api('/api/jobs/retry-failed', { method: 'POST' });
      message.value = data.ok
        ? `${t('retryFailed')} ${data.created || 0}/${data.failed || 0}`
        : (data.error && data.error.message) || 'failed';
    }

    async function revealJob(job) {
      if (!job.path) return;
      const data = await api('/api/reveal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { path: job.path },
      });
      if (!data.ok) message.value = (data.error && data.error.message) || 'failed';
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

    async function runDiagnostics() {
      diagBusy.value = true;
      const data = await api('/api/doctor');
      diagBusy.value = false;
      if (data.ok) diagRows.value = data.checks || [];
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
        // 字幕拿不到时要说原因：是「平台没有」还是「平台给的是别的稿件的字幕，已丢弃」
        const parts = [];
        if (data.srt) parts.push(`${data.srtCount || 0} 行（${data.srtLang || '未知轨'}）`);
        else if (data.srtReason) parts.push(`字幕未写入：${data.srtReason}`);
        if (data.danmaku) parts.push(`弹幕 ${data.danmakuCount || 0} 条`);
        message.value = `${t('sidecarDone')}：${parts.join(' · ') || '无变化'}`;
      } else {
        message.value = (data.error && data.error.message) || 'failed';
      }
    }

    /**
     * 成品预览地址由 API 给，不在界面里拼 URL。
     *
     * 原来这里硬编码 `/api/preview?token=…&path=…`，在手机壳里会解析成
     * `file:///api/preview…`（本地引擎模式没有 HTTP 服务），必然播不出来；
     * 现在桌面回本地代理地址、手机回 `content://`，界面只负责把 url 塞进 `<video>`。
     */
    async function previewJob(job) {
      if (!job.path) return;
      const data = await api('/api/preview-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { path: job.path },
      });
      if (data.ok && data.url) {
        previewSeek.value = null; // 普通预览从头放；只有从分析面板跳过来才带时间
        previewUrl.value = data.url;
      } else message.value = (data.error && data.error.message) || 'failed';
    }
    function closePreview() { previewUrl.value = ''; }

    /**
     * A1 分析：只对视频文件发请求。
     *
     * 音频没有视频轨，`analyzeFile` 会报 `bad_input`；按钮就不该出现在那里。
     * 端上没有 ffmpeg（health.capabilities.analyze = false），也不显示。
     */
    const VIDEO_EXT = /\.(mp4|m4v|mkv|mov|webm|flv|ts)$/i;
    function analyzable(job) {
      return canAnalyze.value && !!job.path && VIDEO_EXT.test(job.path);
    }
    const descConfirm = ref(false);
    const analysisName = computed(() => {
      const path = (analysis.value && analysis.value.source && analysis.value.source.path) || '';
      return path.split(/[\\/]/).pop() || path;
    });

    async function runAnalyze(path, extra = {}) {
      analysisBusy.value = true;
      const data = await api('/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { path, ...extra },
      });
      analysisBusy.value = false;
      if (!data.ok) {
        message.value = (data.error && data.error.message) || t('analyzeFailed');
        return null;
      }
      // 帧的显示地址同样问 API：桌面回 /api/preview?token=…，手机回 content://
      // （自己拼相对路径在手机壳里会变成 file:///api/preview…，图全裂）
      const frames = await Promise.all((data.frames || []).map(async (frame) => {
        const resolved = await api('/api/preview-url', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { path: frame.path },
        });
        return { ...frame, url: resolved.ok ? resolved.url : '' };
      }));
      return { ...data, frames };
    }

    async function analyzeJob(job) {
      if (!job.path || analysisBusy.value) return;
      const result = await runAnalyze(job.path);
      if (result) analysis.value = result;
    }

    /** A2：逐帧语义描述。要花 API 额度，所以先让用户确认一遍（面板里内联确认，不用原生弹窗）。 */
    async function describeShots() {
      const current = analysis.value;
      if (!current || analysisBusy.value) return;
      const result = await runAnalyze(current.source.path, {
        describe: true, maxDescribe: current.frames.length,
      });
      if (result) {
        analysis.value = result;
        descConfirm.value = false;
      }
    }
    function closeAnalysis() { analysis.value = null; descConfirm.value = false; }

    /** 从分析面板跳到成品的某一刻：复用预览浮层，不用再开一个播放器。 */
    async function seekTo(tMs) {
      if (!analysis.value) return;
      const data = await api('/api/preview-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { path: analysis.value.source.path },
      });
      if (!data.ok || !data.url) {
        message.value = (data.error && data.error.message) || 'failed';
        return;
      }
      previewSeek.value = tMs;
      previewUrl.value = data.url;
    }
    const seekToFrame = (frame) => seekTo(frame.t_ms);
    const seekToScene = (scene) => seekTo(Math.round((scene.start_ms + scene.end_ms) / 2));

    /** `loadedmetadata` 时才允许写 currentTime；更早赋值会被浏览器丢掉。 */
    function applySeek() {
      const video = videoEl.value;
      if (!video || previewSeek.value === null) return;
      try { video.currentTime = previewSeek.value / 1000; } catch { /* 还没就绪就交给下一次事件 */ }
    }

    // Esc / 焦点循环 / 背景 inert / 滚动锁都交给 overlays.js
    const teardownOverlays = window.VDACC_OVERLAYS.install({
      settingsOpen, previewUrl, analysis, watch, nextTick,
    });

    let events = null;
    onMounted(async () => {
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
        // 缺 ffmpeg 的机器（端上一定没有）直接不显示「分析」，别让人点了才被告知不能
        if (health.capabilities && health.capabilities.analyze === false) canAnalyze.value = false;
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
          if (data.type === 'job-removed') {
            const gone = new Set(data.ids || []);
            jobs.value = jobs.value.filter((j) => !gone.has(j.id));
            return;
          }
          if (data.job) upsert(data.job);
        } catch { /* ignore */ }
      };
      if (url.value.trim()) await probe();
    });

    onBeforeUnmount(() => {
      if (events) events.close();
      teardownOverlays();
    });

    return {
      t, lang, url, partUrl, result, selected, jobs, busy, submitting, message, version, reconnecting, settingsError,
      withCover, withSubs, withDanmaku, size, statusLabel, dur,
      connected, outDir, limitRate, rateText, platformClass, jobName,
      settingsOpen, sOutDir, sTheme, sLimitRateMB, sConcurrency, sGeneric,
      compStatus, compBusy, previewUrl,
      authRows, authBusy, loadAuth, loginSite, authBadge, authText,
      diagRows, diagBusy, runDiagnostics,
      isBiliJob, refetchJobSidecars,
      checkedParts, isBatch, allChecked, someChecked, estimated, toggleAll, togglePart,
      activeJobs, finishedJobs, failedJobs, orderedJobs,
      removeJob, clearFinished, retryFailed, revealJob,
      album, albumTracks, checkedTracks, allTracks, toggleTrack, toggleAllTracks,
      loadingMore, loadMoreTracks,
      toggleLang, toggleTheme, toggleFormat, persistSidecars, probe, probePart, download, cancel, retry,
      openSettings, saveSettings, installComponent, previewSelected, previewJob, closePreview,
      analysis, analysisBusy, analysisName, analyzable, analyzeJob, closeAnalysis,
      descConfirm, describeShots,
      seekToFrame, seekToScene, applySeek, videoEl,
    };
  },
}).mount('#app');
