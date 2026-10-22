export interface Part {
  index: number;
  title: string;
  duration_ms: number | null;
  url: string;
  selected: boolean;
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
