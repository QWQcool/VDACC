/**
 * 抖音商城商品（`haohuo.jinritemai.com`）：主图视频 + 商品图。
 *
 * 与 `douyin.ts` 的两点根本区别：
 * 1. 数据源不是 aweme 接口，而是 `ecommerce/trade/detail` 页拉取的
 *    `aweme/v2/shop/promotion/pack/h5/`——该请求带 `a_bogus` + `verifyFp`，**必须过浏览器**；
 * 2. 一条商品可能**只有图没有视频**（实测两款：一款 1 视频 + 4 图，一款 5 图无视频）。
 *
 * 视频保持平台原格式（实测 HEVC/mp4），**不转码**——转码会掉画质、还要多花几十秒。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { throwIfCancelled } from '../core/cancel';
import { VdlError } from '../core/errors';
import { scopedOperation } from '../core/operation';
import { UA } from '../core/http';
import { safeName } from '../core/naming';
import { report } from '../core/progress';
import { format, type Format, type ProbeResult } from '../core/types';

const SHOP_HOST = /(^|\.)haohuo\.jinritemai\.com$/i;
const SHORT_HOST = /(^|\.)v\.douyin\.com$/i;
const PACK_SCRIPT = join(import.meta.dir, '..', 'shop', 'crawl.cjs');
const REFERER = 'https://haohuo.jinritemai.com/';

export interface ShopVideo {
  url: string;
  cover: string;
  width: number;
  height: number;
}

export interface ShopInfo {
  productId: string;
  title: string;
  /** 店铺名（pack 里的 `shop_info.basic_info.shop_name`）；拿不到就是空串 */
  shopName: string;
  video: ShopVideo | null;
  images: string[];
  sourceUrl: string;
}

function hostOf(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase(); } catch { return ''; }
}

/** 商品页地址（不含短链——短链要看重定向落点）。 */
export function isShopUrl(input: string): boolean {
  return SHOP_HOST.test(hostOf(String(input || '').trim()));
}

/** 从商品页 URL 里取 product id（`id=` / `product_id=`），取不到返回空串。 */
export function shopProductId(input: string): string {
  try {
    const u = new URL(String(input || '').trim());
    const id = u.searchParams.get('id') || u.searchParams.get('product_id') || '';
    return /^\d{6,}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}

/**
 * 把「可能是商城」的输入解析成商品页地址；不是商城就返回 null。
 *
 * 只有 `v.douyin.com` 短链需要发一次请求（视频与商城共用同一套短链域名）；
 * 其它输入一律本地判断，不多打一次网络。
 */
export async function resolveShopTarget(input: string): Promise<string | null> {
  const raw = String(input || '').trim();
  if (isShopUrl(raw)) return raw;
  if (!SHORT_HOST.test(hostOf(raw))) return null;
  const res = await fetch(raw, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  }).catch(() => null);
  if (!res) return null;
  return isShopUrl(res.url) ? res.url : null;
}

