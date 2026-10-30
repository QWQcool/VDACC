/**
 * 登录态的只读查询（引擎侧）。
 *
 * 为什么需要它：`netease.ts` / `bilibili.ts` 早先无条件写「手机端未登录」的 warning，
 * 那时端上确实没有登录能力。现在有了登录，同一个视频可能是 1080P、同一首歌可能拿到无损，
 * 再把「未登录」摆在那儿就是**假话**——用户看到「仅匿名档」却勾到了 1080P，只会怀疑工具在骗人。
 *
 * 这里只问「关键 cookie 在不在」（原生读 CookieManager，不联网，毫秒级），
 * 在线有效性由设置面板的 `auth.status` 负责验——探测路径不该为一句 warning 多打两次网络。
 */
import { call } from '../shims/bridge';

export type LoginSite = 'bilibili' | 'netease' | 'qq';

export async function loggedIn(site: LoginSite): Promise<boolean> {
  try {
    const res = await call<{ loggedIn?: boolean }>('auth.loggedIn', { site }, { timeoutMs: 5_000 });
    return res.loggedIn === true;
  } catch {
    // 桥不可用（桌面 selftest 之类的场景）就当没登录：宁可少说一句，也不能谎报有权益
    return false;
  }
}
