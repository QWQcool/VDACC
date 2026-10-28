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
| 本仓实现 | `ts/src/engines/kuwo.ts`（公开接口，不需要登录/签名） |
| 详情/歌词 | `GET https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=<rid>` → `data.songinfo` + `data.lrclist` |
| 播放地址 | `GET https://mobi.kuwo.cn/mobi.s?f=web&source=jiakong&type=convert_url_with_sign&rid=<rid>&br=2000kflac` → `data.url/format/bitrate`；`http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_<rid>` 兜底 |
| 搜索补字段 | `http://search.kuwo.cn/r.s?ft=music&itemset=web_2013&client=kt&rformat=json&encoding=utf8&all=<kw>`（单引号伪 JSON，按字段抠） |
| 匿名实测 | 128kbps mp3；`br=2000kflac` 未放行；`Range` 能取真实总字节 |
| 登录/会员 | 未接。无损走签名接口，本仓不逆向签名、不伪造会员 |

## 酷狗音乐

| 项 | 值 |
|---|---|
| 本仓实现 | `ts/src/engines/kugou.ts` |
| 详情 | `GET https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=<hash>` → `songName/singerName/album_img/url(128k)/bitRate/timeLength` |
| 搜索 | `https://mobiles.kugou.com/api/v3/search/song?format=json&keyword=<kw>` → `sqhash` / `320hash` + `pay_type_*` |
| 播放地址 | `http://trackercdn.kugou.com/i/?cmd=4&pid=1&acceptMp3=1&hash=<hash>&key=md5(hash+'kgcloud')` |
| 匿名实测 | 付费曲 trackerCdn 返回 `The Resource Needs to be Paid`（`status=0`），只剩 getSongInfo 的 128k 地址 |
| 签名 | 用的是 v1 `kgcloud`；文档里 v2 `kgcloudv2` 未验证 |
| 登录 | 未接，不做 `.kgm` 解密 |

## 实现顺序与验收

1. 抽 `MusicEngine` 抽象（已完成：`ts/src/engines/music.ts`）；
2. QQ → 酷我 → 酷狗，逐个实现 `probe`；
3. 每个平台用一个免费样本验证：标题/歌手/时长/封面一致，下载文件容器与码率符合声明；
4. 有账号后再补 320k/FLAC 与 cookie 过期提示；
5. **不做**：歌单/专辑批量（后续单独评估）、DRM、客户端私有加密容器。

## 当前状态（2026-10-23）

- **QQ 音乐已接入**：`ts/src/engines/qq.ts` 的 `canHandle` / `probeQQ` / `getQQ`，已注册到
  `platformOf`（只认 `*.qq.com` 域名，裸 mid 不参与路由）/ `server` / `cli`。
  下载实测（《轻轻》）：128K MP3 **3,554,923 字节**（原始 3,529,853 + 封面/标签），
  ffprobe 确认 128000bps、`mjpeg` 封面流、title/artist/album 三个标签；96K AAC 2.60MB 同样带封面。
  落盘走 `.part` + Range 续传 + 与其它引擎共用的限速。
- **登录已接**：`bun ts/src/cli.ts auth qq` 扫码写 `%LOCALAPPDATA%\vdl\auth\qq.json`（实测 49 cookies），
  `probeQQ` 自动带 `comm.uin` + `comm.authst`(qm_keyst) 与 `param.uin`；`auth --status` 可在线校验（返回昵称）。
- 登录实测（2026-10-23，账号非会员）：**同一批歌曲登录前后档位完全一致**——
  《雨爱》《我怀念的》《告白气球》三档全 `104003`，《轻轻》仍只有 128K MP3 / 96K AAC。
  即 320K/FLAC 由**账号会员权限**决定，代码已把凭据带上，换会员账号会自动生效（但未验证过）。
