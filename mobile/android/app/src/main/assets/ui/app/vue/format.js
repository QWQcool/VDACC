/* 纯展示函数：不依赖 Vue 状态，也不读全局，方便单测或复用。 */
window.VDACC_FORMAT = {
  size(bytes) {
    if (!bytes) return '—';
    return bytes >= 1048576
      ? `${(bytes / 1048576).toFixed(2)} MB`
      : `${(bytes / 1024).toFixed(0)} KB`;
  },

  dur(ms) {
    if (!ms) return '';
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  },

  /** 平台标签的语义色：B站粉、抖音蓝、音乐紫、嗅探/其它中性 */
  platformClass(p) {
    return {
      bilibili: 'accent', douyin: 'sky',
      netease: 'purple', qq: 'purple', kuwo: 'purple', kugou: 'purple',
      sniff: 'sky',
    }[p] || 'neutral';
  },

  /** 任务标题：优先用落盘文件名（去掉目录与扩展名），没有就退回清晰度/ID */
  jobName(job) {
    const path = job && job.path ? String(job.path) : '';
    if (!path) return (job && (job.formatId || job.id)) || '';
    const base = path.split(/[\\/]/).pop() || path;
    return base.replace(/\.[a-z0-9]{2,5}$/i, '');
  },
};
