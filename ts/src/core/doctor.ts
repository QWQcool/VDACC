/**
 * 只读诊断：不下载、不写日志、不改配置，只回答「这台机器现在能不能跑」。
 * 结论分三档：ok / warn / fail；fail 才让进程退出码为 1，warn 只是需要人看一眼。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SITES } from '../auth';
import { configPath, loadConfig } from './config';
import { componentPath, genericInstalled } from '../engines/generic';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
  /** 有问题时给一句可执行的话，别只说「失败」 */
  action?: string;
}

export interface DoctorReport {
  version: string;
  ok: boolean;
  checks: Check[];
}

/** `ffmpeg version 9.0.2-full_build-...` → `9.0.2-full_build-...` */
export function parseFfmpegVersion(text: string): string {
  const m = /ffmpeg version (\S+)/i.exec(text || '');
  return m ? m[1] : '';
}

export function exitCodeFor(checks: Check[]): number {
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

/** 从 `SHA2-256SUMS` 里取指定文件的哈希；找不到或格式不对返回空串。 */
export function pickSha256For(sumsText: string, fileName: string): string {
  const pattern = new RegExp(`(^|\\s)${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  for (const line of (sumsText || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    if (!pattern.test(line.trim())) continue;
    if (/^[0-9a-f]{64}$/i.test(parts[0])) return parts[0].toLowerCase();
  }
  return '';
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8'));
    return String(pkg.version || 'unknown');
  } catch {
    return 'unknown';
  }
}

function checkFfmpeg(): Check {
  const bin = process.env.VDL_FFMPEG || 'ffmpeg';
  const run = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (run.error || run.status !== 0) {
    return {
      id: 'ffmpeg', label: 'ffmpeg', level: 'fail',
      detail: run.error ? `找不到 ${bin}` : `退出码 ${run.status}`,
      action: '安装后把 ffmpeg 放进 PATH，或用 VDL_FFMPEG 指定完整路径（winget install Gyan.FFmpeg）',
    };
  }
  const version = parseFfmpegVersion(`${run.stdout || ''}${run.stderr || ''}`);
  return { id: 'ffmpeg', label: 'ffmpeg', level: 'ok', detail: version || bin };
}

function checkComponent(): Check {
  if (!genericInstalled()) {
    return {
      id: 'ytdlp', label: '通用组件 yt-dlp', level: 'warn',
      detail: '未安装',
      action: '需要通用站点时在设置里点「下载组件」；只下内置平台可以不装',
    };
  }
  const path = componentPath();
  const bytes = statSync(path).size;
  const mb = (bytes / 1048576).toFixed(1);
  const expected = loadConfig().ytdlpSha256;
  if (!expected) {
    return {
      id: 'ytdlp', label: '通用组件 yt-dlp', level: 'warn',
      detail: `已安装 ${mb} MB，但安装时未记录校验值（旧安装）`,
      action: '重新安装一次以记录 SHA256；未校验的组件不应被当成可信',
    };
  }
  const actual = sha256File(path);
  if (actual !== expected) {
    return {
      id: 'ytdlp', label: '通用组件 yt-dlp', level: 'fail',
      detail: `校验不一致（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`,
      action: '删除后重新安装组件，不要继续使用被替换过的可执行文件',
    };
  }
  return { id: 'ytdlp', label: '通用组件 yt-dlp', level: 'ok', detail: `已安装 ${mb} MB，SHA256 已校验` };
}

function checkConfig(): Check {
  const path = configPath();
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    return { id: 'config', label: '配置文件', level: 'ok', detail: `${path}（并发 ${cfg.concurrency ?? 1}）` };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      id: 'config', label: '配置文件', level: missing ? 'ok' : 'warn',
      detail: missing ? '尚无配置文件（首次保存设置时创建）' : `读取失败：${(err as Error).message}`,
      action: missing ? undefined : '配置文件损坏时会被忽略；在设置里保存一次即可重建',
    };
  }
}

function checkOutDir(): Check {
  const outDir = loadConfig().outDir || '下载';
  try {
    mkdirSync(outDir, { recursive: true });
    const probe = join(outDir, '.vdacc-write-test');
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return { id: 'outDir', label: '输出目录', level: 'ok', detail: outDir };
  } catch (err) {
    return {
      id: 'outDir', label: '输出目录', level: 'fail',
      detail: `${outDir}：${(err as Error).message}`,
      action: '换一个有写权限的目录（设置 → 输出目录）',
    };
  }
}

function checkAuth(): Check[] {
  const base = join(process.env.LOCALAPPDATA || '', 'vdl', 'auth');
  return Object.entries(SITES).map(([site, info]) => {
    const file = join(base, `${site}.json`);
    if (!existsSync(file)) {
      return {
        id: `auth-${site}`, label: `凭据 ${info.label}`, level: 'warn',
        detail: '本地无凭据（匿名档可用）',
        action: `bun ts/src/cli.ts auth ${site}`,
      };
    }
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      const n = (state.cookies || []).length;
      return { id: `auth-${site}`, label: `凭据 ${info.label}`, level: 'ok', detail: `${n} cookies（是否仍有效需 auth --status）` };
    } catch {
      return {
        id: `auth-${site}`, label: `凭据 ${info.label}`, level: 'warn',
        detail: '文件损坏', action: `bun ts/src/cli.ts auth ${site}`,
      };
    }
  });
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: Check[] = [
    {
      id: 'runtime', label: '运行时', level: 'ok',
      detail: `Bun ${Bun.version} · ${process.platform} ${process.arch} · 应用 ${appVersion()}`,
    },
    checkFfmpeg(),
    checkComponent(),
    checkConfig(),
    checkOutDir(),
    ...checkAuth(),
  ];
  return { version: appVersion(), ok: checks.every((c) => c.level !== 'fail'), checks };
}
