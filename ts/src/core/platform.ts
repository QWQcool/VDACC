export type Platform = 'douyin' | 'netease' | 'bilibili' | 'qq' | 'unsupported';

/** 纯函数，CLI / Skill / 服务端共用，避免三处正则漂移。 */
export function platformOf(input: string): Platform {
  const raw = (input || '').trim();
  if (!raw) return 'unsupported';
  if (/^\d{15,20}$/.test(raw) || /(^|\.)douyin\.com/i.test(hostOf(raw))) return 'douyin';
  // QQ 音乐只认域名：songmid 是 14 位 base62，裸串识别会和任何 14 字符文本撞车，
  // 所以裸 mid 请用分享链接（引擎的 canHandle 仍支持裸 mid，供直接调用）
  if (/(^|\.)qq\.com$/i.test(hostOf(raw))) return 'qq';
  if (/^\d{1,12}$/.test(raw) || /(^|\.)(music\.163\.com|163cn\.tv)$/i.test(hostOf(raw))) return 'netease';
  if (/^BV[0-9A-Za-z]{10}$/.test(raw) ||
      /(^|\.)(bilibili\.com|b23\.tv)$/i.test(hostOf(raw))) return 'bilibili';
  return 'unsupported';
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}
