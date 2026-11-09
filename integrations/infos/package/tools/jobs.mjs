import { api, asJson, loadConfig, summarizeJob } from '../lib/vdl-client.mjs';

export function createContribution(host) {
  return {
    definition: {
      name: 'vdl_jobs',
      description:
        '查询本机 VDACC 的任务列表（含进度、状态、最终文件路径、字幕行数、错误原因）。'
        + '传 id 只看一个任务；传 status 只看某一类（queued/running/done/failed/cancelled）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id；给了就只返回这一条' },
          status: {
            type: 'string',
            description: '按状态过滤：queued / running / done / failed / cancelled',
          },
          limit: { type: 'number', description: '最多返回多少条，默认 20，上限 100' },
        },
        additionalProperties: false,
      },
    },
    async execute(args) {
      const config = await loadConfig(host);
      const data = await api(config, '/api/jobs');
      if (data?.ok !== true) return asJson({ ok: false, error: data?.error || { message: '读取任务失败' } });

      const id = String(args?.id || '').trim();
      const status = String(args?.status || '').trim();
      const rawLimit = Number(args?.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.round(rawLimit)) : 20;

      let jobs = Array.isArray(data.jobs) ? data.jobs : [];
      if (id) jobs = jobs.filter((job) => job.id === id);
      if (status) jobs = jobs.filter((job) => job.status === status);

      return asJson({
        ok: true,
        total: jobs.length,
        jobs: jobs.slice(-limit).map(summarizeJob),
      });
    },
  };
}
