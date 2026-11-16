/**
 * 版本号一致性守护。
 *
 * 起因：3.5.0 这一轮结束后，`package.json` 已经是 3.5.0，而
 * `docs/release-baseline.json` 还停在 3.4.2、`/api/health` 的版本号也要靠人肉同步
 * （`docs/RELEASE.md` 里列了四处）。漂移不会让任何测试变红，只会在发版时漏改一处。
 *
 * 这里把「四处 + 基线」钉在一起：任何一处单独改了而其它没改，这条用例就失败。
 * 版本号本身不在代码里推导——`server.ts` 要能单独编译成 exe，不读 package.json。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

function readText(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

function pkgVersion(...parts: string[]): string {
  return (JSON.parse(readText(...parts)) as { version?: string }).version ?? '';
}

/** `/api/health` 返回值里的版本（唯一一处不能从 package.json 读的地方）。 */
function healthVersion(): string {
  const m = /ok: true, version: '([^']+)'/.exec(readText('ts', 'src', 'server.ts'));
  return m?.[1] ?? '';
}

/** 服务端用例里对 health 版本的断言。 */
function testVersion(): string {
  const m = /expect\(data\.version\)\.toBe\('([^']+)'\)/.exec(readText('ts', 'tests', 'server.test.ts'));
  return m?.[1] ?? '';
}

describe('版本号四处同步', () => {
  test('根 package.json / ts/package.json / server.ts / server.test.ts 完全一致', () => {
    const root = pkgVersion('package.json');
    expect(root).toMatch(SEMVER);
    expect(pkgVersion('ts', 'package.json')).toBe(root);
    expect(healthVersion()).toBe(root);
    expect(testVersion()).toBe(root);
  });

  test('发布体积基线与当前版本一致（改了版本就要重跑 release_baseline.cjs --update）', () => {
    const baseline = JSON.parse(readText('docs', 'release-baseline.json')) as { version?: string };
    expect(baseline.version).toBe(pkgVersion('package.json'));
  });
});
