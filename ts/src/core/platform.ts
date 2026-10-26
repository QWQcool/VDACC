export type Platform =
  | 'douyin' | 'netease' | 'bilibili' | 'qq' | 'kuwo' | 'kugou' | 'sniff' | 'unsupported';

/** 文本里的第一个 URL：分享文案常是「标题 + 链接 + 引导语」，不能整段当 URL 解析。 */
const URL_IN_TEXT = /https?:\/\/[^\s，。、；：！？）】"'<>]+/i;

export function firstUrl(input: string): string {
  const raw = (input || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const m = URL_IN_TEXT.exec(raw);
  return m ? m[0] : '';
}

/** 纯函数，CLI / Skill / 服务端共用，避免三处正则漂移。 */
export function platformOf(input: string): Platform {
  const raw = (input || '').trim();
  if (!raw) return 'unsupported';
  if (/^\d{15,20}$/.test(raw)) return 'douyin';
  // 整段分享文案（抖音/小红书式）先抽链接再判域名，否则会掉进通用解析
  const target = firstUrl(raw) || raw;
  if (/(^|\.)douyin\.com/i.test(hostOf(target))) return 'douyin';
  // QQ 音乐只认域名：songmid 是 14 位 base62，裸串识别会和任何 14 字符文本撞车，
  // 所以裸 mid 请用分享链接（引擎的 canHandle 仍支持裸 mid，供直接调用）
  if (/(^|\.)qq\.com$/i.test(hostOf(target))) return 'qq';
  if (/(^|\.)kuwo\.cn$/i.test(hostOf(target))) return 'kuwo';
  if (/(^|\.)kugou\.com$/i.test(hostOf(target))) return 'kugou';
  if (/^\d{1,12}$/.test(raw) ||
      /(^|\.)(music\.163\.com|163cn\.tv)$/i.test(hostOf(target))) return 'netease';
  if (/^BV[0-9A-Za-z]{10}$/.test(raw) ||
      /(^|\.)(bilibili\.com|b23\.tv)$/i.test(hostOf(target))) return 'bilibili';
  return 'unsupported';
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}
