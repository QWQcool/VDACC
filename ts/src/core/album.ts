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
 * 取前 N 首，并如实报告被略过的数量。
 * 不按“整张专辑”硬下——默认 20 是防误点，用户想全下可以自己分批。
 */
export function planAlbum(tracks: AlbumTrack[], max = MAX_ALBUM_TRACKS): {
  take: AlbumTrack[]; dropped: number;
} {
  const list = Array.isArray(tracks) ? tracks.filter((t) => t && t.id) : [];
  if (list.length <= max) return { take: list, dropped: 0 };
  return { take: list.slice(0, max), dropped: list.length - max };
}
