import { operationState, scopedOperation } from '../core/operation';
import { saveCover } from '../core/sidecar';
import type { DownloadOptions } from '../core/types';
import { DownloadCancelled } from '../core/cancel';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { throwIfCancelled } from '../core/cancel';
import { VdlError } from '../core/errors';
import { CookieJar, request, UA } from '../core/http';
import { safeName } from '../core/naming';
import { firstUrl } from '../core/platform';
import { report } from '../core/progress';
import { throttle } from '../core/rate';
import { format, type Format, type ProbeResult } from '../core/types';

const HOST = 'https://www.douyin.com';
const DETAIL = HOST + '/aweme/v1/web/aweme/detail/';
const TTWID = HOST + '/ttwid/register';
const SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E';
const AID = 6383;
const UIFID_COOKIES = ['uifid', 'uifid_temp', 'uifidtemp', 'UIFID', 'UIFID_TEMP', 'UIFIDTEMP'];

const VID_RE = /\/(?:video|note)\/(\d{15,20})/;
const MODAL_RE = /[?&]modal_id=(\d{15,20})/;
const BARE_RE = /^\s*(\d{15,20})\s*$/;
const RES_RE = /(\d{3,4})/;

const urlCache = operationState(() => new Map<string, string[]>());

/** 供下载前预览：取该档位的第一条 CDN 地址。 */
export function previewDouyin(formatId: string): string {
  return (urlCache().get(formatId) || [])[0] || '';
}

interface Candidate {
  rate: number; label: string; url: string;
  width: number; height: number; bytes: number;
  fps: number; codec: string; watermark: boolean;
}

function extractVid(text: string): string {
  for (const re of [VID_RE, MODAL_RE]) {
    const m = re.exec(text || '');
    if (m) return m[1];
  }
  const m = BARE_RE.exec(text || '');
  return m ? m[1] : '';
}

async function ensureCookies(jar: CookieJar) {
  if (!jar.get('ttwid')) {
    await request(TTWID, {
      method: 'POST', jar,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' },
      body: JSON.stringify({ aid: AID, service: 'www.douyin.com' }),
    });
    if (!jar.get('ttwid')) throw new VdlError('no_ttwid', 'ttwid 注册失败（没有拿到 Set-Cookie）');
  }
  if (!jar.get('passport_csrf_token')) jar.set('passport_csrf_token', randomBytes(16).toString('hex'));
}

