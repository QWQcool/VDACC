/**
 * 列表入口（歌单 / 专辑 / 收藏夹）的共用件。
 *
 * 这里只抽**三处每写一遍就会开始漂**的东西，不抽「怎么发请求」：
 *
 * 1. `bareNumericId()` —— 三个平台的 `parsePlaylistId` 第一句一模一样；
 * 2. `emptyCollection()` —— 「列表是空的」必须带码、带下一步，且不能把
 *    「拿到了 ID 但详情全空」说成「歌单是空的」（那是两种故障）；
 * 3. `detailsByIds()` —— 网易云那种两段式入口（先拿全量 id、再按批补详情）
 *    的补详情循环：分批、按 ids 顺序还原、缺的如实报数。
 *
 * 为什么不做一个统一的 `CollectionAdapter` 接口：抓取协议差别太大——
 * B站 是服务端分页 + 失效条目语义，网易云是 trackIds 两段式，QQ / 酷狗是
 * 「每页 N 条 + 声明总数」。硬塞进一个 interface 只会让每处多一层无意义的适配，
 * 分页循环本身已经收在 `core/paging.ts`（同样的取舍，理由写在那里）。
 */
import { VdlError } from './errors';

/** 裸数字 ID（用户在聊天里直接贴 id 的常见情形）；不是纯数字就返回空串。 */
export function bareNumericId(input: string): string {
  const raw = (input || '').trim();
  return /^\d+$/.test(raw) ? raw : '';
}

export interface EmptyCollectionSpec {
  id: string;
  /** 进文案用：「歌单」/「专辑」/「收藏夹」，默认「歌单」。 */
  label?: string;
  /** 平台声明的总数；有值就说明「接口说有几首但没给条目」，与空列表不是一回事。 */
  declared?: number;
  /** 两段式入口里「id 拿到了、详情全空」用这个，避免说成「歌单是空的」。 */
  detailPhase?: boolean;
  /** 声明了总数却拿不到条目时的原因（各平台不同：私密 / 下架 / 地区限制）。 */
  blockedHint?: string;
  /** 没声明总数时的下一步，默认「确认这个歌单不是空的」。 */
  emptyHint?: string;
}

/**
 * 抛「列表里没有可下载的曲目」。返回 `never`，调用方不需要再写 `throw`。
 *
 * 口径（沿用 2026-11-11 三平台实测时的文案，别改成分不清故障原因的糊句）：
 * - 声明了总数却没给条目 → 是**平台侧**拿不到（私密 / 下架 / 地区），给登录或换歌单的下一步；
 * - 什么都没声明 → 大概率就是空列表，让用户自己确认。
 */
export function emptyCollection(spec: EmptyCollectionSpec): never {
  const label = spec.label || '歌单';
  const message = spec.detailPhase
    ? `${label}里的曲目都拿不到详情（id=${spec.id}）`
    : `${label}里没有可下载的曲目（id=${spec.id}）`;
  const declared = Number(spec.declared || 0);
  const hint = declared > 0
    ? (spec.blockedHint || `接口声明 ${declared} 首但没有给出曲目：可能整单下架或地区限制，登录后重试`)
    : (spec.emptyHint || '确认这个歌单不是空的');
  throw new VdlError('not_found', message, hint);
}

export interface DetailsByIdsInput<T> {
  /** 期望的完整顺序（平台给的全量 id；顺序由它决定，不由返回顺序决定）。 */
  ids: string[];
  /** 单批上限（网易云实测 100 条正常）。 */
  batchSize: number;
  /** 取一批详情；offset 是这一批在整个列表里的起点，只用于文案。 */
  fetchBatch: (batch: string[], offset: number) => Promise<T[]>;
  /** 从详情里取 id：返回顺序不保证，必须靠它还原。 */
  keyOf: (item: T) => string;
}

export interface DetailsByIdsResult<T> {
  /** 按 `ids` 顺序还原后的详情；拿不到的那些直接不出现。 */
  ordered: T[];
  warnings: string[];
  /** 拿不到详情的条数（下架 / 无版权），必须往上传。 */
  missing: number;
}

/**
 * 按 id 分批补详情，并按 ids 顺序还原。
 *
 * 两个「不抛」是刻意的：某批少几条、某些 id 查不到详情，都只影响那几条
 * （下架曲目本来就查不到），同批其它曲目是好的——不该让整个歌单失败。
 */
export async function detailsByIds<T>(input: DetailsByIdsInput<T>): Promise<DetailsByIdsResult<T>> {
  const ids = Array.isArray(input.ids) ? input.ids.filter(Boolean) : [];
  const batchSize = Math.max(1, Math.floor(input.batchSize) || 1);
  const warnings: string[] = [];
  const byId = new Map<string, T>();

  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    // fetch 失败（网络 / 限流）不在这里吞：那种情况整单都不可信，交给上层报错
    const got = await input.fetchBatch(batch, offset);
    const list = Array.isArray(got) ? got : [];
    if (list.length < batch.length) {
      warnings.push(`第 ${offset + 1}–${offset + batch.length} 首里只拿到 ${list.length} 首详情`);
    }
    for (const item of list) byId.set(input.keyOf(item), item);
  }

  const ordered: T[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) ordered.push(item);
  }
  const missing = ids.length - ordered.length;
  if (missing > 0) {
    warnings.push(`${missing} 首拿不到详情（多为下架或无版权），本地列表里不会有它们`);
  }
  return { ordered, warnings, missing };
}
