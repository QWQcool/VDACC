import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VdlError } from './errors';

/** 同目录临时文件原子替换，避免首次目录缺失或中途写入失败损坏旧存档。 */
export function writeJsonAtomic(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code || 'IO_ERROR';
    throw new VdlError('storage_write_failed', `用户数据保存失败（${code}）`,
      '检查用户数据目录的权限和可用空间后重试；原文件保留');
  } finally {
    try { unlinkSync(temporary); } catch { /* 未创建或已成功替换，不再删除其它路径。 */ }
  }
}
