import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  outDir?: string;
  theme?: 'light' | 'dark';
  concurrency?: number;
  limitRate?: number;
  allowGeneric?: boolean;
}

const FILE = join(process.env.LOCALAPPDATA || '', 'vdl', 'config.json');

export function loadConfig(): Config {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(patch: Config): Config {
  const next = { ...loadConfig(), ...patch };
  try {
    writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // 配置写不进去不影响本次运行
  }
  return next;
}
