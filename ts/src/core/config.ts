import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { VdlError } from './errors';
import { writeJsonAtomic } from './storage';
import type { Config } from './types';
export type { Config } from './types';

export const configPath = () => join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'vdl', 'config.json');

/** API 和磁盘都做类型检查，防止假值、非法限速或未实现的并发悄悄生效。 */
function validate(value: unknown, fromDisk = false): Config {
  const bad = () => { throw new VdlError('bad_input', '设置字段或取值无效', '检查目录、主题、限速和通用组件开关；当前并发固定为 1'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const v = value as Config;
  if (v.outDir !== undefined && (typeof v.outDir !== 'string' || v.outDir.length > 4096 || v.outDir.includes('\0'))) return bad();
  if (v.theme !== undefined && v.theme !== 'light' && v.theme !== 'dark') return bad();
  if (v.limitRate !== undefined && (!Number.isSafeInteger(v.limitRate) || v.limitRate < 0)) return bad();
  if (v.allowGeneric !== undefined && typeof v.allowGeneric !== 'boolean') return bad();
  if (v.concurrency !== undefined && (!Number.isInteger(v.concurrency) || v.concurrency < 1 || v.concurrency > (fromDisk ? 4 : 1))) return bad();
  const clean: Config = {};
  for (const key of ['outDir', 'theme', 'limitRate', 'allowGeneric'] as const) {
    if (v[key] !== undefined) (clean as any)[key] = v[key];
  }
  // 旧配置曾允许选 1–4，但服务从未实现并发；读取时明确回到真实能力。
  if (v.concurrency !== undefined) clean.concurrency = 1;
  return clean;
}

export function loadConfig(file = configPath()): Config {
  if (!existsSync(file)) return {};
  try {
    return validate(JSON.parse(readFileSync(file, 'utf8')), true);
  } catch {
    throw new VdlError('config_invalid', '用户配置无法读取或内容无效', '备份并修复用户数据目录中的 config.json 后重试；不会覆盖原文件');
  }
}

export function saveConfig(patch: Config, file = configPath()): Config {
  const next = { ...loadConfig(file), ...validate(patch) };
  writeJsonAtomic(file, next);
  return next;
}
