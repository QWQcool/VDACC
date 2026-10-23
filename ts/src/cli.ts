import { getDouyin, probeDouyin } from './engines/douyin';
import { getNetease, probeNetease } from './engines/netease';
import { probeBilibili } from './engines/bilibili';
import { getBilibiliApi, probeBilibiliApi } from './engines/bilibili_api';
import { loadConfig } from './core/config';
import { VdlError, fail } from './core/errors';
import { platformOf } from './core/platform';
import { parseLimit, setLimitBytesPerSec } from './core/rate';
import { genericInstalled, getGeneric, probeGeneric } from './engines/generic';
import type { ProbeResult } from './core/types';

const argv = Bun.argv.slice(2);
const cmd = argv[0] || '';
const positional = argv.slice(1).filter((a) => !a.startsWith('-'));
const flag = (name: string, def: string | null = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : def;
};
const has = (name: string) => argv.includes(name);

async function probe(url: string): Promise<ProbeResult> {
  const platform = platformOf(url);
  switch (platform) {
    case 'douyin': return probeDouyin(url);
    case 'netease': return probeNetease(url);
    case 'bilibili':
      return process.env.VDL_BILI_ENGINE === 'ytdlp'
        ? probeBilibili(url)
        : probeBilibiliApi(url);
    default: {
      if (loadConfig().allowGeneric && genericInstalled()) return probeGeneric(url);
      throw new VdlError('engine_unavailable', `不支持的站点: ${url}`,
        genericInstalled() ? '启用通用解析后重试：bun ts/src/cli.ts config? 或设置 allowGeneric'
          : '下载通用组件：bun ts/src/server.ts 然后在设置里安装');
    }
  }
}

function human(res: ProbeResult) {
  if (!res.ok || !res.media) {
    console.error(`失败 [${res.error?.code}] ${res.error?.message}`);
    if (res.error?.next_action) console.error(`下一步: ${res.error.next_action}`);
    return;
  }
  const m = res.media;
  console.log(m.title);
  console.log(`  ${m.author || '未知作者'} · ${m.platform} / ${res.engine}`);
  for (const f of res.formats) {
    const size = f.bytes ? `${(f.bytes / 1048576).toFixed(2)} MB` : '未知';
    console.log(`  ${f.id.padEnd(14)} ${f.label.padEnd(8)} ${size}${f.recommended ? '  推荐' : ''}`);
  }
}

async function main() {
  if (cmd === 'auth') {
    const auth = await import('./auth');
    if (has('--status')) {
      const rows = auth.status();
      // 默认在线校验：只数 cookie 名会把过期的 SESSDATA 报成「已登录」（实测踩到）
      const online = has('--offline') ? null : await auth.verify();
      const bySite = new Map((online || []).map((r) => [r.site, r]));
      if (has('--json')) {
        console.log(JSON.stringify({
          ok: true,
          sites: rows.map((r) => ({ ...r, online: bySite.get(r.site) || null })),
        }, null, 2));
      } else {
        for (const r of rows) {
          const v = bySite.get(r.site);
          const live = !v ? '未校验'
            : v.ok === true ? `在线有效（${v.message}）`
              : v.ok === false ? `在线无效：${v.message}` : v.message;
          console.log(`${r.label}\t${r.loggedIn ? '本地有凭据' : '本地无凭据'}\t${r.cookies} cookies\t${live}`);
        }
        if (!online) console.log('（--offline：只看本地文件，不代表凭据有效）');
        else if (online.some((v) => v.ok === false)) {
          console.log('失效的站点请重新登录：bun ts/src/cli.ts auth <site>');
        }
      }
      process.exit(0);
    }
    const site = positional[0];
    if (!site) {
      console.error('用法: bun src/cli.ts auth <bilibili|netease> [--status [--offline]|--clear]');
      process.exit(2);
    }
    if (has('--clear')) {
      auth.clear(site);
      console.log(`已清除 ${site} 凭据`);
      process.exit(0);
    }
    try {
      console.error(`已打开独立 Edge（${site}），请在窗口里完成登录，成功后自动保存并关闭`);
      const out = await auth.login(site, Number(flag('--timeout', '300')) * 1000);
      console.log(JSON.stringify(out));
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  const url = positional[0];
  if (!url || !['probe', 'get'].includes(cmd)) {
    console.error('用法: bun src/cli.ts probe|get <url> [--format id] [-o dir] [--limit 2M] [--json]');
    process.exit(2);
  }

  // 限速只在下载时有意义；显式 --limit 优先于 config.limitRate
  if (cmd === 'get') {
    const limitArg = flag('--limit');
    if (limitArg) {
      const parsed = parseLimit(limitArg);
      if (parsed === null) {
        console.error(`--limit 格式不对: ${limitArg}（示例: 500K / 2M / 1048576）`);
        process.exit(2);
      }
      setLimitBytesPerSec(parsed);
    } else if (has('--limit')) {
      console.error('--limit 后面要跟速率，例如 --limit 2M');
      process.exit(2);
    } else {
      setLimitBytesPerSec(loadConfig().limitRate || 0);
    }
  }

  try {
    if (cmd === 'probe') {
      const res = await probe(url);
      if (has('--json')) console.log(JSON.stringify(res, null, 2));
      else human(res);
      process.exit(res.ok ? 0 : 1);
    }

    const platform = platformOf(url);
    if (['douyin', 'bilibili', 'netease'].includes(platform)) {
      const out = platform === 'douyin'
        ? await getDouyin(url, flag('--format'), flag('-o', '下载') || '下载')
        : platform === 'netease'
          ? await getNetease(url, flag('--format'), flag('-o', '下载') || '下载')
          : await getBilibiliApi(url, flag('--format'), flag('-o', '下载') || '下载');
      if (has('--json')) {
        console.log(JSON.stringify({ schema: 2, ok: true, path: out.path, bytes: out.bytes, skipped: out.skipped }, null, 2));
      } else {
        console.log(`完成 ${out.path} (${(out.bytes / 1048576).toFixed(2)} MB)`);
      }
      process.exit(0);
    }

    if (platform === 'unsupported' && loadConfig().allowGeneric && genericInstalled()) {
      const out = await getGeneric(url, flag('--format'), flag('-o', '下载') || '下载');
      if (has('--json')) {
        console.log(JSON.stringify({
          schema: 2, ok: true, path: out.path, bytes: out.bytes, skipped: out.skipped,
        }, null, 2));
      } else {
        console.log(`完成 ${out.path} (${(out.bytes / 1048576).toFixed(2)} MB)`);
      }
      process.exit(0);
    }

    console.error(`不支持的站点：${url}（可在设置里启用通用解析）`);
    process.exit(3);
  } catch (err) {
    const body = fail(platformOf(url), 'ts-spike', err);
    if (has('--json')) console.log(JSON.stringify(body, null, 2));
    else console.error(`${(err as Error).message}`);
    process.exit(1);
  }
}

await main();
