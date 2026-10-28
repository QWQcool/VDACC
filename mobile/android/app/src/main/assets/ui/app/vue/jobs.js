/* 任务列表的纯逻辑：插入时保护终态、按状态分组。 */
window.VDACC_JOBS = {
  /** SSE 可能先于提交响应到达；迟到的 queued/running 快照不能覆盖 done/failed/cancelled。 */
  upsert(list, job) {
    if (!job) return list;
    const at = list.findIndex((j) => j.id === job.id);
    if (at >= 0) {
      const terminal = ['done', 'failed', 'cancelled'].includes(list[at].status);
      if (terminal && ['queued', 'running'].includes(job.status)) return list;
      list[at] = job;
    } else {
      list.unshift(job);
    }
    return list;
  },

  /** 进行中置顶，已结束在后；组内保持原有先后。 */
  group(list) {
    const active = list.filter((j) => j.status === 'running' || j.status === 'queued');
    const finished = list.filter((j) => j.status !== 'running' && j.status !== 'queued');
    return { active, finished, ordered: [...active, ...finished] };
  },
};
