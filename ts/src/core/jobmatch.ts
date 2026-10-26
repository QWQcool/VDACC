/**
 * 提交任务前的去重判定：同一 URL + 同一档位已经在排队/下载时，不再建第二个任务。
 * 双击、脚本重试、手机端重复点都会走到这里——重复下载同一目标文件最容易互相覆盖。
 */
export interface ActiveJobLike {
  url: string;
  formatId?: string;
  status: string;
}

const ACTIVE = new Set(['queued', 'running']);

export function isSameActiveJob(
  job: ActiveJobLike, url: string, formatId: string,
): boolean {
  if (!job || !ACTIVE.has(job.status)) return false;
  return job.url === url && (job.formatId || '') === (formatId || '');
}
