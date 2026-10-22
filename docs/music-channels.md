# 音乐渠道规格（3.1）

> 来源：朋友已授权的鸿蒙工程（渠道参考，不复制混淆代码）。
> 原则：只提取「域名 / 路径 / 必需 header / 签名参数 / cookie 名 / 返回字段」，
> 独立实现并实测。**没有账号时只能拿匿名档位，不承诺无损。**

## QQ 音乐

| 项 | 值 |
|---|---|
| 接口 | `https://u.y.qq.com/cgi-bin/musicu.fcg` |
| 签名 | 排序后的参数串 + 固定 salt 做 md5（salt 从参考实现提取，不写入仓库文档） |
| 凭据 | `uin`、`qm_keyst`、`skey` |
| 常用参数 | `songmid`、`format`、`platform=yqq.json` |
| 返回 | `req_1.data.body.song.list[]`（歌名/歌手/专辑/时长）、`vkey` + `filename` 拼播放地址 |
| 匿名 | 通常 128k mp3 |
| 优先级 | **1（需求最大）** |

## 酷我音乐

| 项 | 值 |
|---|---|
| 接口 | `https://www.kuwo.cn/api/www/*` |
| 必需 header | `Referer: https://www.kuwo.cn/`、`csrf`、`Cookie: kw_token=...` |
| 凭据 | `kw_token`（另有 `Hm_lvt_*` 等统计 cookie，可选） |
| 搜索/详情 | `/api/www/search/searchMusicBykeyWord`、`/api/www/music/musicInfo` |
| 播放地址 | `/api/www/music/playUrl?mid=...&type=convert_url3`（返回直链） |
| 匿名 | 常见 128k，部分 320k |
| 优先级 | **2（最快出结果）** |

## 酷狗音乐

| 项 | 值 |
|---|---|
| 接口 | `https://wwwapi.kugou.com/yy/index.php`、`https://trackercdn.kugou.com/i/v2/` |
| 签名 | `key = md5(hash + 'kgcloudv2')`，hash 来自歌曲详情 |
| 凭据 | `KuGoo`、`kg_mid`、`kg_dfid`、`userid`、`token` |
| 播放地址 | `trackercdn` 返回 `url[]`（需 `key`、`pid`、`behavior`） |
| 匿名 | 128k；320k/FLAC 需 VIP |
| 优先级 | **3** |

## 实现顺序与验收

1. 抽 `MusicEngine` 抽象（已完成：`ts/src/engines/music.ts`）；
2. QQ → 酷我 → 酷狗，逐个实现 `probe`；
3. 每个平台用一个免费样本验证：标题/歌手/时长/封面一致，下载文件容器与码率符合声明；
4. 有账号后再补 320k/FLAC 与 cookie 过期提示；
5. **不做**：歌单/专辑批量（后续单独评估）、DRM、客户端私有加密容器。

## 当前状态（2026-10-22）

- **QQ 音乐骨架已实现**：`ts/src/engines/qq.ts` 的 `canHandle` / `probeQQ`，**未注册到路由**
  （`platformOf` / `server` / `cli` 都不引用，`musicEngines` 仍为空）。没有账号，下载链路验证不了。
- 匿名实测（2026-10-22）：
  - 单曲详情 `c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=<mid>&platform=yqq&format=json` 可用；
  - 播放地址走 `u.y.qq.com/cgi-bin/musicu.fcg` 的 `vkey.GetVkeyServer` / `CgiGetVkey`，
    返回 `sip[]` + `midurlinfo[].purl`；`songmid` 与 `filename` 按下标配对，一个 mid 多档位要重复写；
  - 匿名只对**部分免费曲**放行：实测《轻轻》拿到 `M500`（3,529,853 字节）与 `C400`（2,703,704 字节），
    分别等于 `file.size_128mp3` / `file.size_96aac`；其余档位 `result=104003`（需登录），
    320K/FLAC 匿名一律拿不到；
  - 搜索匿名不可用：`musicu.fcg` 的 `DoSearchForQQMusicDesktop` 返回 `req_1.code=2001` +
    `feedbackURL`（登录页），`c.y.qq.com/soso/...` 返回空列表。所以只吃 songmid / 分享链接，不做关键词搜索。
- 未做（不假装支持）：cookie 登录（`uin` / `qm_keyst`）、`download()`、标签与封面写入、歌单/专辑。
- 酷我 / 酷狗：未开始。
- 服务端设置页后续加「音乐账号」页签（与 B站/网易云并列）。
