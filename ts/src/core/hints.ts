/**
 * 「码 → 人话」集中表。
 *
 * 为什么收在一处：各引擎此前各自 `throw new VdlError('http_500', '酷狗接口 HTTP 500')`，
 * 用户只看到状态码，不知道是重试、检查网络还是换账号；平台的业务码（QQ `104003`）
 * 也只有 QQ 一家翻成了人话。这里统一成两条：**HTTP 状态**与**平台业务码**。
 *
 * 两条纪律：
 * 1. 只写**实测/文档确认**过的含义，不确定就不写（宁可不解释，也不编）；
 * 2. 这里只产「说明与下一步」，不产错误码——`code` 仍由各自的引擎决定，契约不变。
 */

/**
 * HTTP 状态 → 一句话。
 * 返回空串表示「没有额外解释」，调用方不要因此改变原有 next_action。
 */
export function httpHint(status: number): string {
  const code = Number(status);
  if (!Number.isFinite(code) || code <= 0) return '';
  if (code === 401) return '接口要求登录或凭据已过期';
  if (code === 403) return '接口拒绝访问（可能是风控、地区限制或需要登录）';
  if (code === 404) return '接口说这个资源不存在（链接可能失效或已下架）';
  if (code === 408 || code === 504) return '接口超时，稍后重试';
  if (code === 412) return '请求被风控拦截（B站 常见），稍后重试或降低频率';
  if (code === 416) return '续传请求越界：文件可能已经下完，或 Range 起点超过了总长';
  if (code === 429) return '请求太频繁被限流，等一会儿再试';
  if (code === 451) return '因法律原因不可用（地区限制）';
  if (code >= 500) return '平台服务端错误，稍后重试';
  return '';
}

/**
 * 平台业务码 → 人话。只收已经搞清楚的码，key 用字符串（多数接口给的是数字或数字字符串）。
 */
const PLATFORM_CODES: Record<string, Record<string, string>> = {
  qq: {
    // 2026-11-20 实测：登录态下 12 首样本 320K/FLAC 全部回这个码，128K/96K 正常 →
    // 是账号权益问题，不是 cookie 没带上。
    '104003': '当前账号无此档位权益（320K/FLAC 需绿钻，或该曲仅对付费用户开放）',
  },
  netease: {
    // 常见且含义明确的码（-110 在会员矩阵里反复出现）
    '-110': '该曲无版权或已下架（也可能需要会员）',
    '404': '接口说没有这个资源（歌单/歌曲可能已删或私密）',
  },
  bilibili: {
    '-403': '没有访问权限（可能需要登录，或该内容有地区/年龄限制）',
    '-404': '资源不存在（稿件可能已删除）',
    '87007': '该内容需要大会员',
  },
};

/** 拿不到就返回空串（不猜）。 */
export function platformCodeHint(platform: string, code: string | number): string {
  const table = PLATFORM_CODES[String(platform)];
  if (!table) return '';
  return table[String(code)] || '';
}

/** 拼成错误信息后缀：`（…）`；没有解释时返回空串。 */
export function withHint(text: string): string {
  return text ? `（${text}）` : '';
}
