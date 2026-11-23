/**
 * MCP 适配层：协议帧与工具映射。
 *
 * 这里**不碰网络、不启后端**——`call` 由用例注入。真实链路由手工验证覆盖：
 * `printf '…' | bun ts/src/mcp.ts`（会自己拉起 server.ts，实测能解析出 B站 稿件）。
 * 之所以这么切：协议层错了是「整条连接废掉」，网络层错了只是「这次失败」，两者不该混在一起测。
 */
import { describe, expect, test } from 'bun:test';

import {
  SERVER_NAME, TOOLS, ensureBackend, handleLine, handleRpc, httpCaller, makeWaiter,
  silenceStdout, summarizeAlbum, summarizeJob, summarizeProbe,
} from '../src/mcp';

const okCall = (data: any) => async () => ({ status: 200, data });

describe('MCP 协议帧', () => {
  test('initialize 回协议版本与工具能力，serverInfo.name 固定为 vdacc', async () => {
    const res = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { call: okCall({}) });
    expect(res.result.protocolVersion).toBeTruthy();
    expect(res.result.capabilities.tools).toBeDefined();
    expect(res.result.serverInfo.name).toBe(SERVER_NAME);
    expect(res.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('通知（没有 id）不回包', async () => {
    const res = await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { call: okCall({}) });
    expect(res).toBeNull();
  });

  test('tools/list 给出四个工具，且都声明了必填入参', () => {
    return handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { call: okCall({}) }).then((res) => {
      const names = res.result.tools.map((t: any) => t.name);
      expect(names).toEqual(['probe', 'get', 'album', 'jobs']);
      for (const tool of res.result.tools) {
        expect(tool.description.length).toBeGreaterThan(10);
        expect(tool.inputSchema.type).toBe('object');
      }
      const probe = res.result.tools.find((t: any) => t.name === 'probe');
      expect(probe.inputSchema.required).toEqual(['url']);
    });
  });

  test('未知方法回 -32601；坏 JSON 回 -32700', async () => {
    const res = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'no/such' }, { call: okCall({}) });
    expect(res.error.code).toBe(-32601);
    const bad = await handleLine('{not json', { call: okCall({}) });
    expect(bad.error.code).toBe(-32700);
  });

  test('空行忽略（宿主偶尔会送空行）', async () => {
    expect(await handleLine('   ', { call: okCall({}) })).toBeNull();
  });
});

describe('工具映射', () => {
  const probeData = {
    ok: true, platform: 'bilibili', engine: 'bilibili-api',
    media: { title: '标题', author: 'UP', duration_ms: 1000, parts: [{ index: 1, title: 'P1', url: 'u' }] },
    formats: [
      { id: 'bili-1920', label: '1080P', ext: 'mp4', width: 1920, height: 1080, bytes: 100, recommended: true },
      { id: 'audio', label: '仅音频', ext: 'm4a', available: false, reason: 'x' },
    ],
    warnings: [],
  };

  test('probe 只留有用字段（整份结果几 KB，塞进上下文就浪费）', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'probe', arguments: { url: 'u' } } },
      { call: okCall(probeData) },
    );
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.title).toBe('标题');
    expect(payload.formats.map((f: any) => f.id)).toEqual(['bili-1920', 'audio']);
    expect(payload.formats[1].available).toBe(false);
    // 不该把整份 ProbeResult 原样丢出去
    expect(payload.schema).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
  });

  test('接口报错时 isError=true，并保留 code 与下一步', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'probe', arguments: { url: 'u' } } },
      { call: async () => ({ status: 400, data: { ok: false, error: { code: 'bad_input', message: '认不出', next_action: '给完整链接' } } }) },
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('bad_input');
    expect(res.result.content[0].text).toContain('给完整链接');
  });

  test('get 不等待时只回 job_id，并提示用 jobs 查', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get', arguments: { url: 'u' } } },
      { call: okCall({ ok: true, job: { id: 'abc', status: 'queued' } }) },
    );
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.job_id).toBe('abc');
    expect(payload.hint).toContain('jobs');
  });

  test('get + wait_ms：完成回路径，失败回 isError，超时不假装成功', async () => {
    const done = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get', arguments: { url: 'u', wait_ms: 1000 } } },
      {
        call: okCall({ ok: true, job: { id: 'j1', status: 'queued' } }),
        waitForJob: async () => ({ id: 'j1', status: 'done', percent: 100, bytes: 9, path: 'C:/x.mp4' }),
      },
    );
    const donePayload = JSON.parse(done.result.content[0].text);
    expect(donePayload.path).toBe('C:/x.mp4');
    expect(done.result.isError).toBeUndefined();

    const failed = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get', arguments: { url: 'u', wait_ms: 1000 } } },
      {
        call: okCall({ ok: true, job: { id: 'j2', status: 'queued' } }),
        waitForJob: async () => ({ id: 'j2', status: 'failed', error: { code: 'filtered', message: '需要付费' } }),
      },
    );
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0].text).toContain('需要付费');

    const timeout = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get', arguments: { url: 'u', wait_ms: 10 } } },
      {
        call: okCall({ ok: true, job: { id: 'j3', status: 'running' } }),
        waitForJob: async () => ({ id: 'j3', status: 'running', percent: 42 }),
      },
    );
    const timeoutPayload = JSON.parse(timeout.result.content[0].text);
    expect(timeout.result.isError).toBeUndefined();
    expect(timeoutPayload.job_id).toBe('j3');
    expect(timeoutPayload.hint).toContain('jobs');
  });

  test('album 与 jobs 的摘要只留模型要用的字段', async () => {
    const album = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'album', arguments: { url: 'u' } } },
      { call: okCall({ ok: true, album: { title: '专辑', kind: 'album', total: 12 }, offset: 0, hasMore: true, nextOffset: 20, tracks: [{ id: 'h', title: 't', author: 'a', url: 'u' }] }) },
    );
    const albumPayload = JSON.parse(album.result.content[0].text);
    expect(albumPayload.nextOffset).toBe(20);
    expect(albumPayload.tracks[0]).toEqual({ id: 'h', title: 't', author: 'a', url: 'u' });

    const jobs = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jobs', arguments: {} } },
      { call: okCall({ ok: true, jobs: [{ id: 'a', status: 'done', percent: 100, bytes: 1, path: 'p', extra: 'x' }] }) },
    );
    const jobsPayload = JSON.parse(jobs.result.content[0].text);
    expect(jobsPayload.count).toBe(1);
    expect(jobsPayload.recent[0].extra).toBeUndefined();
  });

  test('未知工具名明确报错，而不是静默回空', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      { call: okCall({ ok: true }) },
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('unknown_tool');
  });

  test('调用抛异常时包成 isError，不炸掉整条连接', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'probe', arguments: { url: 'u' } } },
      { call: async () => { throw new Error('连接被拒绝'); } },
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('连接被拒绝');
  });
});

