import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * infOS Package 的静态契约检查（不联网、不需要 infOS 宿主）。
 *
 * 依据是 `.docs/A06_EXTENSION_SYSTEM.md`：Manifest V2 字段、上传包允许的贡献 kind、
 * 只收已编译 ESM、拒绝 node_modules、20 MiB / 64 MiB 体积上限。
 * 这些规则如果被破坏，ZIP 在安装器那一步就会被拒——所以要在仓库里先拦住。
 */
const ROOT = join(import.meta.dir, '..', '..', 'integrations', 'infos', 'package');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('infOS Package 静态契约', () => {
  test('manifest 是 Manifest V2，且不冒充 official', () => {
    expect(manifest.manifestVersion).toBe(2);
    expect(typeof manifest.packageId).toBe('string');
    expect(manifest.packageId.length).toBeGreaterThan(3);
    expect(typeof manifest.name).toBe('string');
    expect(/^\d+\.\d+\.\d+$/.test(manifest.version)).toBe(true);
    // 上传包只能声明 user / generated
    expect(['user', 'generated']).toContain(manifest.trust);
    expect(Array.isArray(manifest.contributions)).toBe(true);
  });

  test('贡献只用上传包放行的 kind（application/runtime-adapter/policy 会激活失败）', () => {
    const allowed = new Set([
      'tool', 'skill', 'event-subscriber', 'service', 'capability-provider',
      'context-provider', 'agent-flow', 'presenter', 'web-ui', 'asset',
    ]);
    for (const item of manifest.contributions) {
      expect(allowed.has(item.kind)).toBe(true);
      expect(typeof item.id).toBe('string');
    }
    // id 不能重复（会撞 package:<packageId>/<id> 命名）
    const ids = manifest.contributions.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('每个贡献的 entry 都在包内且真实存在', () => {
    for (const item of manifest.contributions) {
      const full = join(ROOT, item.entry);
      expect(existsSync(full)).toBe(true);
      // 不得越出 Package Root
      expect(relative(ROOT, full).startsWith('..')).toBe(false);
    }
  });

  test('tool 贡献导出 createContribution，definition 合规', async () => {
    const tools = manifest.contributions.filter((c: any) => c.kind === 'tool');
    expect(tools.length).toBeGreaterThan(0);
    for (const item of tools) {
      const mod = await import(join(ROOT, item.entry));
      expect(typeof mod.createContribution).toBe('function');
      const built = mod.createContribution({ dataDirectory: '/tmp/vdacc-pkg', onDispose() {} });
      expect(built.definition.name).toMatch(/^vdl_[a-z]+$/);
      expect(typeof built.definition.description).toBe('string');
      expect(built.definition.parameters.type).toBe('object');
      expect(typeof built.execute).toBe('function');
    }
  });

  test('只收已编译 ESM、没有 node_modules、体积在上限内', () => {
    const files = walk(ROOT);
    const scripts = files.filter((f) => /\.(ts|tsx|cts|mts)$/.test(f));
    expect(scripts).toEqual([]);
    const modules = files.filter((f) => f.endsWith('.js'));
    for (const file of modules) {
      // 纯 .js 必须靠 package.json 的 type:module 才被当 ESM，这里只做提示性断言
      expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).type).toBe('module');
    }
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    const bytes = files.reduce((sum, f) => sum + statSync(f).size, 0);
    expect(bytes).toBeLessThan(20 * 1024 * 1024);
  });
});
