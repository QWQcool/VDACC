import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fetchMediaStream, jailedPath, originAllowed, streamUrlAllowed } from '../src/core/security';

const dir = mkdtempSync(join(tmpdir(), 'vdl-security-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('完整 Origin 与真实路径边界', () => {
  const base = 'http://127.0.0.1:8765';
  const req = (origin: string, url = base) => new Request(url + '/api/health', { headers: { Origin: origin } });
  test('拒绝本机名前缀、错误端口、协议、路径和 opaque origin', () => {
    for (const origin of ['http://localhost.evil.invalid', 'http://127.0.0.1.evil.invalid',
      'http://127.0.0.1:9999', 'https://127.0.0.1:8765', base + '/', 'null']) {
      expect(originAllowed(req(origin))).toBe(false);
    }
    expect(originAllowed(req(base))).toBe(true);
    expect(originAllowed(new Request(base))).toBe(true);
  });
  test('LAN 和显式宿主允许项同样要求完整匹配', () => {
    const lan = 'http://192.168.1.8:8765';
    expect(originAllowed(req(lan, lan))).toBe(true);
    expect(originAllowed(req('http://192.168.1.9:8765', lan))).toBe(false);
    expect(originAllowed(req('https://host.example'), 'https://host.example')).toBe(true);
    expect(originAllowed(req('https://host.example.evil'), 'https://host.example')).toBe(false);
  });
  test('拒绝相邻前缀目录、目录自身与 junction 逃逸；允许真实子文件', () => {
    const root = join(dir, 'out'), adjacent = join(dir, 'out-neighbor');
    mkdirSync(root); mkdirSync(adjacent);
    writeFileSync(join(root, 'ok.txt'), 'inside');
    writeFileSync(join(adjacent, 'private.txt'), 'outside');
    symlinkSync(adjacent, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(jailedPath(root, join(root, 'ok.txt'))).toBe(resolve(root, 'ok.txt'));
    expect(jailedPath(root, join(adjacent, 'private.txt'))).toBeNull();
    expect(jailedPath(root, join(root, 'linked', 'private.txt'))).toBeNull();
    expect(jailedPath(root, root)).toBeNull();
    expect(jailedPath(root, root, false)).toBe(resolve(root));
  });
});

describe('媒体代理逐跳验证', () => {
  test('拒绝域名前缀、凭据、非标准端口、非 QQ 明文 HTTP', () => {
    for (const url of ['https://bilivideo.com.evil.invalid/v', 'https://evilbilivideo.com/v',
      'https://u:p@bilivideo.com/v', 'https://bilivideo.com:9000/v', 'http://bilivideo.com/v']) {
      expect(streamUrlAllowed(url)).toBe(false);
    }
    expect(streamUrlAllowed('https://cn.bilivideo.com/v')).toBe(true);
    expect(streamUrlAllowed('http://dl.stream.qqmusic.qq.com/v')).toBe(true);
  });
  test('白名单重定向到内网时不会发出第二个请求', async () => {
    const calls: string[] = [];
    await expect(fetchMediaStream('https://cn.bilivideo.com/v', {}, async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
    })).rejects.toMatchObject({ code: 'forbidden' });
    expect(calls).toHaveLength(1);
  });
  test('合法跳转保留 Range/HEAD，循环被终止', async () => {
    let calls = 0;
    const res = await fetchMediaStream('https://cn.bilivideo.com/a', {
      method: 'HEAD', headers: { Range: 'bytes=5-9' },
    }, async (_url, init) => {
      expect(init.redirect).toBe('manual');
      expect(init.method).toBe('HEAD');
      expect(new Headers(init.headers).get('range')).toBe('bytes=5-9');
      return ++calls === 1 ? new Response(null, { status: 307, headers: { Location: '/b' } })
        : new Response(null, { status: 206, headers: { 'Content-Range': 'bytes 5-9/10' } });
    });
    expect(res.status).toBe(206); expect(calls).toBe(2);
    await expect(fetchMediaStream('https://cn.bilivideo.com/a', {}, async () =>
      new Response(null, { status: 302, headers: { Location: '/a' } })))
      .rejects.toMatchObject({ code: 'redirect_loop' });
  });
});