- 匿名实测（2026-10-22）：
  - 单曲详情 `c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=<mid>&platform=yqq&format=json` 可用；
  - 播放地址走 `u.y.qq.com/cgi-bin/musicu.fcg` 的 `vkey.GetVkeyServer` / `CgiGetVkey`，
    返回 `sip[]` + `midurlinfo[].purl`；`songmid` 与 `filename` 按下标配对，一个 mid 多档位要重复写；
  - 匿名只对**部分免费曲**放行：实测《轻轻》拿到 `M500`（3,529,853 字节）与 `C400`（2,703,704 字节），
    分别等于 `file.size_128mp3` / `file.size_96aac`；其余档位 `result=104003`（需登录），
    320K/FLAC 匿名一律拿不到；
  - 搜索不稳定：`musicu.fcg` 的 `DoSearchForQQMusicDesktop` 匿名返回 `req_1.code=2001` +
    `feedbackURL`（登录页）；登录后实测一次 `code=0` 返回 3 条，下一次又回到 2001。
    因此不做关键词搜索，只吃 songmid / 分享链接。
- **专辑批量已接**：`--album` 支持网易云 `/api/album/{id}` 与 QQ `fcg_v8_album_info_cp`，
  上限 20（`core/album.ts` 的 `planAlbum`），`--dry-run` 先看曲目；逐首下载，单首失败继续并在结尾汇总。
- **歌词已落盘**：`fcg_query_lyric_new.fcg`（`nobase64=1`）→ 同名 `.lrc`，失败不影响音频。
- **状态口径（2026-10-27，仅离线验证）**：probe 现在返回全部四个档位，不可用档 `available:false`
  且 `reason` 带真实 `result` 代码（或「接口没有返回」），不再推断成会员/付费；
  显式指定的档位不可用时报 `no_stream` 而不是静默换档；下载字节明显小于接口声明的整曲大小
  （<60%）时报 `incomplete_media`，不把试听片段当完整下载。见 `docs/design/qq-capability-baseline.md`。
- 未做（不假装支持）：会员档位实测（当前账号 320K/FLAC 仍 104003）、歌单。
- **酷我 / 酷狗已接入**：公开接口 probe + 下载（`.part` 续传 + 限速）+ ffmpeg 标签/封面，
  酷我另落 `.lrc`；已注册 `platformOf` / server / cli。实测：酷我《花海》128kbps 3,368,054 字节，
  酷狗《恒星不忘》128kbps 4,631,150 字节（带 `mjpeg` 封面）。
- **酷我元数据降级（2026-10-27，含真实验证）**：`songinfoandlrc` 偶发 `status=301`，此时标题先用
  rid，下载后从**文件自带 ID3** 补全（`core/tags.ts` 纯 JS 解析，不依赖 ffprobe）。
  实测《花海》落盘名 `474678847_花海 (DJ 阿若版)_128kbps.mp3`，ffprobe 标签正确。
- **酷我/酷狗状态口径（2026-10-27，仅离线验证）**：两家都没有登录能力，全档不可用时报
  `filtered`（不再让用户去登录）；显式档位不可用报 `no_stream`；下载字节 < 探测总字节 95% 报
  `incomplete_media`；酷狗把「获取失败 / 搜索没命中 / 接口标记付费」分开说，不再称公开档为
  「试听档」。见 `docs/design/kuwo-kugou-capability-baseline.md`。
- **网易云档位（2026-10-27，含真实环境实测）**：probe 现在探**四档**（无损/320K/128K/96K）；
  免费曲对无会员权益的账号至少能下 128K（实测《雨爱(钢琴版)》128K 3.93MB），会员专享曲仍全部 `code=404`。
  128K 与 96K 常返回字节相同的文件，已按字节判重并说明。未放行的
  `available:false` 且 `reason` 带平台 `code`；详情查不到歌改报 `not_found`；显式档位不可用报
  `no_stream` 不换档；下载字节 < 接口声明 60% 报 `incomplete_media`。
  见 `docs/design/netease-capability-baseline.md`。
- 服务端设置页后续加「音乐账号」页签（与 B站/网易云并列）。
