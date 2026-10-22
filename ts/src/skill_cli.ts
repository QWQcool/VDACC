/** Skill 专用入口：只含 probe/get，不引 auth/playwright，保持单文件体积可控。 */
import { getDouyin, probeDouyin } from './engines/douyin';
import { getNetease, probeNetease } from './engines/netease';
import { getBilibiliApi, probeBilibiliApi } from './engines/bilibili_api';
import { fail, VdlError } from './core/errors';
import type { ProbeResult } from './core/types';

const argv = Bun.argv.slice(2);
const cmd = argv[0] || '';
const positional = argv.slice(1).filter((a) => !a.startsWith('-'));
const flag = (name: string, def: string | null = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : def;
};

function platformOf(url: string): string {
  const raw = (url || '').trim();
  if (/^\d{15,20}$/.test(raw) || /douyin\.com/.test(raw)) return 'douyin';
  if (/^\d{1,12}$/.test(raw) || /music\.163\.com|163cn\.tv/.test(raw)) return 'netease';
  if (/^BV[0-9A-Za-z]{10}$/.test(raw) || /bilibili\.com|b23\.tv/.test(raw)) return 'bilibili';
  return 'unsupported';
}

async function probe(url: string): Promise<ProbeResult> {
  const platform = platformOf(url);
  if (platform === 'unsupported') {
    throw new VdlError('unsupported_url',
      '这个 Skill 只支持抖音 / B站 / 网易云，未内置 yt-dlp 兜底',
      '需要长尾站点请用桌面完整版（可选组件）');
  }
  if (platform === 'douyin') return probeDouyin(url);
  if (platform === 'netease') return probeNetease(url);
  return probeBilibiliApi(url);
}

async function main() {
  const url = positional[0];
  if (!url || !['probe', 'get'].includes(cmd)) {
    console.error('用法: vdl probe|get <url> [--format id] [-o dir]');
    process.exit(2);
  }

  try {
    if (cmd === 'probe') {
      const result = await probe(url);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    }

    const platform = platformOf(url);
    const outDir = flag('-o', '下载') || '下载';
    const out = platform === 'douyin'
      ? await getDouyin(url, flag('--format'), outDir)
      : platform === 'netease'
        ? await getNetease(url, flag('--format'), outDir)
        : await getBilibiliApi(url, flag('--format'), outDir);
    console.log(JSON.stringify({
      schema: 2, ok: true, path: out.path, bytes: out.bytes,
      skipped: 'skipped' in out ? out.skipped : false,
      warnings: 'warnings' in out ? out.warnings : [],
    }, null, 2));
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify(fail(platformOf(url), 'ts-skill', err), null, 2));
    process.exit(1);
  }
}

await main();
