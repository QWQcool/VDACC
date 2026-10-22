/* Vue 3 迁移切片：无构建，直接由服务端托管。与旧版共用 /api 契约。 */
const I18N = {
  zh: {
    placeholder: '粘贴抖音 / B站 / 网易云链接',
    probe: '解析', probing: '解析中…',
    hint: 'B站 分P / 番剧会自动列出集数；下载默认 1080P。',
    download: '下载选中', cover: '封面',
    jobs: '任务', cancel: '取消', retry: '重试',
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
      toggleLang, toggleTheme, toggleFormat, probe, probePart, download, cancel, retry,
    };
  },
}).mount('#app');
