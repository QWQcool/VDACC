/**
 * B站 收藏夹 / 合集的「列表入口」：只负责翻页取列表，不负责下载。
 *
 * 为什么是"列表入口"而不是"批量下载"：用户要的是**自己挑**，不是一键全下。
 * 唧唧Down 也是这个形态——它的 IPC 里只有 `get_favorite_detail` 与单条 `start_video_download`，
 * 列表接口自带 `pn/ps` 分页与 `has_more`（见 docs/design/reference-jijidown-notes.md §5.1）。
 *
 * 接口（2026-11-10 记录）：
 *   收藏夹  https://api.bilibili.com/x/v3/fav/resource/list?media_id=<id>&pn=&ps=20&order=mtime&type=0&tid=0&platform=web
 *   合集    https://api.bilibili.com/x/space/fav/season/list?season_id=<id>&pn=&ps=20
 * **未验证**：真实收藏夹/合集的完整响应体（需要用户自己的收藏夹 ID）。所以这里对结构做硬校验：
 * 结构不符就抛错，绝不把"解析不出来"当成"空收藏夹"。
 */
import { VdlError } from '../core/errors';
import type { CollectionItem, CollectionKind, CollectionPage } from '../core/types';
import { cookieHeader } from './bilibili_api';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

export const COLLECTION_PAGE_SIZE = 20;

export interface CollectionDeps {
  fetch?: typeof fetch;
  pageSize?: number;
  /** 传 `''` 表示显式不带 cookie（测试用）；不传则读本机凭据。 */
  cookie?: string;
}

export interface CollectionTarget {
  kind: CollectionKind;
  id: string;
}

/**
 * 从用户粘的东西里认出收藏夹/合集。
 * 支持：`space.bilibili.com/<mid>/favlist?fid=123`、`?media_id=123`、
 *       `.../channel/collectiondetail?sid=123`、`seriesdetail?sid=123`、纯数字 + kind 提示。
 */
export function parseCollectionTarget(input: string, hint?: string): CollectionTarget | null {
  const raw = String(input || '').trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const kind: CollectionKind = hint === 'season' ? 'season' : 'fav';
    return { kind, id: raw };
  }

  let params: URLSearchParams;
  try {
    params = new URL(raw).searchParams;
  } catch {
    return null;
  }

  const fid = params.get('fid') || params.get('media_id');
  const sid = params.get('sid') || params.get('season_id');
  const looksSeason = /collectiondetail|seriesdetail|channel\/collection/i.test(raw);

  if (looksSeason) {
    const id = sid || fid;
    return id && /^\d+$/.test(id) ? { kind: 'season', id } : null;
  }
  if (fid && /^\d+$/.test(fid)) return { kind: 'fav', id: fid };
  if (sid && /^\d+$/.test(sid)) return { kind: 'season', id: sid };
  return null;
}

/** 已失效条目的 `attr` 失效位（fav 接口实测语料里是 9）。 */
const ATTR_INVALID = 9;

interface RawItem {
  bvid?: string;
  title?: string;
  cover?: string;
  duration?: number;
  attr?: number;
  upper?: { name?: string };
}

function toItem(raw: RawItem): CollectionItem {
  const bvid = String(raw.bvid || '');
  // fav 里失效条目的 attr 带失效位、bvid 为空；不能把它们丢掉，否则用户会以为收藏夹少了东西
  const gone = !bvid || Number(raw.attr || 0) === ATTR_INVALID;
  return {
    bvid,
    title: String(raw.title || (gone ? '已失效视频' : '')),
    author: String(raw.upper?.name || ''),
    cover: String(raw.cover || ''),
    duration_ms: Number(raw.duration || 0) ? Number(raw.duration) * 1000 : null,
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
    state: gone ? 'gone' : 'ok',
  };
}

function urlOf(target: CollectionTarget, page: number, pageSize: number): string {
  const pn = Math.max(1, page);
  if (target.kind === 'fav') {
    return 'https://api.bilibili.com/x/v3/fav/resource/list'
      + `?media_id=${target.id}&pn=${pn}&ps=${pageSize}`
      + '&keyword=&order=mtime&type=0&tid=0&platform=web';
  }
  return `https://api.bilibili.com/x/space/fav/season/list?season_id=${target.id}&pn=${pn}&ps=${pageSize}`;
}

function shapeError(kind: CollectionKind): VdlError {
  return new VdlError('collection_shape',
    `没认出${kind === 'fav' ? '收藏夹' : '合集'}的返回结构（可能是私密、空、或接口改版）`,
    '确认链接能在浏览器里打开；私密内容需要先在 B站 登录（设置 → 账号 → 扫码登录）');
}

export async function fetchCollection(
  target: CollectionTarget,
  page = 1,
  deps: CollectionDeps = {},
): Promise<CollectionPage> {
  const pageSize = deps.pageSize || COLLECTION_PAGE_SIZE;
  const doFetch = deps.fetch || fetch;
  const cookie = deps.cookie === undefined ? cookieHeader() : deps.cookie;

  let res: Response;
  try {
    res = await doFetch(urlOf(target, page, pageSize), {
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        Accept: 'application/json, text/plain, */*',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new VdlError('network', `请求 B站 失败：${(err as Error).message}`, '检查网络后重试');
  }
  if (!res.ok) {
    throw new VdlError('collection_http', `B站 返回 HTTP ${res.status}`, '稍后重试');
  }

  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') throw shapeError(target.kind);

  const code = Number(body.code);
  if (code !== 0) {
    // -101 未登录 / -403 无权限 / 11010 不存在，原话带出来，别糊成"下载失败"
    returnErr(code, body.message, target.kind);
  }
  const data = body.data;
  // 实测（media_id=1）：不存在的收藏夹返回 `data: null`，code 仍是 0
  if (!data || typeof data !== 'object') throw shapeError(target.kind);

  const info = data.info || {};
  const medias: RawItem[] = Array.isArray(data.medias) ? data.medias
    : Array.isArray(data.archives) ? data.archives : [];
  if (!Array.isArray(data.medias) && !Array.isArray(data.archives)) throw shapeError(target.kind);

  return {
    source: 'bilibili-fav',
    kind: target.kind,
    id: target.id,
    title: String(info.title || (target.kind === 'fav' ? '收藏夹' : '合集')),
    owner: String(info.upper?.name || ''),
    total: Number(info.media_count || info.count || medias.length),
    page: Math.max(1, page),
    pageSize,
    hasMore: Boolean(data.has_more),
    items: medias.map(toItem),
  };
}

function returnErr(code: number, message: unknown, kind: CollectionKind): never {
  const text = String(message || '');
  if (code === -101) {
    throw new VdlError('need_login', '这个收藏夹需要登录后才能看',
      '设置 → 账号 → B站 扫码登录后重试');
  }
  if (code === -403) {
    throw new VdlError('collection_private', `没有权限看这个${kind === 'fav' ? '收藏夹' : '合集'}（私密）`,
      '在 B站 网页确认该收藏夹是公开的，或先用有权限的账号登录');
  }
  throw new VdlError('collection_api', `B站 返回 code=${code}${text ? `：${text}` : ''}`,
    '稍后重试；若是链接贴错，请重新复制收藏夹页面地址');
}
