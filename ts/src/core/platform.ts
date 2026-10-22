export type Platform = 'douyin' | 'netease' | 'bilibili' | 'unsupported';

/** 纯函数，CLI / Skill / 服务端共用，避免三处正则漂移。 */
export function platformOf(input: string): Platform {
  const raw = (input || '').trim();
  if (!raw) return 'unsupported';
  if (/^\d{15,20}$/.test(raw) || /(^|\.)douyin\.com/i.test(hostOf(raw))) return 'douyin';
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
