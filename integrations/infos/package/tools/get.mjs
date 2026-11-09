import { api, asJson, loadConfig, summarizeJob } from '../lib/vdl-client.mjs';

export function createContribution(host) {
  return {
    definition: {
      name: 'vdl_get',
      description:
        '提交下载任务并立即返回任务 id（不等待下载完成）。'
        + '先用 vdl_probe 拿 formats[].id；不传 formatIds 时下载推荐档位。'
        + 'B站 可另开字幕/弹幕（subs/danmaku，会落同名 .srt/.danmaku.xml）。'
        + '之后用 vdl_jobs 查进度与最终路径。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要下载的链接（与 probe 时一致）' },
          formatIds: {
            type: 'array',
            items: { type: 'string' },
            description: '要下载的档位 id 列表；留空则用推荐档位。最多 20 个',
          },
          subs: { type: 'boolean', description: 'B站：额外落同名 .srt 字幕' },
          danmaku: { type: 'boolean', description: 'B站：额外落同名 .danmaku.xml 弹幕' },
          cover: { type: 'boolean', description: '抖音/B站：额外落封面图' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    async execute(args) {
      const url = String(args?.url || '').trim();
      if (!url) return asJson({ ok: false, error: { message: 'url 不能为空' } });
      const formatIds = Array.isArray(args?.formatIds)
        ? args.formatIds.filter((x) => typeof x === 'string' && x.length > 0)
        : [];

      const config = await loadConfig(host);
      const body = {
        url,
        ...(formatIds.length ? { formatIds } : {}),
        ...(args?.subs === true ? { subs: true } : {}),
        ...(args?.danmaku === true ? { danmaku: true } : {}),
        ...(args?.cover === true ? { cover: true } : {}),
      };
      const data = await api(config, '/api/jobs', { method: 'POST', body });
      if (data?.ok !== true) return asJson({ ok: false, error: data?.error || { message: '提交失败' } });

      const jobs = Array.isArray(data.jobs) ? data.jobs : (data.job ? [data.job] : []);
      return asJson({
        ok: true,
        // 去重提示（同一条任务已在队列）走这里，不假装新建成功
        deduped: data.deduped === true,
        jobs: jobs.map(summarizeJob),
      });
    },
  };
}