/** 图片统一取最大尺寸：页面给的是 1080 缩略，换成 1440/q100 实测更大（45KB→121KB）。 */
export function maxImageUrl(url: string): string {
  return String(url || '').replace(/~tplv-[^"']*$/, '~tplv-5mmsx3fupr-resize_q:1440:1440:q100.webp');
}

/**
 * 解析 `promotion/pack/h5` 的响应体（纯函数，用例直接喂 fixture）。
 *
 * 结构：`promotion_h5.head_figure_data.media_list[]`，每项 `{ type: 'video'|'image', content_list[] }`；
 * 视频在 `content_list[0].url`，封面在 `.cover_url`；图片按 `url` 去重（同一张图会出现多次）。
 */
export function parseShopPack(pack: any, sourceUrl = ''): ShopInfo {
  const h5 = pack?.promotion_h5 || {};
  const title = String(h5.basic_info_data?.title_info?.title || '').trim();
  const groups: any[] = Array.isArray(h5.head_figure_data?.media_list) ? h5.head_figure_data.media_list : [];

  let video: ShopVideo | null = null;
  const images: string[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    const list: any[] = Array.isArray(group?.content_list) ? group.content_list : [];
    if (group?.type === 'video' && !video) {
      const first = list.find((c) => String(c?.url || '').trim());
      if (first) {
        video = {
          url: String(first.url).trim(),
          cover: String(first.cover_url || '').trim(),
          width: Number(first.width) || 0,
          height: Number(first.height) || 0,
        };
      }
    }
    if (group?.type === 'image') {
      for (const c of list) {
        const url = String(c?.url || '').trim();
        if (!url) continue;
        // 同一张图有多个 CDN 域名，按 material 文件名去重
        const key = (/([a-z0-9_]+_m_[0-9a-f]+)/i.exec(url) || [])[1] || url;
        if (seen.has(key)) continue;
        seen.add(key);
        images.push(url);
      }
    }
  }

  return {
    productId: shopProductId(sourceUrl),
    title: title || '抖音商品',
    shopName: String(h5.shop_info?.basic_info?.shop_name || '').trim(),
    video,
    images,
    sourceUrl,
  };
}

interface CrawlResult {
  ok: boolean;
  error?: string;
  finalUrl?: string;
  pack?: any;
}

/** 起 node 子进程跑浏览器抓取。Bun 下 playwright 的 CDP 会超时，所以固定用 node。 */
function crawl(target: string, timeoutMs: number): Promise<CrawlResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('node', [PACK_SCRIPT, target, String(timeoutMs)], {
        windowsHide: true,
        env: { ...process.env },
      });
    } catch (err) {
      reject(new VdlError('shop_no_node',
        `起不来 node（${(err as Error).message}）`,
        '商城页需要 Node + playwright-core + Edge：装 Node 后 cd ts && bun install'));
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString('utf8')).slice(-800); });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new VdlError('shop_no_node', '找不到 node', '商城页需要 Node（装好 Node 后重开终端）'));
        return;
      }
      reject(new VdlError('shop_crawl_failed', err.message));
    });

    child.on('close', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
      let parsed: CrawlResult | null = null;
      try { parsed = JSON.parse(line); } catch { /* 落下面 */ }
      if (!parsed) {
        reject(new VdlError('shop_crawl_failed',
          `抓取进程异常退出（code ${code}）：${stderr.trim().slice(-200) || line.slice(0, 200) || '无输出'}`,
          '确认已安装 Edge 与依赖（cd ts && bun install）'));
        return;
      }
      if (!parsed.ok) {
        reject(new VdlError('shop_crawl_failed',
          parsed.error || '抓取失败',
          '商城页可能有风控/登录墙；稍后重试，或用「复制链接」重新拿一条'));
        return;
      }
      resolve(parsed);
    });
  });
}

/** 抓取并解析（probe/get 共用）。 */
export async function fetchShopInfo(input: string, timeoutMs = 45_000): Promise<ShopInfo> {
  const target = (await resolveShopTarget(input)) || String(input || '').trim();
  if (!isShopUrl(target)) {
    throw new VdlError('bad_input', `不是抖音商城商品页：${input}`, '粘贴商品详情页链接或商城分享短链');
  }
  const res = await crawl(target, timeoutMs);
  const info = parseShopPack(res.pack, res.finalUrl || target);
  if (!info.productId) info.productId = shopProductId(target);
  if (!info.video && !info.images.length) {
    throw new VdlError('no_stream', '这个商品页没有可下载的视频或图片', '确认商品是否已下架');
  }
  return info;
}

/** 商品视频一个档位、图集一个档位：这样 `--format shop-images` 能只下图。 */
export function shopFormats(info: ShopInfo): Format[] {
  const out: Format[] = [];
  if (info.video) {
    out.push(format({
      id: 'shop-video',
      label: '商品视频',
      ext: 'mp4',
      width: info.video.width || 0,
      height: info.video.height || 0,
      // 时长要下载后才知道，这里不猜
      bytes: null,
      recommended: true,
    }));
  }
  if (info.images.length) {
    out.push(format({
      id: 'shop-images',
      label: `商品图 ${info.images.length} 张`,
      ext: 'webp',
      bytes: null,
      recommended: !info.video,
    }));
  }
  return out;
}

async function probeShopImpl(input: string): Promise<ProbeResult> {
  const info = await fetchShopInfo(input);
  const warnings: string[] = [];
  if (info.video) {
    warnings.push('商品视频保持平台原格式（可能是 HEVC），未转码');
  }
  return {
    schema: 2, ok: true, platform: 'douyin-shop', engine: 'douyin-shop',
    media: {
      id: info.productId || 'shop',
      title: info.title,
      // 店铺名在 pack 的 shop_info 里；拿不到就空着，别编
      author: info.shopName,
      duration_ms: null,
      thumbnail: info.video?.cover || info.images[0] || '',
      source_url: info.sourceUrl,
      platform: 'douyin-shop',
      parts: [],
    },
    formats: shopFormats(info),
    warnings,
    error: null,
  };
}

