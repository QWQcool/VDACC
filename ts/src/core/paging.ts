/**
 * 列表入口的通用分页器（专辑 / 歌单 / 收藏夹共用）。
 *
 * 为什么只抽「分页」这一层：五个平台的抓取协议差别很大——
 *   - B站 收藏夹是服务端分页（pn/ps + has_more），条目还带「失效/私密」语义；
 *   - 网易云是「一次拿全量 trackIds，再按批补详情」的两段式；
 *   - QQ / 酷狗是「每页 N 条 + 声明总数」的经典分页。
 * 把这三类塞进同一个 interface 只会让每处都多一层无意义的适配。
 * 真正重复的是**分页循环本身**（去重、按声明总数收敛、上限保护、总数对不上的提示），
 * 所以这里只提供这一块，各引擎自己负责「把原始响应映射成曲目」。
 */

/** 单次最多列多少首：超过就停，并如实说明「之后的不再取」。 */
export const LIST_MAX = 5000;

export interface CollectPage {
  /** 这一页的原始条目（各平台自己的形状，调用方用 keyOf 取唯一键）。 */
  raws: unknown[];
  /** 平台声明的总数（首页通常会给；后续页给不给都行）。 */
  total?: number;
}

export interface CollectInput {
  /** 每页请求多少条（也是判断「本页是否满」的依据）。 */
  pageSize: number;
  /** 上限，默认 LIST_MAX。 */
  max?: number;
  /** 从原始条目里取唯一键：空键会被跳过，重复键只留第一次。 */
  keyOf: (raw: any) => string;
  /** 取一页；cursor 从 0 开始，由调用方换算成 page / song_begin。 */
  fetchPage: (cursor: number, size: number) => Promise<CollectPage>;
}

export interface CollectOutput {
  raws: unknown[];
  /** 平台声明的总数（拿不到就是 0，不要拿 raws.length 冒充）。 */
  declared: number;
  warnings: string[];
  /** 因重复被丢掉的条数（翻页边界重叠时会出现）。 */
  deduped: number;
}

/**
 * 一页页取到「够了 / 没数据了 / 到上限」为止。
 *
 * 三处停止条件都要，缺一个就会出问题：
 * - `declared` 收敛：平台总数 66、每页 100 时，第一次就该停（否则还会多请求一次空页）；
 * - 本页不足：总数缺失时只能靠「不满一页」判断到底了；
 * - max：接口异常（永远返回满页）时不能死循环，宁可少列并说明。
 */
export async function collectPages(input: CollectInput): Promise<CollectOutput> {
  const pageSize = Math.max(1, Math.floor(input.pageSize) || 1);
  const max = Math.max(1, Math.floor(input.max || LIST_MAX));
  const raws: unknown[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let declared = 0;
  let deduped = 0;

  for (let cursor = 0; cursor < max; cursor += pageSize) {
    const page = await input.fetchPage(cursor, pageSize);
    const list: unknown[] = Array.isArray(page?.raws) ? page.raws : [];
    if (!declared && page?.total) declared = Number(page.total) || 0;

    for (const raw of list) {
      const key = input.keyOf(raw);
      if (!key) continue;
      if (seen.has(key)) { deduped += 1; continue; }
      seen.add(key);
      raws.push(raw);
    }

    if (!list.length) break;
    if (declared && raws.length >= declared) break;
    // 不满一页 = 没有下一页（比「再请求一次拿空页」少一次往返）
    if (list.length < pageSize) break;
  }

  if (!raws.length) return { raws, declared, warnings, deduped };

  // 分页按整页取，最后一页可能把总数顶过 max：真截断到 max，文案才与行为一致
  // （否则界面写着「最多 5000 首」实际列了 5050 首，属于自己撒谎）。
  const truncated = raws.length > max;
  if (truncated) raws.length = max;

  if (truncated && declared > max) {
    warnings.push(`接口声明 ${declared} 首，单次最多列 ${max} 首，之后的不再取`);
  } else if (declared > raws.length) {
    warnings.push(`接口声明 ${declared} 首，只拿到 ${raws.length} 首，本次按实际拿到的列出`);
  } else if (truncated) {
    warnings.push(`单次最多列 ${max} 首，之后的不再取`);
  }
  return { raws, declared, warnings, deduped };
}
