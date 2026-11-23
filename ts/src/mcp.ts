/**
 * MCP server（stdio）：把 VDACC 的四件事暴露成工具，给 Claude / Codex / DSH 这类宿主用。
 *
 * 为什么是「薄壳 + 本地 HTTP」而不是把引擎搬进来：
 * 引擎跑在 Bun 上、依赖 ffmpeg 与磁盘，宿主可能是 Node 也可能是别的进程——
 * 一旦搬进去就要为每宿主写一遍。这里只做协议适配，真正的活在 `server.ts` 里。
 *
 * 传输：stdio + **行分隔 JSON-RPC 2.0**（MCP 的 stdio 就是一行一条消息）。
 * 纪律：**stdout 只许写协议消息**，任何日志走 stderr——写错一句就整条连接废掉。
 *
 * 后端从哪来：
 * 1. 设了 `VDACC_TOKEN` → 连 `VDACC_BASE_URL`（默认 http://127.0.0.1:8780）上的实例；
 * 2. 没设 → 自己拉起一个（`--port 0 --token <random>`），从它的启动行解析真实端口，
 *    退出时一并杀掉。这样用户配一行 MCP 就能用，不必先开 VDACC。
 *
 * 测试：`import.meta.main` 之外全部可注入（`call` 由调用方给），所以用例不需要网络。
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const SERVER_NAME = 'vdacc';
// 版本号直接读仓库根 package.json：多一处硬编码就多一个忘改的地方（版本一致性用例只钉了四处）
import pkg from '../../package.json';
export const SERVER_VERSION = String((pkg as { version?: string }).version || '0.0.0');
const PROTOCOL_VERSION = '2024-11-05';

/** 单个工具的结果：直接进模型上下文的文本，**只放有用的字段**。 */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'probe',
    description:
      '解析一个媒体链接并列出可选档位（只读，不下载）。支持抖音、B站（含分P/番剧）、'
      + '网易云、QQ音乐、酷我、酷狗、m3u8 与直链；可粘贴整段分享文案。'
      + '把返回的 formats[].id 交给 get 才会真正下载。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '链接或整段分享文案' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'get',
    description:
      '按档位下载到本机输出目录。B站 会本地合并音视频（需要 ffmpeg）；'
      + '返回 path / bytes / skipped（重复下载）。wait_ms>0 时最多等这么久拿结果，'
      + '否则立刻返回 job_id，用 jobs 查进度。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '与 probe 相同的链接' },
        format_id: { type: 'string', description: 'probe 返回的 formats[].id；留空用推荐档' },
        subs: { type: 'boolean', description: 'B站：同时下载字幕（.srt）' },
        danmaku: { type: 'boolean', description: 'B站：同时下载弹幕（.xml + .ass）' },
        cover: { type: 'boolean', description: '抖音/直链：同时下载封面' },
        wait_ms: { type: 'number', description: '最多阻塞等待毫秒数（0 = 立刻返回 job_id）' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'album',
    description:
      '列出专辑 / 歌单 / 收藏夹 / 合集的一批条目（默认 20 首，带 hasMore 与 nextOffset）。'
      + '用户要「自己挑」时用这个，不要一次性全下。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '专辑/歌单/收藏夹/合集链接' },
        offset: { type: 'number', description: '从第几首开始（默认 0）' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'jobs',
    description: '查任务：不给 id 时列最近的任务，给 id 时查单个（进度、产物路径、错误）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id（可省略）' } },
      additionalProperties: false,
    },
  },
];

/** 从服务端启动行里抠出真实地址与 token（`--port 0` 时端口由系统分配）。 */
export function parseServerUrl(line: string): { base: string; token: string } | null {
  const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([0-9a-f]+)/i.exec(String(line || ''));
  return m ? { base: m[1], token: m[2] } : null;
}

/** 只留对模型有用的字段：整份 ProbeResult 有几 KB，塞进上下文就是浪费。 */
export function summarizeProbe(data: any) {
  const media = data?.media || {};
  const formats = Array.isArray(data?.formats) ? data.formats : [];
  return {
    ok: !!data?.ok,
    platform: data?.platform || null,
    engine: data?.engine || null,
    title: media.title || '',
    author: media.author || '',
    duration_ms: media.duration_ms ?? null,
    parts: (media.parts || []).map((p: any) => ({ index: p.index, title: p.title, url: p.url })),
    formats: formats.map((f: any) => ({
      id: f.id, label: f.label, ext: f.ext,
      width: f.width ?? null, height: f.height ?? null,
      bytes: f.bytes ?? null, bitrate: f.bitrate ?? null,
      available: f.available !== false,
      recommended: !!f.recommended,
    })),
    warnings: (data?.warnings || []).slice(0, 5),
  };
}

