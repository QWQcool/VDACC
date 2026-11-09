import { api, asJson, loadConfig, summarizeProbe } from '../lib/vdl-client.mjs';

export function createContribution(host) {
  return {
    definition: {
      name: 'vdl_probe',
      description:
        '解析一个媒体链接并返回可选档位（只读，不下载）。'
        + '支持抖音、B站（含分P/番剧）、网易云、QQ音乐、酷我、酷狗、m3u8 与直链；'
        + '可粘贴整段分享文案。返回 title/author/duration_ms/formats[].id 等字段，'
        + '把 formats[].id 交给 vdl_get 才会真正下载。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要解析的链接或整段分享文案' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    async execute(args) {
      const url = String(args?.url || '').trim();
      if (!url) return asJson({ ok: false, error: { message: 'url 不能为空' } });
      const config = await loadConfig(host);
      const data = await api(config, '/api/probe', { method: 'POST', body: { url }, timeoutMs: 120_000 });
      return asJson(summarizeProbe(data));
    },
  };
}
