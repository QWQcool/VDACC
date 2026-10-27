import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, saveConfig } from '../src/core/config';
import { writeJsonAtomic } from '../src/core/storage';

const dir = mkdtempSync(join(tmpdir(), 'vdl-storage-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('全新用户目录首次保存即创建父目录，增量保存不丢字段', () => {
  const file = join(dir, 'fresh', 'vdl', 'config.json');
  expect(loadConfig(file)).toEqual({});
  saveConfig({ theme: 'dark', limitRate: 1024 }, file);
  saveConfig({ allowGeneric: true }, file);
  expect(loadConfig(file)).toEqual({ theme: 'dark', limitRate: 1024, allowGeneric: true });
  expect(readdirSync(join(dir, 'fresh', 'vdl'))).toEqual(['config.json']);
});

test('拒绝无效设置；并发允许 1–4，越界仍拒绝', () => {
  const file = join(dir, 'validate.json');
  for (const patch of [null, [], { limitRate: -1 }, { limitRate: '2M' }, { concurrency: 0 },
    { concurrency: 5 }, { concurrency: 1.5 },
    { allowGeneric: 'false' }, { theme: 'unknown' }, { outDir: 2 }]) {
    expect(() => saveConfig(patch as any, file)).toThrow();
  }
  writeFileSync(file, JSON.stringify({ concurrency: 4, theme: 'dark' }));
  expect(loadConfig(file)).toEqual({ concurrency: 4, theme: 'dark' });
});

test('配置损坏不覆盖原文件，目录不可写不能假报成功', () => {
  const file = join(dir, 'corrupt.json');
  writeFileSync(file, '{broken');
  expect(() => saveConfig({ theme: 'light' }, file)).toThrow('用户配置无法读取');
  expect(readFileSync(file, 'utf8')).toBe('{broken');
  const blocked = join(dir, 'is-a-file');
  writeFileSync(blocked, 'keep');
  expect(() => writeJsonAtomic(join(blocked, 'config.json'), {})).toThrow('用户数据保存失败');
  expect(readFileSync(blocked, 'utf8')).toBe('keep');
});

test('序列化失败保留旧存档且不遗留临时文件', () => {
  const file = join(dir, 'atomic.json');
  writeJsonAtomic(file, { original: true });
  const circular: any = {}; circular.self = circular;
  expect(() => writeJsonAtomic(file, circular)).toThrow();
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ original: true });
  expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
});
