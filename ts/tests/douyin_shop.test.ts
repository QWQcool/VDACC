/**
 * 抖音商城商品（`haohuo.jinritemai.com`）：pack 解析、档位、命名。
 *
 * 真实链路（起浏览器抓 pack）只在手工验证里跑——它要 Edge + node + playwright-core，
 * 放进用例会让「没装 Edge 的机器」整片红。这里把**纯计算**钉死：
 * 结构变了（字段名/分组/去重）能立刻发现，而那正是最容易被平台改的部分。
 */
import { describe, expect, test } from 'bun:test';

import { platformOf } from '../src/core/platform';
import {
  isShopUrl, maxImageUrl, parseShopPack, resolveShopTarget, shopFormats, shopProductId,
} from '../src/engines/douyin_shop';

/** 真实结构（2026-11-25 抓自 `_LVqIgXK4U0`）：video 组 + image 组，图片跨 CDN 重复出现。 */
const packWithVideo = {
  promotion_h5: {
    basic_info_data: { title_info: { title: '简顿无边框筒灯5代PRO嵌入式75mm防眩射灯普瑞全光谱客厅无主灯' } },
    shop_info: { basic_info: { shop_name: '简顿灯具旗舰店' } },
    head_figure_data: {
      media_list: [
        {
          type: 'video',
          name: '商品',
          content_list: [{
            url: 'https://v3-dy-o.zjcdn.com/abc/video/tos/cn/x.mp4?br=234',
            cover_url: 'https://p26-item.ecombdimg.com/img/ecom-shop-material/jpeg_m_aaa_sx_1_www1440-1440~tplv-x.webp',
            width: 576, height: 768,
          }],
        },
        {
          type: 'image',
          name: '商品',
          content_list: [
            { url: 'https://p26-item.ecombdimg.com/img/ecom-shop-material/jpeg_m_aaa_sx_1_www1440-1440~tplv-x.webp' },
            // 同一张图的另一个 CDN 域名：按 material 名去重，不能算两张
            { url: 'https://p3-item.ecombdimg.com/img/ecom-shop-material/jpeg_m_aaa_sx_1_www1440-1440~tplv-y.webp' },
            { url: 'https://p3-item.ecombdimg.com/img/ecom-shop-material/jpeg_m_bbb_sx_2_www1440-1440~tplv-x.webp' },
            { url: 'https://p26-item.ecombdimg.com/img/ecom-shop-material/jpeg_m_ccc_sx_3_www1440-1440~tplv-x.webp' },
          ],
        },
      ],
    },
  },
};

/** 只有图、没有视频的真实形态（`MHqC8UdFndI`）。 */
const packImagesOnly = {
  promotion_h5: {
    basic_info_data: { title_info: { title: '松果照明简约超薄普瑞全光谱护眼吸顶灯' } },
    head_figure_data: {
      media_list: [{
        type: 'image',
        content_list: [
          { url: 'https://p3-item.ecombdimg.com/img/ecom-shop-material/png_m_111_sx_1_www1080-1080~tplv-x.webp' },
          { url: 'https://p3-item.ecombdimg.com/img/ecom-shop-material/png_m_222_sx_2_www1440-1440~tplv-x.webp' },
        ],
      }],
    },
  },
};

const shopUrl = 'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3809614972175122558&origin_type=x';

describe('归属判定', () => {
  test('商城域名归 douyin-shop，短视频仍归 douyin', () => {
    expect(platformOf(shopUrl)).toBe('douyin-shop');
    expect(platformOf('https://www.douyin.com/video/7351234567890123456')).toBe('douyin');
    // 短链两用：本地判不出来，交给 resolveShopTarget 跟重定向
    expect(platformOf('https://v.douyin.com/abc/')).toBe('douyin');
  });

  test('非短链不联网：普通抖音链接直接返回 null', async () => {
    expect(await resolveShopTarget('https://www.douyin.com/video/123')).toBeNull();
    expect(await resolveShopTarget('https://example.com/x')).toBeNull();
    // 已经是商城地址就直接返回，不必再发请求
    expect(await resolveShopTarget(shopUrl)).toBe(shopUrl);
  });

  test('isShopUrl / productId 只认商品页字段', () => {
    expect(isShopUrl(shopUrl)).toBe(true);
    expect(isShopUrl('https://haohuo.jinritemai.com.evil.com/x?id=1')).toBe(false);
    expect(shopProductId(shopUrl)).toBe('3809614972175122558');
    expect(shopProductId('https://haohuo.jinritemai.com/x?product_id=1234567')).toBe('1234567');
    expect(shopProductId('https://haohuo.jinritemai.com/x?id=12')).toBe('');
  });
});

describe('pack 解析', () => {
  test('视频与图集分开取，图片按 material 去重', () => {
    const info = parseShopPack(packWithVideo, shopUrl);
    expect(info.title).toContain('简顿无边框筒灯');
    expect(info.shopName).toBe('简顿灯具旗舰店');
    expect(info.productId).toBe('3809614972175122558');
    expect(info.video?.url).toContain('x.mp4');
    expect(info.video?.width).toBe(576);
    expect(info.video?.height).toBe(768);
    expect(info.video?.cover).toContain('ecom-shop-material');
    // aaa 出现两次（不同 CDN），只算一张
    expect(info.images.length).toBe(3);
  });

  test('只有图没有视频时 video 为 null，不编一个空对象', () => {
    const info = parseShopPack(packImagesOnly, shopUrl);
    expect(info.video).toBeNull();
    expect(info.images.length).toBe(2);
    expect(info.title).toBe('松果照明简约超薄普瑞全光谱护眼吸顶灯');
  });

  test('结构缺失 / 空对象不炸，标题有兜底', () => {
    expect(parseShopPack({}).title).toBe('抖音商品');
    expect(parseShopPack(null).images).toEqual([]);
    expect(parseShopPack({ promotion_h5: { head_figure_data: { media_list: [] } } }).video).toBeNull();
  });
});

describe('档位与命名', () => {
  test('有视频：视频是推荐档；只有图：图集是推荐档', () => {
    const withVideo = shopFormats(parseShopPack(packWithVideo, shopUrl));
    expect(withVideo.map((f) => f.id)).toEqual(['shop-video', 'shop-images']);
    expect(withVideo[0].recommended).toBe(true);
    expect(withVideo[1].recommended).toBe(false);

    const onlyImages = shopFormats(parseShopPack(packImagesOnly, shopUrl));
    expect(onlyImages.map((f) => f.id)).toEqual(['shop-images']);
    expect(onlyImages[0].recommended).toBe(true);
    expect(onlyImages[0].label).toContain('2 张');
  });

  test('图片地址换成 1440/q100（页面给的是 1080 缩略）', () => {
    const out = maxImageUrl('https://p26-item.ecombdimg.com/img/ecom-shop-material/jpeg_m_a_sx_1_www1440-1440~tplv-x-resize_q:1080:1080:q90.webp');
    expect(out.endsWith('~tplv-5mmsx3fupr-resize_q:1440:1440:q100.webp')).toBe(true);
    // 没有 tplv 后缀时原样返回，不硬拼一个可能 404 的地址
    const bare = 'https://p26-item.ecombdimg.com/img/ecom-shop-material/jpeg_m_a';
    expect(maxImageUrl(bare)).toBe(bare);
  });
});
