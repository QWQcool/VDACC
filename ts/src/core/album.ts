/** 专辑批量：上限与截断规则放一处，CLI 与未来 GUI 共用，避免两边口径漂移。 */

export const MAX_ALBUM_TRACKS = 20;

export interface AlbumTrack {
  id: string;
  title: string;
  author: string;
  url: string;
  /** 只有部分平台给（酷狗歌单给秒数、B站收藏夹给毫秒）；没有就是 null，不要拿 0 冒充。 */
  duration_ms?: number | null;
}

export interface AlbumInfo {
  id: string;
  /** 网易云的专辑与歌单是两种入口，但曲目列表与分页口径完全一致，用同一结构承载。 */
  kind?: 'album' | 'playlist';
  title: string;
  cover: string;
  tracks: AlbumTrack[];
  /** 曲目数对不上、部分曲目拿不到详情这类事实，必须往上传，不能静默补齐。 */
  warnings?: string[];
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
