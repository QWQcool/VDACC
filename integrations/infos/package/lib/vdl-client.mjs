/**
 * 与「本机 VDACC 服务」通话的最小客户端。
 *
 * 这里刻意不做两件事：
 * 1. **不启动服务**——Package 只负责调用。VDACC 没跑就给一句能照做的提示，
 *    而不是自己 spawn 一个 exe（那会绕过用户对进程的知情）。
 * 2. **不在包里存 token 的默认值**——token 每次启动都会变，写死等于把过期的凭据
 *    散落到安装目录。token 只从 Package 数据目录的 config.json（或环境变量）读。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';

/**
 * 读配置：`host.dataDirectory/config.json` 优先，其次环境变量。
 * 两个位置都没有 token 时抛错，并在错误里直接写出「文件应该长什么样」。
 */
export async function loadConfig(host) {
  const dataDir = host && host.dataDirectory ? host.dataDirectory : '';
  const configPath = dataDir ? join(dataDir, 'config.json') : '';

  let file = null;
  if (configPath) {
    try {
      file = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      file = null; // 没配过就走环境变量 / 默认值，下面统一判断
    }
  }

  const baseUrl = String(file?.baseUrl || process.env.VDACC_BASE_URL || DEFAULT_BASE_URL)
    .replace(/\/+$/, '');
  const token = String(file?.token || process.env.VDACC_TOKEN || '').trim();

  if (!token) {
    throw new Error(
      `缺少 VDACC token。请在 ${configPath || '<Package 数据目录>/config.json'} 写入：\n`
      + `{"baseUrl":"${baseUrl}","token":"<VDACC 启动时打印的 token>"}\n`
      + '（token 在每次启动 VDACC 时都会重新生成，换过就更新这个文件。）',
    );
  }
  return { baseUrl, token, configPath };
}

/**
 * 调一个 `/api/*`。
 *
 * 401 单独说明：用户最常见的情况是「VDACC 重启过、token 换了」，
 * 笼统报「请求失败」会让人去查网络，实际只要改一行配置。
 */
export async function api(config, path, opts = {}) {
  const url = `${config.baseUrl}${path}`;
  const headers = { 'X-VDL-Token': config.token };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs || 30_000),
    });
  } catch (err) {
    throw new Error(
      `连不上 VDACC（${url}）：${err?.message || err}。`
      + '请确认本机已启动 VDACC 服务（VDACC.bat 或 bun ts/src/server.ts），并在 config.json 里填对 baseUrl。',
    );
  }

  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: { code: `http_${res.status}`, message: `HTTP ${res.status}` } };
  }

  if (res.status === 401) {
    throw new Error(
      `token 无效或已过期（${config.configPath || 'config.json'}）。`
      + 'VDACC 每次启动都会换 token，请用启动时打印的新值更新配置。',
    );
  }
  return data;
}

/** 探测结果压成模型看得懂的短摘要，不整包塞回（一份 probe 里有 24~30 个档位）。 */
export function summarizeProbe(data) {
  if (!data || data.ok !== true) {
    return { ok: false, error: data?.error || { message: '探测失败（未返回错误详情）' } };
  }
  const media = data.media || {};
  return {
    ok: true,
    platform: data.platform,
    title: media.title,
    author: media.author,
    duration_ms: media.duration_ms,
    parts: (media.parts || []).length,
    source_url: media.source_url,
    formats: (data.formats || []).map((f) => ({
      id: f.id,
      label: f.label,
      bytes: f.bytes,
      available: f.available !== false,
      reason: f.reason || undefined,
    })),
    warnings: data.warnings || [],
  };
}

/** 任务卡摘要：只留用得上的字段，避免把 SSE 的内部字段一起吐出去。 */
export function summarizeJob(job) {
  return {
    id: job.id,
    status: job.status,
    percent: job.percent,
    title: job.title,
    url: job.url,
    path: job.path,
    bytes: job.bytes,
    srt: job.srt || undefined,
    srtCount: job.srtCount || undefined,
    error: job.error || undefined,
    warnings: job.warnings || [],
  };
}

/** 工具统一回**字符串**（A06 的示例就是返回字符串），内容是可解析的 JSON。 */
export const asJson = (value) => JSON.stringify(value, null, 2);
