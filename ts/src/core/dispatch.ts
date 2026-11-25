/**
 * 「这条链接到底该交给谁」的唯一判定点（CLI / 服务端共用）。
 *
 * 唯一有歧义的是 `v.douyin.com` 短链：短视频与抖音商城**共用同一个短链域名**，
 * 必须先跟一次重定向才知道落点是 `www.douyin.com/video/...` 还是 `haohuo.jinritemai.com/...`。
 * 其它输入一律走纯函数 `platformOf`，不多打一次网络。
 */
import { resolveShopTarget } from '../engines/douyin_shop';
import { platformOf, type Platform } from './platform';

export interface ResolvedTarget {
  platform: Platform;
  /** 商城短链会被替换成最终的 `haohuo` 商品页地址；其它情况原样返回 */
  target: string;
}

export async function resolveTarget(input: string): Promise<ResolvedTarget> {
  const platform = platformOf(input);
  if (platform !== 'douyin' && platform !== 'unsupported') return { platform, target: input };

  // 解析失败（断网/短链失效）不该在这里抛：交给后面的引擎给出更专业的错误
  const shop = await resolveShopTarget(input).catch(() => null);
  if (shop) return { platform: 'douyin-shop', target: shop };
  return { platform, target: input };
}
