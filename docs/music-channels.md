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

## 当前状态

- 骨架已建，**未注册到路由**（`musicEngines` 为空）；
- 缺 QQ/酷狗/酷我 cookie，下载链路未验证；
- 服务端设置页后续加「音乐账号」页签（与 B站/网易云并列）。
