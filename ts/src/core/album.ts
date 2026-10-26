/** 专辑批量：上限与截断规则放一处，CLI 与未来 GUI 共用，避免两边口径漂移。 */

export const MAX_ALBUM_TRACKS = 20;

export interface AlbumTrack {
  id: string;
  title: string;
  author: string;
  url: string;
}

export interface AlbumInfo {
  id: string;
  title: string;
  cover: string;
  tracks: AlbumTrack[];
}

/**
 * 取一批（默认 20 首），并如实报告这一批之后还剩多少。
 * 不按“整张专辑”硬下——20 是单批上限，用户要全下就按 nextOffset 继续取下一批。
 */
export function planAlbum(tracks: AlbumTrack[], offset = 0, max = MAX_ALBUM_TRACKS): {
  take: AlbumTrack[]; dropped: number;
  offset: number; hasMore: boolean; nextOffset: number;
} {
  const list = Array.isArray(tracks) ? tracks.filter((t) => t && t.id) : [];
  const start = Math.min(Math.max(0, Math.floor(offset) || 0), list.length);
  const take = list.slice(start, start + max);
  const end = start + take.length;
  return {
    take,
    dropped: list.length - end,
    offset: start,
    hasMore: end < list.length,
    nextOffset: end,
  };
}
