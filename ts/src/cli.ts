import { getDouyin, probeDouyin } from './engines/douyin';
import { MAX_ALBUM_TRACKS, planAlbum } from './core/album';
import { albumTracks as neteaseAlbum, getNetease, probeNetease } from './engines/netease';
import { probeBilibili } from './engines/bilibili';
import { getBilibiliApi, probeBilibiliApi } from './engines/bilibili_api';
import { albumTracks as qqAlbum, getQQ, probeQQ } from './engines/qq';
import { getKuwo, probeKuwo } from './engines/kuwo';
import { getKugou, probeKugou } from './engines/kugou';
import { canHandle as canSniff, getSniff, probeSniff } from './engines/sniff';
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
    case 'qq': return probeQQ(url);
    case 'kuwo': return probeKuwo(url);
    case 'kugou': return probeKugou(url);
    case 'bilibili':
      return process.env.VDL_BILI_ENGINE === 'ytdlp'
        ? probeBilibili(url)
        : probeBilibiliApi(url);
    default: {
      // L2：直链 / m3u8 自己吃，不依赖 yt-dlp 组件
      if (canSniff(url)) return probeSniff(url);
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
  // warnings 是「不假装支持」的落点（未登录、试听片段、会员档被拒），人读输出也必须看到
  for (const w of res.warnings || []) console.log(`  注意：${w}`);
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
    console.error('用法: bun src/cli.ts probe|get <url> [--format id] [-o dir] [--limit 2M] [--json]'
    + ' [--album [--offset N]] [--subs] [--danmaku]');
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

    // 专辑批量：显式 --album 才走这条路，默认仍然是单曲/单视频
    if (cmd === 'get' && has('--album')) {
      const platform = platformOf(url);
      if (platform !== 'netease' && platform !== 'qq') {
        console.error('--album 目前只支持 网易云 / QQ 音乐');
        process.exit(2);
      }
      const album = platform === 'netease' ? await neteaseAlbum(url) : await qqAlbum(url);
      const offset = Number(flag('--offset', '0')) || 0;
      const plan = planAlbum(album.tracks, offset);
      const { take, dropped, hasMore, nextOffset } = plan;
      console.log(`专辑：${album.title}（共 ${album.tracks.length} 首，`
        + `本次第 ${Math.floor(plan.offset / MAX_ALBUM_TRACKS) + 1} 批：${take.length} 首`
        + `${dropped ? `，之后还剩 ${dropped}` : ''}）`);
      if (hasMore) console.log(`  下一批：--offset ${nextOffset}`);
      if (has('--dry-run')) {
        take.forEach((t, i) => console.log(`  ${plan.offset + i + 1}. ${t.title}${t.author ? ` — ${t.author}` : ''}`));
        process.exit(0);
      }
      const outDir = flag('-o', '下载') || '下载';
      const formatId = flag('--format', '') || null;
      let ok = 0;
      const failed: string[] = [];
      for (let i = 0; i < take.length; i += 1) {
        const track = take[i];
        console.log(`[${i + 1}/${take.length}] ${track.title}`);
        try {
          const out = platform === 'netease'
            ? await getNetease(track.url, formatId, outDir)
            : await getQQ(track.url, formatId, outDir);
          ok += 1;
          console.log(`  ${out.skipped ? '已存在' : '完成'} ${out.path} ` +
            `(${(out.bytes / 1048576).toFixed(2)} MB)`);
          for (const w of ((out as any).warnings || [])) console.error(`  注意：${w}`);
        } catch (err) {
          const e = err as VdlError;
          failed.push(`${track.title}: ${e.message || String(err)}`);
          console.error(`  失败：${e.message || String(err)}`);
        }
      }
      console.log(`完成 ${ok}/${take.length}${failed.length ? `，失败 ${failed.length}` : ''}`);
      for (const f of failed) console.error(`  失败明细：${f}`);
      process.exit(failed.length ? 1 : 0);
    }

    const platform = platformOf(url);
    if (['douyin', 'bilibili', 'netease', 'qq', 'kuwo', 'kugou'].includes(platform)) {
      if ((has('--subs') || has('--danmaku')) && platform !== 'bilibili') {
        console.error(`--subs / --danmaku 目前只支持 B站，${platform} 会忽略这些参数`);
      }
      const out = platform === 'douyin'
        ? await getDouyin(url, flag('--format'), flag('-o', '下载') || '下载', { cover: has('--cover') })
        : platform === 'netease'
          ? await getNetease(url, flag('--format'), flag('-o', '下载') || '下载')
          : platform === 'qq'
            ? await getQQ(url, flag('--format'), flag('-o', '下载') || '下载')
            : platform === 'kuwo'
              ? await getKuwo(url, flag('--format'), flag('-o', '下载') || '下载')
              : platform === 'kugou'
                ? await getKugou(url, flag('--format'), flag('-o', '下载') || '下载')
                : await getBilibiliApi(
              url, flag('--format'), flag('-o', '下载') || '下载',
              { cover: has('--cover'), subs: has('--subs'), danmaku: has('--danmaku') });
      if (has('--json')) {
        console.log(JSON.stringify({
          schema: 2, ok: true, path: out.path, bytes: out.bytes, skipped: out.skipped,
          warnings: 'warnings' in out ? out.warnings : [],
          ...(has('--cover') ? { cover: (out as any).cover || null } : {}),
          ...(has('--subs') ? { srt: (out as any).srt || null, srt_count: (out as any).srtCount || 0 } : {}),
        }, null, 2));
      } else {
        console.log(`完成 ${out.path} (${(out.bytes / 1048576).toFixed(2)} MB)`);
        if ('warnings' in out) for (const warning of out.warnings) console.error(`提示：${warning}`);
        if (has('--subs')) {
          const srt = (out as any).srt as string | null;
          console.log(srt ? `字幕 ${srt}` : '字幕：该视频没有可用字幕（含 AI 字幕）');
        }
        if (has('--danmaku')) {
          const dm = out as any;
          if (dm.danmakuSupported === false) console.log('弹幕：番剧的弹幕暂不支持');
          else if (dm.danmaku) console.log(`弹幕 ${dm.danmaku}（${dm.danmakuCount} 条）`);
          else console.log('弹幕：该视频没有弹幕');
        }
      }
      process.exit(0);
    }

    // L2 嗅探：直链 / m3u8 不依赖 yt-dlp 组件
    if (platform === 'unsupported' && canSniff(url)) {
      if (has('--subs') || has('--danmaku')) {
        console.error('--subs / --danmaku 只支持 B站，嗅探会忽略这些参数');
      }
      const out = await getSniff(url, flag('--format'), flag('-o', '下载') || '下载');
      if (has('--json')) {
        console.log(JSON.stringify({
          schema: 2, ok: true, path: out.path, bytes: out.bytes, skipped: out.skipped,
        }, null, 2));
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
