/* Vue 3 迁移切片：无构建，直接由服务端托管。与旧版共用 /api 契约。 */
const I18N = {
  zh: {
    placeholder: '粘贴抖音 / B站 / 网易云链接',
    probe: '解析', probing: '解析中…',
    hint: 'B站 分P / 番剧会自动列出集数；下载默认 1080P。',
    download: '下载选中', cover: '封面',
    jobs: '任务', cancel: '取消', retry: '重试',
    settings: '设置', outDir: '输出目录', defaultHint: '留空使用默认',
    light: '浅色', dark: '深色', concurrency: '并发', generic: '启用通用解析',
    install: '下载组件', downloading: '下载中…', save: '保存', preview: '预览',
    installed: '组件已安装', notInstalled: '组件未安装', saved: '设置已保存',
    notSupported: '当前后端不支持设置',
    lang: '切换语言', theme: '切换主题', legacy: '旧版界面',
    queued: '已提交', needToken: '缺少 token：请用启动时打印的 ?token=... 打开',
    empty: '没有可下载档位', failed: '失败',
    queued_s: '排队', running: '下载中', done: '完成', cancelled: '已取消',
  },
  en: {
    placeholder: 'Paste a Douyin / Bilibili / NetEase link',
    probe: 'Probe', probing: 'Probing…',
    hint: 'Multi-part videos and seasons are listed automatically. Default quality is 1080P.',
    download: 'Download', cover: 'Cover',
    jobs: 'Jobs', cancel: 'Cancel', retry: 'Retry',
    settings: 'Settings', outDir: 'Output folder', defaultHint: 'Leave empty for default',
    light: 'Light', dark: 'Dark', concurrency: 'Concurrency', generic: 'Enable generic parser',
    install: 'Download component', downloading: 'Downloading…', save: 'Save', preview: 'Preview',
    installed: 'Component installed', notInstalled: 'Component not installed', saved: 'Settings saved',
    notSupported: 'This backend does not support settings',
    lang: 'Language', theme: 'Theme', legacy: 'Legacy UI',
    queued: 'Queued', needToken: 'Missing token: open the URL printed with ?token=...',
    empty: 'No downloadable format', failed: 'Failed',
    queued_s: 'Queued', running: 'Running', done: 'Done', cancelled: 'Cancelled',
  },
};

const { createApp, ref, computed, onMounted, onBeforeUnmount } = Vue;

createApp({
  setup() {
    const token = new URLSearchParams(location.search).get('token') ||
      localStorage.getItem('vdl-token') || '';
    if (token) localStorage.setItem('vdl-token', token);

    const lang = ref(localStorage.getItem('vdl-lang') || 'zh');
    const t = (key) => (I18N[lang.value] && I18N[lang.value][key]) || key;

    const url = ref('');
    const partUrl = ref('');
    const result = ref(null);
    const selected = ref([]);
    const jobs = ref([]);
    const busy = ref(false);
    const message = ref('');
    const version = ref('');
    const withCover = ref(true);
    const settingsOpen = ref(false);
    const sOutDir = ref('');
    const sTheme = ref('light');
    const sConcurrency = ref(1);
    const sGeneric = ref(false);
    const compStatus = ref('');
    const compBusy = ref(false);
    const previewUrl = ref('');
    const legacyUrl = computed(() => `/?token=${encodeURIComponent(token)}`);

    const size = (bytes) => {
      if (!bytes) return '—';
      return bytes >= 1048576
        ? `${(bytes / 1048576).toFixed(2)} MB`
        : `${(bytes / 1024).toFixed(0)} KB`;
    };
    const statusLabel = (status) => ({
      queued: t('queued_s'), running: t('running'),
      done: t('done'), failed: t('failed'), cancelled: t('cancelled'),
    }[status] || status);

    async function api(path, opts = {}) {
      const res = await fetch(path, {
        method: opts.method || 'GET',
        headers: Object.assign({ 'X-VDL-Token': token }, opts.headers || {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      try { return await res.json(); } catch { return { ok: false, error: { message: `HTTP ${res.status}` } }; }
    }

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

    async function probeUrl(target) {
      const value = (target || url.value).trim();
      if (!value) return;
      busy.value = true;
      message.value = '';
      const data = await api('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { url: value },
      });
      busy.value = false;
      if (!data.ok) {
        message.value = (data.error && data.error.message) || 'failed';
        return;
      }
      result.value = data;
      url.value = value;
      partUrl.value = data.media.source_url || value;
      selected.value = data.formats.filter((f) => f.recommended).map((f) => f.id);
      if (!selected.value.length && data.formats.length) {
        selected.value = [data.formats[0].id];
      }
    }

    const probe = () => probeUrl(url.value);
    const probePart = () => probeUrl(partUrl.value);

    async function download() {
      if (!result.value || !selected.value.length) return;
      const data = await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          url: result.value.media.source_url || url.value,
          formatIds: [...selected.value],
          cover: withCover.value,
        },
      });
      if (data.ok) {
        upsert(data.job);
        message.value = t('queued');
      } else {
        message.value = (data.error && data.error.message) || 'failed';
      }
    }

    function upsert(job) {
      if (!job) return;
      const at = jobs.value.findIndex((j) => j.id === job.id);
      if (at >= 0) jobs.value[at] = job;
      else jobs.value.unshift(job);
    }

    async function cancel(id) {
      await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
    }
    async function retry(id) {
      const data = await api(`/api/jobs/${id}/retry`, { method: 'POST' });
      if (data.ok) upsert(data.job);
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
      const s = data.settings || {};
      sOutDir.value = s.outDir || '';
      sTheme.value = s.theme || 'light';
      sConcurrency.value = s.concurrency || 1;
      sGeneric.value = !!s.allowGeneric;
      await refreshComponents();
      settingsOpen.value = true;
    }

    async function saveSettings() {
      const data = await api('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: {
          outDir: sOutDir.value.trim(), theme: sTheme.value,
          concurrency: sConcurrency.value, allowGeneric: sGeneric.value,
        },
      });
      if (!data.ok) { message.value = (data.error && data.error.message) || 'failed'; return; }
      document.documentElement.dataset.theme = sTheme.value;
      localStorage.setItem('vdl-theme', sTheme.value);
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

    function previewJob(job) {
      if (!job.path) return;
      previewUrl.value = `/api/preview?token=${encodeURIComponent(token)}&path=${encodeURIComponent(job.path)}`;
    }
    function closePreview() { previewUrl.value = ''; }

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
        document.documentElement.dataset.theme =
          localStorage.getItem('vdl-theme') || health.theme || 'light';
      } else {
        message.value = t('needToken');
        return;
      }
      const list = await api('/api/jobs');
      if (list.ok) jobs.value = (list.jobs || []).slice().reverse();
      events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      events.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.job) upsert(data.job);
        } catch { /* ignore */ }
      };
    });

    onBeforeUnmount(() => { if (events) events.close(); });

    return {
      t, lang, url, partUrl, result, selected, jobs, busy, message, version,
      withCover, legacyUrl, size, statusLabel,
      settingsOpen, sOutDir, sTheme, sConcurrency, sGeneric, compStatus, compBusy, previewUrl,
      toggleLang, toggleTheme, toggleFormat, probe, probePart, download, cancel, retry,
      openSettings, saveSettings, installComponent, previewJob, closePreview,
    };
  },
}).mount('#app');