const extFromType = (type: string, fallback: string): string => {
  if (/webp/i.test(type)) return 'webp';
  if (/png/i.test(type)) return 'png';
  if (/jpe?g/i.test(type)) return 'jpg';
  if (/mp4/i.test(type)) return 'mp4';
  return fallback;
};

async function downloadVideo(url: string, dest: string): Promise<number> {
  const part = `${dest}.part`;
  rmSync(part, { force: true });
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: REFERER } });
  if (!res.ok || !res.body) throw new VdlError(`http_${res.status}`, `商品视频下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const fh = await open(part, 'w');
  let written = 0;
  let last = 0;
  try {
    for await (const chunk of res.body as any) {
      throwIfCancelled();
      await fh.write(chunk);
      written += chunk.length;
      const now = Date.now();
      if (now - last > 200) { last = now; report(written, total || written); }
    }
  } finally {
    await fh.close();
  }
  if (written < 10 * 1024) {
    rmSync(part, { force: true });
    throw new VdlError('bad_payload', `商品视频只有 ${written} 字节，可能被风控截断`);
  }
  renameSync(part, dest);
  return statSync(dest).size;
}

async function downloadImages(urls: string[], dir: string): Promise<number> {
  mkdirSync(dir, { recursive: true });
  let total = 0;
  for (let i = 0; i < urls.length; i += 1) {
    throwIfCancelled();
    const res = await fetch(maxImageUrl(urls[i]), { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      throw new VdlError(`http_${res.status}`, `第 ${i + 1} 张商品图下载失败 HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = extFromType(res.headers.get('content-type') || '', 'webp');
    const file = join(dir, `${String(i + 1).padStart(2, '0')}.${ext}`);
    writeFileSync(file, buf);
    total += buf.length;
    report(i + 1, urls.length);
  }
  return total;
}

export interface ShopGetResult {
  path: string;
  bytes: number;
  skipped: boolean;
  warnings: string[];
}

/**
 * 下载商品素材。默认**视频 + 图集都下**（用户要的就是这套）；
 * `formatId = 'shop-video'` 只要视频，`'shop-images'` 只要图。
 *
 * 目录：`<outDir>/<商品标题>/video.mp4` 与 `<outDir>/<商品标题>/images/01.webp…`
 */
export async function getShopImpl(
  input: string, formatId: string | null, outDir: string,
): Promise<ShopGetResult> {
  const info = await fetchShopInfo(input);
  const dir = join(outDir, safeName(info.title, 60, '抖音商品'));
  mkdirSync(dir, { recursive: true });

  const wantVideo = formatId !== 'shop-images' && !!info.video;
  const wantImages = formatId !== 'shop-video' && info.images.length > 0;
  if (!wantVideo && !wantImages) {
    throw new VdlError('bad_input', '这个商品没有该类型的素材（可选 shop-video / shop-images）');
  }

  const warnings: string[] = [];
  let skipped = true;
  // `bytes` 只报 `path` 指向的那个文件，否则「完成 video.mp4 (2.05 MB)」会把图片也算进去
  let bytes = 0;
  let path = dir;

  if (wantVideo && info.video) {
    const dest = join(dir, 'video.mp4');
    path = dest;
    if (existsSync(dest)) {
      bytes = statSync(dest).size;
    } else {
      skipped = false;
      bytes = await downloadVideo(info.video.url, dest);
    }
    warnings.push('商品视频为平台原格式，未转码');
  }

  if (wantImages) {
    const imgDir = join(dir, 'images');
    const already = existsSync(imgDir) && readdirSync(imgDir).length > 0;
    if (!already) {
      skipped = false;
      const imageBytes = await downloadImages(info.images, imgDir);
      if (!wantVideo) { path = imgDir; bytes = imageBytes; }
    } else if (!wantVideo) {
      // 只下图且已下过：把已有文件的大小算进去，别报 0
      path = imgDir;
      bytes = readdirSync(imgDir).reduce((sum, f) => sum + statSync(join(imgDir, f)).size, 0);
    }
    warnings.push(`商品图 ${info.images.length} 张：${imgDir}`);
  }

  return { path, bytes, skipped, warnings };
}

export const probeShop = scopedOperation(probeShopImpl);

export const getShop = scopedOperation(getShopImpl);