export function summarizeAlbum(data: any) {
  const album = data?.album || {};
  return {
    ok: !!data?.ok,
    title: album.title || '',
    kind: album.kind || null,
    total: album.total ?? null,
    offset: data?.offset ?? 0,
    hasMore: !!data?.hasMore,
    nextOffset: data?.nextOffset ?? null,
    tracks: (data?.tracks || []).map((t: any) => ({
      id: t.id, title: t.title, author: t.author, url: t.url,
    })),
    warnings: (data?.warnings || []).slice(0, 5),
  };
}

export function summarizeJob(job: any) {
  if (!job) return null;
  return {
    id: job.id,
    name: job.name || null,
    status: job.status,
    percent: job.percent,
    bytes: job.bytes,
    path: job.path || null,
    error: job.error ? { code: job.error.code, message: job.error.message } : null,
  };
}

const okText = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const errText = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** 把 HTTP 层的错误翻成模型能照做的一句话，保留原 code 与 next_action。 */
function errorText(data: any, status: number): string {
  const e = data?.error || {};
  const code = e.code || `http_${status}`;
  const msg = e.message || `接口返回 HTTP ${status}`;
  const next = e.next_action ? `；下一步：${e.next_action}` : '';
  return `${code}: ${msg}${next}`;
}

export interface RpcDeps {
  /** 调本地 HTTP 接口；测试里换成桩。`path` 形如 `/api/probe`。 */
  call: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; data: any }>;
  /** 等任务到终态（`get` 的 wait_ms 用）；测试里可立即返回。 */
  waitForJob?: (id: string, timeoutMs: number) => Promise<any>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 默认的「等任务到终态」：每 500ms 查一次，超时就把当前快照还回去（不假装成功）。 */
export function makeWaiter(deps: Pick<RpcDeps, 'call'>) {
  return async (id: string, timeoutMs: number) => {
    const until = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const { data } = await deps.call(`/api/jobs/${id}`);
      const job = data?.job;
      if (job && ['done', 'failed', 'cancelled'].includes(job.status)) return job;
      if (Date.now() >= until) return job || null;
      await sleep(500);
    }
  };
}

async function callTool(name: string, args: any, deps: RpcDeps): Promise<ToolResult> {
  try {
    if (name === 'probe') {
      const url = String(args?.url || '').trim();
      if (!url) return errText('bad_input: url 不能为空');
      const { status, data } = await deps.call('/api/probe', { method: 'POST', body: { url } });
      if (!data?.ok) return errText(errorText(data, status));
      return okText(summarizeProbe(data));
    }

    if (name === 'get') {
      const url = String(args?.url || '').trim();
      if (!url) return errText('bad_input: url 不能为空');
      const body = {
        url,
        formatIds: [String(args?.format_id || '')],
        subs: args?.subs === true,
        danmaku: args?.danmaku === true,
        cover: args?.cover === true,
      };
      const { status, data } = await deps.call('/api/jobs', { method: 'POST', body });
      if (!data?.ok) return errText(errorText(data, status));
      const job = data.job || (data.jobs || [])[0];
      if (!job?.id) return errText('unexpected: 建任务没有返回 id');
      const waitMs = Math.min(600_000, Math.max(0, Number(args?.wait_ms) || 0));
      if (!waitMs) return okText({ job_id: job.id, status: job.status, hint: '用 jobs 工具查进度' });
      const waiter = deps.waitForJob || makeWaiter(deps);
      const done = await waiter(job.id, waitMs);
      const summary = summarizeJob(done);
      if (done?.status === 'failed') {
        return errText(`${done?.error?.code || 'failed'}: ${done?.error?.message || '下载失败'}`);
      }
      if (done?.status !== 'done') {
        return okText({ ...summary, job_id: job.id, hint: `等满 ${waitMs}ms 仍未结束，用 jobs 继续查` });
      }
      return okText(summary);
    }

    if (name === 'album') {
      const url = String(args?.url || '').trim();
      if (!url) return errText('bad_input: url 不能为空');
      const body = { url, offset: Math.max(0, Number(args?.offset) || 0) };
      const { status, data } = await deps.call('/api/album', { method: 'POST', body });
      if (!data?.ok) return errText(errorText(data, status));
      return okText(summarizeAlbum(data));
    }

    if (name === 'jobs') {
      const id = String(args?.id || '').trim();
      const { status, data } = await deps.call(id ? `/api/jobs/${id}` : '/api/jobs');
      if (!data?.ok) return errText(errorText(data, status));
      if (id) return okText(summarizeJob(data.job));
      const list = (data.jobs || []).slice(-20).map(summarizeJob);
      return okText({ count: (data.jobs || []).length, recent: list });
    }

    return errText(`unknown_tool: ${name}`);
  } catch (err) {
    return errText(`error: ${(err as Error).message || String(err)}`);
  }
}