describe('摘要函数', () => {
  test('summarizeProbe 保住推荐档与失败原因的距离', () => {
    const s = summarizeProbe({
      ok: true, platform: 'qq', media: { title: 't' },
      formats: [{ id: 'a', recommended: true, available: true }, { id: 'b', available: false, reason: 'result=104003' }],
    });
    expect(s.formats[0].recommended).toBe(true);
    expect(s.formats[1].available).toBe(false);
    // reason 不进摘要（太长），但 available 必须真实反映「不可用」
    expect((s.formats[1] as any).reason).toBeUndefined();
  });

  test('summarizeJob / summarizeAlbum 对缺字段不炸', () => {
    expect(summarizeJob(null)).toBeNull();
    expect(summarizeAlbum({})).toMatchObject({ ok: false, tracks: [] });
  });

  test('工具清单是固定的四项（防止手滑加第 5 个又没写描述）', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['probe', 'get', 'album', 'jobs']);
  });
});

describe('HTTP 客户端与后端复用', () => {
  test('httpCaller 带 token 头、序列化 body、解析 JSON', async () => {
    const original = globalThis.fetch;
    const seen: any = {};
    globalThis.fetch = (async (url: any, init: any) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      const call = httpCaller('http://127.0.0.1:1', 'tok');
      const res = await call('/api/probe', { method: 'POST', body: { url: 'u' } });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(seen.url).toBe('http://127.0.0.1:1/api/probe');
      expect(seen.init.headers['x-vdl-token']).toBe('tok');
      expect(seen.init.body).toBe('{"url":"u"}');
    } finally { globalThis.fetch = original; }
  });

  test('设了 VDACC_TOKEN 就复用已开实例，不再内嵌一个', async () => {
    const saved = { base: process.env.VDACC_BASE_URL, token: process.env.VDACC_TOKEN };
    process.env.VDACC_TOKEN = 't1';
    process.env.VDACC_BASE_URL = 'http://127.0.0.1:9999/';
    try {
      const backend = await ensureBackend();
      expect(backend.base).toBe('http://127.0.0.1:9999');   // 末尾斜杠被去掉
      expect(backend.token).toBe('t1');
      backend.stop();   // 不拥有进程，stop 应当是空操作
    } finally {
      if (saved.token === undefined) delete process.env.VDACC_TOKEN;
      else process.env.VDACC_TOKEN = saved.token;
      if (saved.base === undefined) delete process.env.VDACC_BASE_URL;
      else process.env.VDACC_BASE_URL = saved.base;
    }
  });

  test('silenceStdout 把日志改道到 stderr，且能还原', () => {
    const original = console.log;
    const writes: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => { writes.push(String(chunk)); return true; };
    const restore = silenceStdout();
    try {
      console.log('不该进 stdout');
      expect(console.log).not.toBe(original);
      expect(writes.join('')).toContain('不该进 stdout');
    } finally {
      restore();
      (process.stderr as any).write = realWrite;
    }
    expect(console.log).toBe(original);
  });

  test('makeWaiter 轮询到终态就返回，超时则把当前快照交回去', async () => {
    let polled = 0;
    const done = makeWaiter({
      call: async () => {
        polled += 1;
        return { status: 200, data: { ok: true, job: { id: 'j', status: polled >= 2 ? 'done' : 'running' } } };
      },
    });
    expect((await done('j', 5000)).status).toBe('done');
    expect(polled).toBe(2);

    const timeout = makeWaiter({
      call: async () => ({ status: 200, data: { ok: true, job: { id: 'k', status: 'running' } } }),
    });
    const partial = await timeout('k', 0);
    expect(partial.status).toBe('running');   // 不假装完成
  });
});
