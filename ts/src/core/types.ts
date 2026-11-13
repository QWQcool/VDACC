export interface Config {
  outDir?: string;
  theme?: 'light' | 'dark';
  concurrency?: number;
  limitRate?: number;
  allowGeneric?: boolean;
  /** 安装通用组件时记下的 SHA256，供 doctor / components 核对「已校验」而不是只看文件存在。 */
  ytdlpSha256?: string;
}

export interface DownloadOptions { cover?: boolean; subs?: boolean; danmaku?: boolean }
export interface CoverResult { cover: string | null; warnings: string[] }

export interface Job extends DownloadOptions {
  id: string;
  url: string;
  formatId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  percent: number;
  bytes: number;
  total: number;
  path?: string;
  error?: { code: string; message: string; next_action?: string };
  createdAt: number;
  finishedAt?: number;
  cancelRequested?: boolean;
  srtCount?: number;
  danmakuCount?: number;
  /** 弹幕的 ASS 副本（能直接挂播放器看）；XML 原文始终是主产物。 */
  danmakuAss?: string;
  danmakuRendered?: number;
  danmakuSkipped?: number;
  warnings?: string[];
}

export interface Part {
  index: number;
  title: string;
  duration_ms: number | null;
  url: string;
  selected: boolean;
  /** B站 分P 的 cid；其它平台没有这一层，留空。 */
  cid?: number;
}

export interface Media {
  id: string;
  title: string;
  author: string;
  duration_ms: number | null;
  thumbnail: string;
  source_url: string;
  platform: string;
  parts: Part[];
  /** 简介/描述。只用于界面展示，不参与命名，也不保证所有平台都有。 */
  desc?: string;
}

export interface Format {
  id: string;
  label: string;
  width: number;
  height: number;
  ext: string;
  vcodec: string;
  acodec: string;
  fps: number;
  bytes: number | null;
  bitrate: number | null;
  watermark: boolean;
  recommended: boolean;
  available: boolean;
  reason: string | null;
  subtitles: Array<{ lang: string; name: string }>;
}

export interface ErrorBody {
  code: string;
  message: string;
  next_action: string;
}

/** 收藏夹 / 合集这类"列表入口"的条目。只描述可下载对象，不携带播放地址。 */
export interface CollectionItem {
  bvid: string;
  title: string;
  author: string;
  cover: string;
  duration_ms: number | null;
  url: string;
  /** `gone` = 已失效/被删；`private` = 无权限。两种都要如实显示，不能过滤掉。 */
  state: 'ok' | 'gone' | 'private';
}

export type CollectionKind = 'fav' | 'season';

export interface CollectionPage {
  source: 'bilibili-fav';
  kind: CollectionKind;
  id: string;
  title: string;
  owner: string;
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  items: CollectionItem[];
}

export interface ProbeResult {
  schema: number;
  ok: boolean;
  platform: string;
  engine: string;
  media: Media | null;
  formats: Format[];
  warnings: string[];
  error: ErrorBody | null;
}

export function emptyMedia(platform: string): Media {
  return {
    id: '', title: '', author: '', duration_ms: null, thumbnail: '',
    source_url: '', platform, parts: [],
  };
}

export function format(partial: Partial<Format> & { id: string; label: string }): Format {
  return {
    width: 0, height: 0, ext: 'mp4', vcodec: '', acodec: '', fps: 0,
    bytes: null, bitrate: null, watermark: false, recommended: false,
    available: true, reason: null, subtitles: [],
    ...partial,
  };
}
