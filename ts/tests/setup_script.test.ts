/**
 * 环境准备脚本的守护用例。
 *
 * 起因（2026-11-16 复原）：快照只恢复入库文件，Bun / ffmpeg / node_modules 全没了，
 * 而当时 winget（App Installer）本身也缺失，README 里那几行 winget 命令一条都跑不了。
 * 所以环境准备被收敛成 `scripts/setup.ps1`，这里锁住三件容易悄悄坏掉的事：
 *
 * 1. 脚本必须是 **UTF-8 with BOM** —— Windows PowerShell 5.1 按 ANSI 读无 BOM 的脚本，
 *    中文注释会让它整段报 `UnexpectedToken`（本次实现时当场踩到，不是假设）；
 * 2. 脚本不能依赖 winget，必须能从官方地址自己下（本机 winget 就不存在）；
 * 3. `package.json` 的 `engines.bun` 与 CI 固定的版本一致，避免「本地能跑、CI 却跑不动」。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const scriptPath = join(root, 'scripts', 'setup.ps1');

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('scripts/setup.ps1', () => {
  test('存在，且是 UTF-8 with BOM（PowerShell 5.1 读无 BOM 脚本会把中文当 ANSI）', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const buf = readFileSync(scriptPath);
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  test('不调用 winget，自己从官方地址取 Bun 与 ffmpeg', () => {
    const text = readText(scriptPath);
    expect(/winget\s+install/i.test(text)).toBe(false);
    expect(text).toContain('github.com/oven-sh/bun/releases');
    expect(text).toContain('gyan.dev/ffmpeg/builds');
  });

  test('有可复用的开关：只检查（-SkipInstall）与跳过依赖（-SkipDeps）', () => {
    const text = readText(scriptPath);
    expect(text).toContain('[switch]$SkipInstall');
    expect(text).toContain('[switch]$SkipDeps');
  });

  test('两个 package.json 都声明 engines.bun >= 1.4.4', () => {
    for (const file of ['package.json', join('ts', 'package.json')]) {
      const pkg = JSON.parse(readText(join(root, file))) as { engines?: { bun?: string } };
      expect(pkg.engines?.bun).toBe('>=1.4.4');
    }
  });

  test('README 与环境文档都指向脚本（新机器只有一条命令能记）', () => {
    expect(readText(join(root, 'README.md'))).toContain('scripts\\setup.ps1');
    expect(readText(join(root, 'AGENTS.md'))).toContain('scripts\\setup.ps1');
  });
});
