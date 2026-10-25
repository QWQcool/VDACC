import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const command of ['probe', 'get']) {
  test(`Skill ${command} 明确拒绝未内置的平台，不误送 B站`, async () => {
    for (const url of ['https://y.qq.com/n/ryqq/songDetail/abc', 'https://www.kuwo.cn/play_detail/123',
      'https://www.kugou.com/song/abc.html', 'https://example.invalid/media.mp4']) {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../src/skill_cli.ts'), command, '--format', 'best', url],
        { stdout: 'pipe', stderr: 'pipe' });
      const data = JSON.parse(await new Response(proc.stdout).text());
      expect(await proc.exited).toBe(1);
      expect(data.schema).toBe(2); expect(data.ok).toBe(false);
      expect(data.error.code).toBe('unsupported_url');
      expect(data.error.message).not.toContain('BV');
    }
  });
}
