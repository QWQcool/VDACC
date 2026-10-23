/* Vue 3 迁移切片：无构建，直接由服务端托管。与旧版共用 /api 契约。 */
const I18N = {
  zh: {
    placeholder: '粘贴抖音 / B站 / 网易云 / 音乐链接',
    probe: '解析', probing: '解析中…',
    hint: 'B站 分P / 番剧会自动列出集数；专辑链接直接列出曲目（前 20 首）。',
    sources: '粘贴链接', platformCount: '支持 6 个平台 + 直链',
    author: '作者', parts: '分P', quality: '画质',
    runtime: '运行状态', limit: '限速', version: '版本', engine: '引擎',
    notice: '待处理', none: '暂无需要注意的', component: '通用组件',
    connected: '已连接', offline: '未连接',
    outDirHelp: '留空使用默认 下载\\；路径只保存在本机。',
    genericHelp: '只在你点「下载组件」时联网；官网直链 + SHA256 校验。',
    unlimited: '不限速',
    emptyTitle: '粘贴一个链接开始',
    emptyBody: '支持抖音、B站（分P/番剧）、网易云、QQ 音乐、酷我/酷狗、m3u8 与直链；专辑会先列出曲目。',
    download: '下载选中', cover: '封面', subs: '字幕', danmaku: '弹幕',
    sidecar: '字幕/弹幕', sidecars: '附属产物',
    album: '专辑', tracks: '曲目', albumDropped: '超过 20 首，本次只列前 20，略过',
    sidecarHint: '同目录会额外写入 .srt / .danmaku.xml（仅 B站，字幕优先中文 / AI 中文字幕）',
    jobs: '任务', cancel: '取消', retry: '重试',
    selectAll: '全选', estimated: '预计', limitHint: '超过 20 个分集，请分批选择（硬上限 20）',
    settings: '设置', outDir: '输出目录', defaultHint: '留空使用默认',
    light: '浅色', dark: '深色', concurrency: '并发', generic: '启用通用解析',
    install: '下载组件', downloading: '下载中…', save: '保存', preview: '预览',
    installed: '组件已安装', notInstalled: '组件未安装', saved: '设置已保存',
    notSupported: '当前后端不支持设置',
    lang: '切换语言', theme: '切换主题',
    queued: '已提交', needToken: '缺少 token：请用启动时打印的 ?token=... 打开',
    empty: '没有可下载档位', failed: '失败',
    queued_s: '排队', running: '下载中', done: '完成', cancelled: '已取消',
  },
  en: {
    placeholder: 'Paste a Douyin / Bilibili / NetEase / music link',
    probe: 'Probe', probing: 'Probing…',
    hint: 'Multi-part videos and seasons are listed automatically. Album links list up to 20 tracks.',
    sources: 'Source', platformCount: '6 platforms + direct URLs',
    author: 'Author', parts: 'Parts', quality: 'Quality',
    runtime: 'Runtime', limit: 'Limit', version: 'Version', engine: 'Engine',
    notice: 'Notice', none: 'Nothing to report', component: 'Add-on',
    connected: 'Connected', offline: 'Offline',
    outDirHelp: 'Leave empty for the default 下载\\ folder; stored on this machine only.',
    genericHelp: 'Only downloads when you click Install; official URL + SHA256 check.',
    unlimited: 'Unlimited',
    emptyTitle: 'Paste a link to start',
    emptyBody: 'Douyin, Bilibili (multi-part/seasons), NetEase, QQ Music, Kuwo/Kugou, m3u8 and direct URLs. Albums list tracks first.',
    download: 'Download', cover: 'Cover', subs: 'Subtitles', danmaku: 'Danmaku',
    sidecar: 'Subs/Danmaku', sidecars: 'Sidecars',
    album: 'Album', tracks: 'tracks', albumDropped: 'More than 20 tracks; only the first 20 are listed, skipped',
    sidecarHint: 'Writes .srt / .danmaku.xml next to the video (Bilibili only, Chinese subtitles preferred)',
    jobs: 'Jobs', cancel: 'Cancel', retry: 'Retry',
    selectAll: 'Select all', estimated: 'Est.', limitHint: 'More than 20 parts: select in batches (hard limit 20)',
    settings: 'Settings', outDir: 'Output folder', defaultHint: 'Leave empty for default',
    light: 'Light', dark: 'Dark', concurrency: 'Concurrency', generic: 'Enable generic parser',
    install: 'Download component', downloading: 'Downloading…', save: 'Save', preview: 'Preview',
    installed: 'Component installed', notInstalled: 'Component not installed', saved: 'Settings saved',
    notSupported: 'This backend does not support settings',
    lang: 'Language', theme: 'Theme',
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
    const allTracks = computed(() =>
      albumTracks.value.length > 0 && checkedTracks.value.length === albumTracks.value.length);
    const settingsOpen = ref(false);
    const sOutDir = ref('');
    const sTheme = ref('light');
    const sConcurrency = ref(1);
    const sGeneric = ref(false);
    const compStatus = ref('');
    const compBusy = ref(false);
    const previewUrl = ref('');
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

    const isAlbumUrl = (value) =>
      /music\.163\.com\/(?:#\/)?album/i.test(value) || /y\.qq\.com\/.*albumDetail/i.test(value);

    async function probeUrl(target) {
      const value = (target || url.value).trim();
      if (!value) return;
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
          message.value = (data.error && data.error.message) || 'failed';
          return;
        }
        // dropped 在响应顶层，挂到 album 上给模板用（截断必须让用户看到）
        album.value = { ...data.album, dropped: data.dropped || 0 };
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

    async function download() {
      // 专辑：每个勾选曲目一个 job（formatId 留空 = 各曲目用自己的推荐档）
      if (album.value) {
        const picked = albumTracks.value.filter((x) => checkedTracks.value.includes(x.id));
        if (!picked.length) return;
        busy.value = true;
        let ok = 0;
        for (const track of picked) {
          const data = await api('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { url: track.url, formatIds: [''], cover: withCover.value },
          });
          if (data.ok) { upsert(data.job); ok += 1; }
        }
        busy.value = false;
        message.value = `${t('queued')} ${ok}/${picked.length}`;
        return;
      }

      if (!result.value || !selected.value.length) return;

      // 批量：每个勾选的分P 一个 job，清晰度整批统一
      if (isBatch.value && checkedParts.value.length) {
        const fmt = selected.value[0];
        const parts = result.value.media.parts.filter((p) =>
          checkedParts.value.includes(p.index));
        let ok = 0;
        for (const part of parts) {
          const data = await api('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: {
              url: part.url, formatIds: [fmt], cover: withCover.value,
              subs: withSubs.value, danmaku: withDanmaku.value,
            },
          });
          if (data.ok) { upsert(data.job); ok += 1; }
        }
        message.value = `${t('queued')} ${ok}/${parts.length}`;
        return;
      }

      const data = await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          url: result.value.media.source_url || url.value,
          formatIds: [...selected.value],
          cover: withCover.value,
          subs: withSubs.value, danmaku: withDanmaku.value,
        },
      });
      if (data.ok) {
        upsert(data.job);
        message.value = t('queued');
      } else {
        message.value = (data.error && data.error.message) || 'failed';
      }
    }

    function persistSidecars() {
      localStorage.setItem('vdl-subs', withSubs.value ? '1' : '0');
      localStorage.setItem('vdl-danmaku', withDanmaku.value ? '1' : '0');
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
      else message.value = (data.error && data.error.message) || 'failed';
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
        connected.value = true;
        outDir.value = health.outDir || '';
        limitRate.value = health.limitRate || 0;
        document.documentElement.dataset.theme =
          localStorage.getItem('vdl-theme') || health.theme || 'light';
      } else {
        message.value = t('needToken');
        return;
      }
      // 右栏要显示组件状态，挂载时就查一次（不必等用户打开设置）
      refreshComponents();
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
      withCover, withSubs, withDanmaku, size, statusLabel, dur,
      connected, outDir, limitRate, rateText, platformClass, jobName,
      settingsOpen, sOutDir, sTheme, sConcurrency, sGeneric, compStatus, compBusy, previewUrl,
      checkedParts, isBatch, allChecked, someChecked, estimated, toggleAll, togglePart,
      album, albumTracks, checkedTracks, allTracks, toggleTrack, toggleAllTracks,
      toggleLang, toggleTheme, toggleFormat, persistSidecars, probe, probePart, download, cancel, retry,
      openSettings, saveSettings, installComponent, previewSelected, previewJob, closePreview,
    };
  },
}).mount('#app');
