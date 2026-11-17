/**
 * 平台 → 下载函数（音乐类）。**单条与批量共用这一张表。**
 *
 * 起因（2026-11-16 实测踩到）：专辑/歌单批量的下载循环里写的是
 * `platform === 'netease' ? getNetease : getQQ`，于是酷狗歌单里每一首都被交给 QQ 引擎，
 * 逐条报「识别不出 QQ 音乐 songmid」，20 首全失败；单条下载那条分支是对的。
 * 两边各写一份三元表达式，就注定会漏一个平台——所以把「哪个平台用哪个引擎」收成一处，
 * 新增平台只在这里加一行，并有用例守着这张表。
 *
 * 这里**只覆盖音乐类引擎**（能按单曲 URL 直接下的）：B站 / 抖音 有自己的探测与下载入口，
 * 酷我只有单曲没有批量列表，所以都不在这张表里。
 */
import { getKugou } from './kugou';
import { getNetease } from './netease';
import { getQQ } from './qq';

/** 三个引擎 `get*` 的共同形状（`formatId` 为 null 表示自动选档）。 */
export interface MusicDownloadOutcome {
  path: string;
  bytes: number;
  skipped?: boolean;
  warnings?: string[];
}

export type MusicDownloader = (
  input: string,
  formatId: string | null,
  outDir: string,
) => Promise<MusicDownloadOutcome>;

const TABLE: Record<string, MusicDownloader> = {
  netease: getNetease as unknown as MusicDownloader,
  qq: getQQ as unknown as MusicDownloader,
  kugou: getKugou as unknown as MusicDownloader,
};

/** 拿不到就返回 null（调用方负责给出「这个平台不支持批量」之类的可读错误）。 */
export function downloaderFor(platform: string): MusicDownloader | null {
  return TABLE[platform] || null;
}

/** 这张表里有哪些平台（CLI/服务端的错误文案与用例都从这里取，别各写一份）。 */
export function musicDownloadPlatforms(): string[] {
  return Object.keys(TABLE);
}
