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
    // 专辑 / 歌单：与单条结果互斥，独立走 /api/album；默认一首都不勾（防误点整张专辑）
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
    // B站 是 DASH 双轨：<video> 只有画面，音轨单独给一个隐藏 <audio>（成品预览没有这一项）
    const previewAudioUrl = ref('');
    // A1 分析结果（/api/analyze）；analysisBusy 只用于按钮转圈，不阻塞其它操作
    const analysis = ref(null);
    const analysisBusy = ref(false);
    const canAnalyze = ref(true);
    const previewSeek = ref(null);
    const videoEl = ref(null);
    const audioEl = ref(null);
    // 账号状态（/api/auth）：本地凭据 + 在线校验结果
    const authRows = ref([]);
    const authBusy = ref(false);
    // B站 扫码登录：二维码与轮询状态都在前端，关掉弹层就停轮询（服务端不挂后台任务）
    const qrOpen = ref(false);
    // 哪些站点支持扫码由 /api/health 的能力位给（前端不写死，后端加站点这里自动跟上）
    const qrSites = ref([]);
    const qrSite = ref('bilibili');
    // 续期状态（只读）：平台说要不要刷新凭据
    const renewInfo = ref(null);
    const qrKey = ref('');
    const qrImage = ref('');
    const qrState = ref('idle');
    const qrMessage = ref('');
    let qrTimer = null;
    const diagRows = ref([]);
    const diagBusy = ref(false);
    const checkedParts = ref([]);
    // 每 P 的附属产物选择：{ [index]: { cover, subs, danmaku } }
    const partOpts = ref({});
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

    // ── 每 P 的附属产物（弹幕 / 字幕 / 封面）──
    // 全局开关的作用是「一键设置所有 P」，单 P 还能再改；只让全局说了算会把
    // 「这一 P 不要弹幕」这种需求逼回命令行。
    const enabledSidecars = (platform) => ({
      cover: withCover.value && ['douyin', 'bilibili'].includes(platform),
      subs: withSubs.value && platform === 'bilibili',
      danmaku: withDanmaku.value && platform === 'bilibili',
    });

    function initPartOpts(parts, platform) {
      const next = { ...partOpts.value };
      for (const p of parts || []) {
        // 已有条目保留：换 P 重新解析不该抹掉用户刚调好的勾选
        if (!next[p.index]) next[p.index] = { ...enabledSidecars(platform) };
      }
      partOpts.value = next;
    }

    const optOf = (index) => partOpts.value[index] || enabledSidecars(result.value?.platform);

    function togglePartOpt(index, kind) {
      const current = { ...optOf(index) };
      current[kind] = !current[kind];
      partOpts.value = { ...partOpts.value, [index]: current };
    }

    /** 改全局开关 = 把当前值套到所有 P（界面上要说明这是"全部"语义）。 */
    function applySidecarsToAll() {
      const platform = result.value?.platform;
      const base = enabledSidecars(platform);
      const next = {};
      for (const p of result.value?.media.parts || []) next[p.index] = { ...base };
      if (Object.keys(next).length) partOpts.value = next;
    }

    const chosenFormat = computed(() => (result.value?.formats || [])
      .find((f) => f.id === (selected.value[0] || '')));

    // ── 收藏夹 / 合集：列表入口，逐条勾选后下载 ──
    const collection = ref(null);
    const collectionChecked = ref([]);
    const collectionBusy = ref(false);
    const collectionMore = ref(false);

    // 只认明确是"列表页"的链接；纯数字不当收藏夹（用户更可能贴裸编号）
    const isCollectionUrl = (v) => /favlist|collectiondetail|seriesdetail|media_id=|\/channel\/collection/i.test(String(v || ''));

    const collableItems = computed(() => (collection.value?.items || []).filter((i) => i.state === 'ok'));
    const allCollChecked = computed(() => collableItems.value.length > 0
      && collectionChecked.value.length === collableItems.value.length);
    const someCollChecked = computed(() => collectionChecked.value.length > 0 && !allCollChecked.value);

    async function loadCollection(value, page = 1) {
      if (page === 1) collectionBusy.value = true; else collectionMore.value = true;
      const data = await api('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { url: value, page },
      });
      collectionBusy.value = false;
      collectionMore.value = false;
      if (!data.ok) { message.value = errorText(data); return; }
      if (page === 1) {
        collection.value = { ...data };
        collectionChecked.value = [];
        result.value = null;
        album.value = null;
        url.value = value;
      } else {
        // 第 2 页起后端给不出 media_count（B站 只在第一页的 info 里带），不能让 total 被 0 覆盖，
        // 否则界面会显示「已列 20 / 0」。按 bvid 去重，翻页边界重复的条目不重复追加。
        const known = collection.value?.items || [];
        const ids = new Set(known.map((i) => i.bvid));
        const added = (data.items || []).filter((i) => !ids.has(i.bvid));
        collection.value = {
          ...collection.value,
          ...data,
          total: data.total || collection.value?.total || known.length + added.length,
          items: [...known, ...added],
        };
      }
    }

    function toggleColl(bvid) {
      const at = collectionChecked.value.indexOf(bvid);
      if (at >= 0) { collectionChecked.value.splice(at, 1); return; }
      collectionChecked.value.push(bvid);
    }

    function toggleAllColl() {
      collectionChecked.value = allCollChecked.value ? [] : collableItems.value.map((i) => i.bvid);
    }

    const loadMoreCollection = () => {
      if (!collection.value) return;
      loadCollection(url.value, (collection.value.page || 1) + 1);
    };

    async function downloadCollection() {
      if (submitting.value || !collection.value) return;
      const picked = collableItems.value.filter((i) => collectionChecked.value.includes(i.bvid));
      if (!picked.length) return;
      submitting.value = true;
      let ok = 0; let deduped = 0; const errors = [];
      try {
        for (const item of picked) {
          const data = await api('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 档位留空 = 用引擎推荐档；资源开关沿用账号面板里的全局偏好
            body: { url: item.url, formatIds: [''], ...enabledSidecars('bilibili') },
          });
          if (data.ok) {
            for (const job of data.jobs || []) upsert(job);
            deduped += (data.reused || []).length;
            ok += 1;
          } else errors.push(errorText(data));
        }
        message.value = `${t('queued')} ${ok}/${picked.length}`
          + (deduped ? ` · ${t('deduped')} ${deduped}` : '')
          + (errors.length ? ` · ${[...new Set(errors)].join('；')}` : '');
      } finally {
        submitting.value = false;
      }
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

    // 歌单与专辑走同一个端点（/api/album）：两者都是「列一批曲目让用户勾选」，
    // 后端按路径里的 playlist 分派，界面复用同一张列表卡。
    const isAlbumUrl = (value) =>
      /music\.163\.com\/(?:#\/)?(?:m\/)?(?:album|playlist)/i.test(value)
      || /y\.qq\.com\/.*albumDetail/i.test(value)
      // QQ 歌单：`/n/ryqq/playlist/<数字>` 与分享页 `taoge.html?id=<数字>`
      || /y\.qq\.com\/.*\/(?:playlist\/\d+|taoge\.html)/i.test(value)
      // 酷狗歌单：`/yy/special/single/<id>.html`、`/plist/list/<id>`
      || /kugou\.com\/.*\/(?:special\/single|plist\/list)\/\d+/i.test(value);

    async function probeUrl(target) {
      const value = (target || url.value).trim();
      if (!value || busy.value || submitting.value) return;
      busy.value = true;
      message.value = '';

      // 专辑 / 歌单链接：先列曲目（上限 20），再按勾选逐首建任务
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
          warnings: data.warnings || [],
        };
        albumTracks.value = data.tracks || [];
        checkedTracks.value = [];
        result.value = null;
        // 列表卡互斥：先粘收藏夹再粘专辑/歌单时，不能两张卡同时挂着
        collection.value = null;
        collectionChecked.value = [];
        selected.value = [];
        url.value = value;
        return;
      }
      album.value = null;
      albumTracks.value = [];
      checkedTracks.value = [];

      // 收藏夹 / 合集：这不是"一个视频"，走列表入口；由用户勾选后逐条建任务
      if (isCollectionUrl(value)) {
        busy.value = false;
        await loadCollection(value);
        return;
      }
      collection.value = null;
      collectionChecked.value = [];

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
      initPartOpts(data.media.parts, data.platform);
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

    // 仅音频档位由 probe 的 formats 提供（B站 DASH 音频轨是独立文件）。
    // 手机端引擎没有这一档 → 这里为 undefined，chip 自动禁用，不假装能点。
    const audioFormat = computed(() => (result.value?.formats || [])
      .find((f) => f.id === 'audio' && f.available));

    /** 「音频」chip：只下音频轨。勾选状态仍回到 normally 的 selected，用户能再改。 */
    function downloadAudioOnly() {
      if (!audioFormat.value || submitting.value || busy.value) return;
      selected.value = ['audio'];
      download();
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
        const parts = result.value.media.parts || [];
        if (isBatch.value) {
          const picked = parts.filter((p) => checkedParts.value.includes(p.index));
          for (const part of picked) {
            // 每条分P 用自己那套附属开关，不用全局——否则单 P 的细调等于白设
            requests.push({ url: part.url, formatIds: [selected.value[0]], ...optOf(part.index) });
          }
        } else if (parts.length && platform === 'bilibili') {
          // 单 P 也走 parts[0]：cid/url 来自同一次探测，且能带上这一 P 的附属选择
          const part = parts.find((p) => p.selected) || parts[0];
          requests.push({ url: part.url || result.value.media.source_url || url.value, formatIds: [...selected.value], ...optOf(part.index) });
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
      // 全局开关同时是「套用到所有 P」，界面上写了这句，行为就得对上
      applySidecarsToAll();
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
      // 音频档没有视频轨，服务端预览地址为空：说清楚，而不是让按钮转一圈再报 failed
      if (selected.value[0] === 'audio') { message.value = t('audioNoPreview'); return; }
      const data = await api('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          url: result.value.media.source_url || url.value,
          formatId: selected.value[0],
        },
      });
      if (data.ok) {
        previewUrl.value = data.url;
        previewAudioUrl.value = data.audioUrl || '';
      } else message.value = errorText(data);
    }

    /**
     * 让隐藏的 `<audio>` 跟着 `<video>` 走：播放 / 暂停 / 跳转 / 倍速。
     *
     * 为什么只纠偏不硬同步：`timeupdate` 约 4Hz，每帧都写 `currentTime` 会让音频打嗝；
     * 偏差超过 250ms 才拉回一次，正常播放时两边各播各的（同源、同一时间轴）。
     */
    function syncPreviewAudio() {
      const video = videoEl.value;
      const audio = audioEl.value;
      if (!video || !audio) return;
      if (Math.abs(audio.currentTime - video.currentTime) > 0.25) {
        audio.currentTime = video.currentTime;
      }
      audio.playbackRate = video.playbackRate;
      audio.volume = video.volume;
      audio.muted = video.muted;
      if (video.paused) {
        if (!audio.paused) audio.pause();
      } else if (audio.paused) {
        audio.play().catch(() => { /* 自动播放被拒时保持静音，不弹错 */ });
      }
    }

    async function loadAuth() {
      authBusy.value = true;
      const data = await api('/api/auth');
      authBusy.value = false;
      if (data.ok) authRows.value = data.sites || [];
      else message.value = (data.error && data.error.message) || 'failed';
      loadRenew();
    }

    /** 续期状态是单独一次只读查询（平台会真的算一次，不跟着 20s 的账号缓存走）。 */
    async function loadRenew() {
      const data = await api('/api/auth/bilibili/renew');
      renewInfo.value = data.ok ? data : null;
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

    // ---- B站 扫码登录 ----
    // 为什么轮询放在前端：服务端一旦持有循环，页面关掉/切 tab 都还在打接口；
    // 放前端则生命周期跟着弹层走，散架也不留后台请求。
    function stopQrTimer() {
      if (qrTimer) { clearTimeout(qrTimer); qrTimer = null; }
    }

    async function startQr() {
      stopQrTimer();
      qrState.value = 'loading';
      qrMessage.value = '';
      const data = await api(`/api/auth/${qrSite.value}/qrcode`, { method: 'POST' });
      if (!data.ok) {
        qrState.value = 'error';
        qrMessage.value = errorText(data);
        return;
      }
      qrKey.value = data.key;
      qrImage.value = data.qrDataUrl;
      qrState.value = 'pending';
      qrMessage.value = t('qrPending');
      qrTimer = setTimeout(pollQr, 1500);
    }

    async function openQr(site = 'bilibili') {
      qrSite.value = site;
      qrOpen.value = true;
      await startQr();
    }

    function closeQr() {
      stopQrTimer();
      qrOpen.value = false;
      qrKey.value = '';
      qrImage.value = '';
    }

    async function pollQr() {
      qrTimer = null;
      if (!qrOpen.value || !qrKey.value) return;
      const data = await api(`/api/auth/${qrSite.value}/qrcode?key=${encodeURIComponent(qrKey.value)}`);
      if (!data.ok) {
        qrState.value = 'error';
        qrMessage.value = errorText(data);
        return;
      }
      qrState.value = data.state;
      qrMessage.value = data.message || '';
      if (data.state === 'ok' || data.state === 'unverified') {
        // unverified 也要刷新账号面板：凭据已经落盘，只是没验通
        loadAuth();
        if (data.state === 'ok') {
          // 登录后能力自检：有现成链接就重解析一次，用真实档位证明"登录有用"（N19b）
          refreshTierAfterLogin();
          setTimeout(closeQr, 1200);
        }
        return;
      }
      if (data.state === 'expired') {
        // 过期不打扰用户，直接换一张
        startQr();
        return;
      }
      if (data.state === 'error') return;
      qrTimer = setTimeout(pollQr, 1500);
    }

    async function logoutSite(site) {
      const data = await api(`/api/auth/${site}/logout`, { method: 'POST' });
      if (!data.ok) { message.value = errorText(data); return; }
      message.value = data.removed ? t('loggedOut') : t('authNone');
      loadAuth();
    }

    /** 该站点的登录按钮是走扫码弹层，还是走电脑上的 Edge。 */
    const usesQr = (a) => qrSites.value.includes(a.site);


    /**
     * 登录后能力自检：拿输入框里的链接重新解析一次，把"实际最高档"说出来。
     * 为什么要这一步：nav 说已登录、playurl 却只给 480P 是真实存在过的状态（cookie 不全）。
     * 没有现成链接就跳过——不能凭空造一个视频去探测。
     */
    async function refreshTierAfterLogin() {
      const target = url.value.trim();
      if (!target) return;
      await probeUrl(target);
      const fmt = chosenFormat.value;
      if (!fmt) return;
      message.value = `${t('loginTierOk')}：${fmt.label}${fmt.fps > 30 ? fmt.fps : ''}`;
    }

    /** 扫码这条路平台不给面子时，退回电脑上的 Edge——不留在死路上。 */
    async function fallbackToEdge() {
      const site = qrSite.value;
      closeQr();
      await loginSite(site);
    }

    // ── 剪贴板 →「立即分析」（N21）──
    // 唧唧Down 是桌面壳，可以直接读 Win32 剪贴板；我们是浏览器页面，只有两条路：
    // ① navigator.clipboard.readText()（需要用户授权，可能被拒）② paste 事件（零权限）。
    // 所以默认关闭，打开时当场请求一次授权：授权失败就明确说"没权限"，不假装在工作。
    const clipWatch = ref(false);
    const clipHit = ref(null);
    let clipTimer = null;
    let clipLast = '';
    let clipReading = false;

    const URL_RE = /https?:\/\/[^\s"'<>，。；、）)]+/;
    /** 从一段分享文案里抽链接；没有链接就退而找裸 BV 号。抽不到返回空串。 */
    function extractLink(text) {
      const raw = String(text || '');
      const m = URL_RE.exec(raw);
      if (m) return m[0];
      const bv = /\bBV[0-9A-Za-z]{10}\b/.exec(raw);
      return bv ? bv[0] : '';
    }
    /** 只对"像下载目标"的链接弹卡片；否则复制一句普通网址也弹，纯噪音。 */
    const isMediaLink = (link) => /bilibili\.com|b23\.tv|douyin\.com|iesdouyin|music\.163\.com|y\.qq\.com|kugou|kuwo/i.test(link);

    function handleClipText(text) {
      const raw = String(text || '');
      if (!raw || raw === clipLast) return;
      clipLast = raw;
      const link = extractLink(raw);
      if (!link || !isMediaLink(link)) return;
      if (link === url.value.trim()) return;
      clipHit.value = { link };
    }

    function stopClipWatch() {
      if (clipTimer) { clearInterval(clipTimer); clipTimer = null; }
    }

    function startClipWatch() {
      stopClipWatch();
      clipTimer = setInterval(async () => {
        // 只在可见且聚焦时读：后台标签页读剪贴板既没意义，也更容易被浏览器拒
        if (clipReading || document.visibilityState !== 'visible' || !document.hasFocus()) return;
        clipReading = true;
        try {
          handleClipText(await navigator.clipboard.readText());
        } catch {
          // 授权被收回/浏览器策略变化：停掉轮询，但保留已开的开关状态说明
          stopClipWatch();
        } finally {
          clipReading = false;
        }
      }, 1500);
    }

    async function toggleClipWatch() {
      if (clipWatch.value) {
        clipWatch.value = false;
        localStorage.setItem('vdl-clipwatch', '0');
        stopClipWatch();
        return;
      }
      try {
        // 必须在用户手势里读一次，浏览器才弹授权；失败就不算打开
        const text = await navigator.clipboard.readText();
        clipWatch.value = true;
        localStorage.setItem('vdl-clipwatch', '1');
        handleClipText(text);
        startClipWatch();
      } catch {
        clipWatch.value = false;
        localStorage.setItem('vdl-clipwatch', '0');
        message.value = t('clipDenied');
      }
    }

    /** 挂载时恢复上次的开关；授权已被收回就如实关掉，不留一个假的「已开启」。 */
    async function initClipWatch() {
      clipWatch.value = localStorage.getItem('vdl-clipwatch') === '1';
      if (!clipWatch.value) return;
      try {
        await navigator.clipboard.readText();
        startClipWatch();
      } catch {
        clipWatch.value = false;
        localStorage.setItem('vdl-clipwatch', '0');
        message.value = t('clipDenied');
      }
    }

    function acceptClip() {
      if (!clipHit.value) return;
      url.value = clipHit.value.link;
      clipHit.value = null;
      probeUrl();
    }

    const dismissClip = () => { clipHit.value = null; };

    // paste 兜底：任何地方 Ctrl+V 都会触发，不需要任何权限
    window.addEventListener('paste', (e) => {
      const el = e.target;
      const tag = el && el.tagName ? el.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return; // 输入框里粘贴本来就会解析，别重复弹
      handleClipText(e.clipboardData ? e.clipboardData.getData('text') : '');
    });

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
      // mkv / flac 浏览器放不了（Chromium 不支持 matroska 与原生 flac 文件）：
      // 直接说清楚并引导用「打开」，而不是让用户对着黑屏猜
      if (/\.(mkv|flac|eac3)$/i.test(job.path)) {
        message.value = t('previewUnsupported');
        return;
      }
      const data = await api('/api/preview-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { path: job.path },
      });
      if (data.ok && data.url) {
        previewSeek.value = null; // 普通预览从头放；只有从分析面板跳过来才带时间
        previewUrl.value = data.url;
        previewAudioUrl.value = ''; // 本地成品自带音轨，不要再叠一条
      } else message.value = (data.error && data.error.message) || 'failed';
    }
    function closePreview() {
      previewUrl.value = '';
      previewAudioUrl.value = '';
    }

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
      previewAudioUrl.value = ''; // 分析面板跳的是本地成品，同样自带音轨
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
        // 支持扫码的站点由后端给：前端不写死，加站点时这里自动跟上
        qrSites.value = Array.isArray(health.capabilities?.qrSites) ? health.capabilities.qrSites : [];
        document.documentElement.dataset.theme =
          localStorage.getItem('vdl-theme') || health.theme || 'light';
      } else {
        // 带了 token 却被拒，不能说成「缺少 token」——通常是服务重启换了新 token
        message.value = t(token ? 'badToken' : 'needToken');
        return;
      }
      // 右栏要显示组件状态，挂载时就查一次（不必等用户打开设置）
      refreshComponents();
      // 剪贴板监听：只在用户上次明确打开过时才恢复
      initClipWatch();
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
      stopClipWatch();
      if (events) events.close();
      teardownOverlays();
    });

    return {
      t, lang, url, partUrl, result, selected, jobs, busy, submitting, message, version, reconnecting, settingsError,
      withCover, withSubs, withDanmaku, size, statusLabel, dur,
      connected, outDir, limitRate, rateText, platformClass, jobName,
      settingsOpen, sOutDir, sTheme, sLimitRateMB, sConcurrency, sGeneric,
      compStatus, compBusy, previewUrl, previewAudioUrl, audioEl, syncPreviewAudio,
      authRows, authBusy, loadAuth, loginSite, authBadge, authText, renewInfo, loadRenew,
      qrOpen, qrSites, qrSite, qrImage, qrState, qrMessage,
      clipWatch, clipHit, toggleClipWatch, acceptClip, dismissClip,
      openQr, closeQr, startQr, logoutSite, usesQr, fallbackToEdge,
      diagRows, diagBusy, runDiagnostics,
      isBiliJob, refetchJobSidecars,
      checkedParts, isBatch, allChecked, someChecked, estimated, toggleAll, togglePart,
      partOpts, optOf, togglePartOpt, applySidecarsToAll, chosenFormat,
      collection, collectionChecked, collectionBusy, collectionMore,
      allCollChecked, someCollChecked, collableItems, toggleColl, toggleAllColl,
      loadMoreCollection, downloadCollection, loadCollection,
      activeJobs, finishedJobs, failedJobs, orderedJobs,
      removeJob, clearFinished, retryFailed, revealJob,
      album, albumTracks, checkedTracks, allTracks, toggleTrack, toggleAllTracks,
      loadingMore, loadMoreTracks,
      toggleLang, toggleTheme, toggleFormat, persistSidecars, probe, probePart, download, downloadAudioOnly,
      audioFormat, cancel, retry,
      openSettings, saveSettings, installComponent, previewSelected, previewJob, closePreview,
      analysis, analysisBusy, analysisName, analyzable, analyzeJob, closeAnalysis,
      descConfirm, describeShots,
      seekToFrame, seekToScene, applySeek, videoEl,
    };
  },
}).mount('#app');