async function getUifid(jar: CookieJar): Promise<string> {
  for (const name of UIFID_COOKIES) {
    const value = jar.get(name);
    if (value) return value;
  }
  const res = await request(HOST + '/', {
    jar, headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  const value = res.headers.get('x-tt-trace-host') || '';
  if (!value) throw new VdlError('no_uifid', '拿不到 uifid（cookie 与 x-tt-trace-host 都为空）');
  return value;
}

function sign(query: Record<string, string>, uifid: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed: Record<string, string> = { ...query, uifid, timestamp };
  const encoded = new URLSearchParams(signed).toString();
  const digest = createHash('md5')
    .update(`${uifid}_${timestamp}_${SALT}_${encoded}`).digest('hex');
  return { ...signed, 'x-secsdk-web-signature': digest };
}

function candidates(video: any): Candidate[] {
  const out: Candidate[] = [];
  for (const br of video?.bit_rate || []) {
    const rate = Number(br?.bit_rate || 0);
    const label = br?.gear_name || `${rate}bps`;
    const pa = br?.play_addr || {};
    for (const u of pa.url_list || []) {
      if (typeof u === 'string' && u.startsWith('http')) {
        out.push({
          rate, label, url: u,
          width: Number(pa.width || 0), height: Number(pa.height || 0),
          bytes: Number(pa.data_size || 0), fps: Number(br.FPS || 0),
          codec: br.is_h265 ? 'h265' : 'h264', watermark: false,
        });
      }
    }
  }
  for (const key of ['play_addr_h264', 'play_addr', 'play_addr_265']) {
    const node = video?.[key] || {};
    for (const u of node.url_list || []) {
      if (typeof u === 'string' && u.startsWith('http')) {
        out.push({
          rate: 0, label: key, url: u,
          width: Number(node.width || video?.width || 0),
          height: Number(node.height || video?.height || 0),
          bytes: Number(node.data_size || 0), fps: 0, codec: '', watermark: false,
        });
      }
    }
  }
  const dl = video?.download_addr || {};
  for (const u of dl.url_list || []) {
    if (typeof u === 'string' && u.startsWith('http')) {
      out.push({
        rate: -1, label: 'download_addr(带水印)', url: u,
        width: Number(dl.width || 0), height: Number(dl.height || 0),
        bytes: Number(dl.data_size || 0), fps: 0, codec: '', watermark: true,
      });
    }
  }
  const seen = new Set<string>();
  return out.sort((a, b) => b.rate - a.rate)
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

function prettyLabel(c: Candidate): string {
  const m = RES_RE.exec(c.label || '');
  let base = m ? `${m[1]}P` : (c.label || '未知');
  if (c.watermark && !String(c.label).includes('带水印')) base += '（带水印）';
  return base;
}

function buildFormats(cands: Candidate[]): Format[] {
  const hasClean = cands.some((c) => !c.watermark);
  const groups = new Map<string, { first: Candidate; urls: string[] }>();
  for (const c of cands) {
    if (c.watermark && hasClean) continue;
    if (!groups.has(c.label)) groups.set(c.label, { first: c, urls: [] });
    groups.get(c.label)!.urls.push(c.url);
  }

  const out: Format[] = [];
  const used = new Set<string>();
  for (const [label, group] of groups) {
    const c = group.first;
    const key = c.width && c.height ? `${c.width}x${c.height}` : `${label}:${c.rate}`;
    if (used.has(key)) continue;
    used.add(key);
    const id = label || `fmt-${out.length + 1}`;
    out.push(format({
      id, label: prettyLabel(c), width: c.width, height: c.height, ext: 'mp4',
      vcodec: c.codec || 'h264', acodec: 'aac', fps: c.fps,
      bytes: c.bytes || null, bitrate: c.rate > 0 ? c.rate : null,
      watermark: c.watermark,
    }));
    urlCache().set(id, group.urls);
  }
  if (out.length) out[0].recommended = true;
  return out;
}

async function probeDouyinImpl(input: string): Promise<ProbeResult> {
  const jar = new CookieJar();
  let vid = extractVid(input);
  if (!vid) {
    // 分享文案里链接可能夹在句子中间；短链要靠重定向后的最终地址拿 id
    const target = firstUrl(input) || input;
    if (!/^https?:\/\//i.test(target)) {
      throw new VdlError('bad_input', '没能从这段文字里找到抖音链接');
    }
    const res = await request(target, {
      jar, headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    vid = extractVid(res.url);
    if (!vid) {
      // 少数分享页把 id 放在 HTML 里（重定向到校验页时就靠这一步兜底）
      vid = extractVid(await res.text().catch(() => ''));
    }
  }
  if (!vid) throw new VdlError('bad_input', '没能从这个输入里识别出视频 ID');

  await ensureCookies(jar);
  const uifid = await getUifid(jar);
  const query = sign({ aweme_id: vid, aid: String(AID) }, uifid);
  const url = DETAIL + '?' + new URLSearchParams(query).toString();
  const res = await request(url, {
    jar, headers: { Accept: 'application/json, text/plain, */*', Referer: `${HOST}/video/${vid}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new VdlError(res.status === 403 ? 'blocked' : `http_${res.status}`, text.slice(0, 400));
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new VdlError('bad_json', `详情不是 JSON（前 120 字节: ${JSON.stringify(text.slice(0, 120))}）`);
  }

  const aweme = data?.aweme_detail;
  if (!aweme) {
    const fd = data?.filter_detail || {};
    const bits = [fd.filter_reason, fd.detail_msg || data?.status_msg].filter(Boolean).join('；');
    throw new VdlError(fd.filter_reason ? 'filtered' : 'no_detail',
      '响应里没有 aweme_detail' + (bits ? `（${bits}）` : ''));
  }
  if (aweme.aweme_id && String(aweme.aweme_id) !== String(vid)) {
    throw new VdlError('wrong_video', `返回的视频 ID 不匹配（要 ${vid}，拿到 ${aweme.aweme_id}）`);
  }

  const video = aweme.video || {};
  const formats = buildFormats(candidates(video));
  if (!formats.length) throw new VdlError('no_stream', '没有解析到任何可下载档位');

  return {
    schema: 2, ok: true, platform: 'douyin', engine: 'douyin-http',
    media: {
      id: String(vid),
      title: String(aweme.desc || '').trim() || `douyin_${vid}`,
      author: aweme.author?.nickname || '',
      duration_ms: Number(video.duration || 0) || null,
      thumbnail: (video.cover?.url_list || [''])[0],
      source_url: `${HOST}/video/${vid}`,
      platform: 'douyin', parts: [],
    },
    formats, warnings: [], error: null,
  };
}

async function streamTo(url: string, part: string, referer: string): Promise<number> {
  let resume = existsSync(part) ? statSync(part).size : 0;
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: referer, Accept: '*/*' };
  if (resume) headers.Range = `bytes=${resume}-`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new VdlError(`http_${res.status}`, `下载失败: ${res.status}`);
  if (resume && res.status !== 206) resume = 0;

  const total = Number(res.headers.get('content-length') || 0) + resume;
  const fh = await open(part, resume ? 'a' : 'w');
  let written = resume;
  let sinceStart = 0;
  const startedAt = Date.now();
  let last = 0;
  try {
    if (!res.body) throw new VdlError('no_stream', '响应没有 body');
    for await (const chunk of res.body as any) {
      throwIfCancelled();
      await fh.write(chunk);
      written += chunk.length;
      sinceStart += chunk.length;
      await throttle(sinceStart, startedAt);
      const now = Date.now();
      if (now - last > 200) { last = now; report(written, total); }
    }
  } finally {
    await fh.close();
  }
  report(written, total || written);
  return statSync(part).size;
}

async function getDouyinImpl(input: string, formatId: string | null, outDir: string, opts: DownloadOptions = {}) {
  const probe = await probeDouyin(input);
  const fmt = probe.formats.find((f) => f.id === formatId) ||
    probe.formats.find((f) => f.recommended) || probe.formats[0];
  const label = safeName(fmt.label, 16, fmt.id);
  mkdirSync(outDir, { recursive: true });
  const stem = `${probe.media!.id}_${safeName(probe.media!.title)}_${label}`;
  const dest = join(outDir, `${stem}.mp4`);
  const completed = async (skipped: boolean) => ({
    path: dest, bytes: statSync(dest).size, skipped,
    ...(opts.cover ? await saveCover(dest, probe.media!.thumbnail, probe.media!.source_url) : { warnings: [] }),
  });
  if (existsSync(dest)) return completed(true);

  const urls = urlCache().get(fmt.id) || [];
  if (!urls.length) throw new VdlError('no_stream', '该档位没有可用地址');
  const part = dest + '.part';
  let last: unknown = null;
  for (const url of urls) {
    try {
      await streamTo(url, part, probe.media!.source_url);
      renameSync(part, dest);
      return completed(false);
    } catch (e) {
      if (e instanceof DownloadCancelled) throw e;
      last = e;
    }
  }
  throw last instanceof Error ? last : new VdlError('download_failed', '所有候选都失败');
}

export const probeDouyin = scopedOperation(probeDouyinImpl);

export const getDouyin = scopedOperation(getDouyinImpl);
