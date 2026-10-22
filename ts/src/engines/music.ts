/**
 * 音乐扩展骨架（3.1）。三家渠道的规格见 docs/music-channels.md。
 *
 * 现在只定义类型与注册表，**不接入运行时**：
 * - 没有 QQ/酷狗/酷我 的 cookie，无法验证会员档；
 * - 渠道参数需要在拿到账号后逐项对拍，避免"写完不能验"。
 */
import type { ProbeResult } from '../core/types';

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  duration_ms: number;
  source_url: string;
  platform: 'qq' | 'kugou' | 'kuwo';
}

export interface MusicFormat {
  id: string;
  label: string;
  ext: 'mp3' | 'flac' | 'm4a';
  bitrate: number;
  bytes: number | null;
  level: 'lossless' | 'exhigh' | 'standard';
}

export interface MusicEngine {
  readonly id: MusicTrack['platform'];
  readonly hosts: readonly string[];
  canHandle(url: string): boolean;
  probe(url: string): Promise<ProbeResult>;
  download(track: MusicTrack, format: MusicFormat, outDir: string): Promise<{
    path: string;
    bytes: number;
    warnings: string[];
  }>;
}

/** 由 platform 路由持有；3.1 实现完成后再注册。 */
export const musicEngines: MusicEngine[] = [];