/** 处理一条 JSON-RPC 消息；通知（无 id）返回 null。 */
export async function handleRpc(msg: any, deps: RpcDeps): Promise<any | null> {
  const id = msg?.id;
  const isNotification = id === undefined || id === null;
  const reply = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => (isNotification
    ? null
    : { jsonrpc: '2.0', id, error: { code, message } });

  const method = String(msg?.method || '');

  if (method === 'initialize') {
    return reply({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null;
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS });
  if (method === 'tools/call') {
    const name = String(msg?.params?.name || '');
    const args = msg?.params?.arguments || {};
    const result = await callTool(name, args, deps);
    // MCP：工具级失败放在 result.isError，而不是 JSON-RPC error——否则宿主会当成协议故障
    return reply(result);
  }
  return fail(-32601, `Method not found: ${method}`);
}

/** 一条输入行 → 响应对象；空行/坏 JSON 也给出可诊断的答复。 */
export async function handleLine(line: string, deps: RpcDeps): Promise<any | null> {
  const text = String(line || '').trim();
  if (!text) return null;
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }
  return handleRpc(msg, deps);
}

/** 后端句柄：要么连已有实例，要么自己拉起一个。 */
export interface Backend {
  base: string;
  token: string;
  call: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; data: any }>;
  stop: () => void;
}

export function httpCaller(base: string, token: string) {
  return async (path: string, init?: { method?: string; body?: unknown }) => {
    const res = await fetch(`${base}${path}`, {
      method: init?.method || 'GET',
      headers: {
        'x-vdl-token': token,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
}

/**
 * 拿一个可用后端。优先复用（`VDACC_TOKEN` 存在时），否则自己拉起。
 * 拉起的进程挂着 stdout 管道：**只解析启动行**，其它输出直接丢掉（别混进协议）。
 */
export async function ensureBackend(): Promise<Backend> {
  const envBase = (process.env.VDACC_BASE_URL || '').trim().replace(/\/$/, '');
  const envToken = (process.env.VDACC_TOKEN || '').trim();
  if (envToken) {
    const base = envBase || 'http://127.0.0.1:8780';
    return { base, token: envToken, call: httpCaller(base, envToken), stop: () => {} };
  }

  const token = randomBytes(8).toString('hex');
  const serverPath = join(import.meta.dir, 'server.ts');
  const child = Bun.spawn([process.execPath, serverPath, '--port', '0', '--token', token], {
    cwd: join(import.meta.dir, '..', '..'),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...process.env },
  });

  // Bun 的 stdout 是 Web ReadableStream，不能直接喂 readline：自己按行切。
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('后端 15s 内没有启动（看 stderr 里的原因）')), 15_000);
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let settled = false;
    const finish = (base: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(base);
    };
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          for (let idx = buf.indexOf('\n'); idx >= 0; idx = buf.indexOf('\n')) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            const hit = parseServerUrl(line);
            if (hit) { finish(hit.base); return; }
          }
        }
      } catch { /* 管道关了：交给下面的 exited 判定 */ }
    })();
    child.exited.then((code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`后端提前退出（code ${code}）`));
    }).catch(() => undefined);
  });

  const stop = () => { try { child.kill(); } catch { /* 已经退了 */ } };
  process.on('exit', stop);
  return { base, token, call: httpCaller(base, token), stop };
}

async function main() {
  const backend = await ensureBackend();
  const deps: RpcDeps = { call: backend.call };
  const rl = createInterface({ input: process.stdin });
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

  // stdin 关闭（`echo ... | mcp` 或宿主退出）时不能立刻 exit：
  // 还有在飞的请求会把结果写丢，实测就是这样丢了 tools/call 的响应。
  let inflight = 0;
  let closed = false;
  const shutdown = () => {
    backend.stop();
    // 让 stdout 把最后一条写完再退（直接 exit 可能截断管道）
    setTimeout(() => process.exit(0), 20);
  };

  rl.on('line', (line) => {
    inflight += 1;
    void handleLine(line, deps)
      .then((res) => { if (res) write(res); })
      .catch((err) => write({
        jsonrpc: '2.0', id: null,
        error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
      }))
      .finally(() => {
        inflight -= 1;
        if (closed && inflight === 0) shutdown();
      });
  });
  rl.on('close', () => {
    closed = true;
    if (inflight === 0) shutdown();
  });
  process.on('SIGINT', shutdown);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`vdacc mcp 启动失败：${(err as Error).message}\n`);
    process.exit(1);
  });
}
