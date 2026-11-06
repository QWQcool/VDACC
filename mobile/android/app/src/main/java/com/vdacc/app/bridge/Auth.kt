package com.vdacc.app.bridge

import android.content.Context
import android.content.Intent
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * 端上登录（M6 后续）。
 *
 * 三个设计决定，都是为了「凭据不离开原生」：
 *
 * 1. **登录发生在系统 WebView 里**（[com.vdacc.app.LoginActivity]），不是在本项目的 asset 页面里。
 *    asset 页面有桥、能跑引擎；登录页是远端站点，**不注入任何 JavascriptInterface**，
 *    它拿到的只是浏览器语义下的 cookie。
 * 2. **cookie 不出原生**：JS 侧既拿不到也不传 cookie。`http.request` 与 `transfer.start`
 *    在发请求前按 host 自动补 `Cookie` 头（见 [headerFor]），所以引擎代码一行不用改，
 *    也就没有「cookie 写进 localStorage / 日志」的机会。
 * 3. **状态如实**：`auth.status` 只报 cookie 名字数与在线校验结果，不返回值本身。
 *
 * 与桌面端的差别：桌面用 Playwright 起独立 Edge 扫码；端上用 WebView 登录后，
 * cookie 由系统 CookieManager 持久化（进程重启后仍在），不需要另存文件。
 */
object Auth {

    private class Site(
        val key: String,
        val label: String,
        /** 登录页（第一个是给人看的登录入口）。 */
        val loginUrl: String,
        /** 取样 cookie 的 url 列表：CookieManager 按域返回，多个子域要分别取。 */
        val probeUrls: List<String>,
        /** 判定「登录过」的关键 cookie 名（与桌面端 auth.ts 的 keys 对齐）。 */
        val keyNames: List<String>,
        /** 在线校验接口。 */
        val verifyUrl: String,
        val verifyReferer: String,
        /** 从校验响应里取 (ok, 一句话)。 */
        val parse: (JSONObject) -> Pair<Boolean, String>,
        /**
         * 校验地址要带凭据时用（QQ 的 musicu 接口把 uin/authst 放在 query 里）。
         * 返回空串表示「凭据不全，没法校验」，[verify] 会如实回一条原因，不去打空地址。
         */
        val verifyUrlFor: ((String) -> String)? = null,
    )

    private val SITES = listOf(
        Site(
            key = "bilibili",
            label = "B站",
            loginUrl = "https://passport.bilibili.com/login",
            probeUrls = listOf(
                "https://www.bilibili.com",
                "https://api.bilibili.com",
                "https://passport.bilibili.com",
            ),
            keyNames = listOf("SESSDATA", "DedeUserID"),
            verifyUrl = "https://api.bilibili.com/x/web-interface/nav",
            verifyReferer = "https://www.bilibili.com/",
            parse = { body ->
                val data = body.optJSONObject("data") ?: JSONObject()
                if (data.optBoolean("isLogin")) {
                    val name = data.optString("uname")
                    val vip = data.optInt("vipStatus", 0)
                    true to (name + if (vip == 1) "（大会员）" else "")
                } else {
                    false to "cookie 已失效"
                }
            },
        ),
        Site(
            key = "netease",
            label = "网易云",
            loginUrl = "https://music.163.com/#/login",
            probeUrls = listOf("https://music.163.com", "https://interface.music.163.com"),
            keyNames = listOf("MUSIC_U"),
            verifyUrl = "https://music.163.com/api/nuser/account/get",
            verifyReferer = "https://music.163.com/",
            parse = { body ->
                val profile = body.optJSONObject("profile")
                if (profile != null && profile.optString("nickname").isNotEmpty()) {
                    val vip = profile.optInt("vipType", 0)
                    true to (profile.optString("nickname") + if (vip > 0) "（黑胶）" else "")
                } else {
                    false to "cookie 已失效"
                }
            },
        ),
        // QQ 音乐：关键 cookie 是 qm_keyst；uin 与 authst 必须进请求体/query，
        // 所以额外提供 verifyUrlFor（桌面端 auth.ts 的 qq 校验用同一套字段）。
        Site(
            key = "qq",
            label = "QQ音乐",
            loginUrl = "https://y.qq.com/",
            probeUrls = listOf("https://y.qq.com", "https://u.y.qq.com", "https://c.y.qq.com"),
            keyNames = listOf("qm_keyst"),
            verifyUrl = "https://u.y.qq.com/cgi-bin/musicu.fcg",
            verifyReferer = "https://y.qq.com/",
            parse = { body ->
                val req = body.optJSONObject("req_1")
                val nick = req?.optJSONObject("data")?.optJSONObject("info")?.optString("nick") ?: ""
                if (req != null && req.optInt("code", -1) == 0 && nick.isNotEmpty()) {
                    true to nick
                } else {
                    false to "未登录（code=${req?.opt("code") ?: "?"}）"
                }
            },
            verifyUrlFor = { cookie ->
                val uin = qqUin(cookie)
                val authst = qqAuthst(cookie)
                val numeric = uin.toLongOrNull()
                if (numeric == null || authst.isEmpty()) {
                    // 凭据不全就别打接口：空地址会让 HttpURLConnection 抛一句用户看不懂的异常
                    ""
                } else {
                    val data = JSONObject()
                        .put("comm", JSONObject().put("ct", 24).put("cv", 0)
                            .put("uin", numeric).put("authst", authst))
                        .put("req_1", JSONObject()
                            .put("module", "music.UserInfo.userInfoServer")
                            .put("method", "GetLoginUserInfo")
                            .put("param", JSONObject()))
                    "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=" +
                        URLEncoder.encode(data.toString(), "UTF-8")
                }
            },
        ),
    )

    private fun site(key: String): Site? = SITES.find { it.key == key }

    /** 某站点当前的 cookie 头（name=value; ...）。只给原生请求用，不回传给 JS。 */
    fun cookieHeader(key: String): String {
        val info = site(key) ?: return ""
        val manager = CookieManager.getInstance()
        val pairs = LinkedHashMap<String, String>()
        for (url in info.probeUrls) {
            val raw = try {
                manager.getCookie(url)
            } catch (_: Exception) {
                null
            } ?: continue
            for (part in raw.split(';')) {
                val trimmed = part.trim()
                if (trimmed.isEmpty()) continue
                val eq = trimmed.indexOf('=')
                if (eq <= 0) continue
                pairs[trimmed.substring(0, eq)] = trimmed.substring(eq + 1)
            }
        }
        return pairs.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    /**
     * 按目标 url 决定要不要带 cookie。
     *
     * 只认站点的**接口域名**：`*.bilibili.com`、`*.163.com`，以及 QQ 音乐的
     * `y.qq.com` / `u.y.qq.com` / `c.y.qq.com`。
     * CDN（`m700.music.126.net`、`upos-*.bilivideo.com`、`*.stream.qqmusic.qq.com`）不带 cookie——
     * 与桌面端一致（那里也是只给接口带 Cookie，播放地址本身是签名的）。
     *
     * QQ 为什么不像前两家那样按后缀放行：`isure.stream.qqmusic.qq.com` 也在 `qq.com` 下，
     * 后缀匹配会把签名 cookie 发给 CDN，而它根本不需要。
     */
    fun headerFor(url: String): String {
        val host = try {
            URL(url).host.lowercase()
        } catch (_: Exception) {
            return ""
        }
        val key = when {
            host == "bilibili.com" || host.endsWith(".bilibili.com") -> "bilibili"
            host == "163.com" || host.endsWith(".163.com") -> "netease"
            host == "y.qq.com" || host == "u.y.qq.com" || host == "c.y.qq.com" -> "qq"
            else -> return ""
        }
        return cookieHeader(key)
    }

    /** cookie 头里的 `uin=o1234567890` → `1234567890`；拿不到回空串。 */
    private fun qqUin(cookie: String): String =
        Regex("(?:^|;\\s*)uin=o?(\\d+)").find(cookie)?.groupValues?.get(1) ?: ""

    /** qm_keyst 可能被 URL 编码过（与桌面端 auth.ts 同一处理）。 */
    private fun qqAuthst(cookie: String): String {
        val raw = Regex("(?:^|;\\s*)qm_keyst=([^;]+)").find(cookie)?.groupValues?.get(1) ?: ""
        if (raw.isEmpty()) return ""
        return try {
            URLDecoder.decode(raw, "UTF-8")
        } catch (_: Exception) {
            raw
        }
    }

    /**
     * 只回 uin（账号数字），**不回 cookie 值**。
     *
     * 为什么必须给引擎：QQ 的 vkey 请求要在 **body** 里带 uin（cookie 头也带，但接口认 body），
     * 而拼 body 的是 JS 侧引擎。uin 是账号标识不是密钥，拿到它并不能冒充登录；
     * qm_keyst 仍然只在原生里，由 [headerFor] 补进 Cookie 头。
     */
    fun uin(key: String): String {
        if (key != "qq") return ""
        return qqUin(cookieHeader("qq"))
    }

    /**
     * 只读判断「关键 cookie 在不在」，**不联网**。
     *
     * 引擎探测时要用它决定「未登录」那句 warning 该不该说；探测每次都联网验一次会把
     * 解析拖慢一倍，而「cookie 在但已过期」这种情况在真正取地址时会被接口自己拒绝。
     */
    fun loggedIn(key: String): Boolean {
        val info = site(key) ?: return false
        val header = cookieHeader(info.key)
        if (header.isEmpty()) return false
        val names = header.split(';').map { it.trim().substringBefore('=') }
        return info.keyNames.all { names.contains(it) }
    }

    /** 登录状态：本地有哪些关键 cookie + 在线校验。不返回值本身。 */
    fun status(): JSONObject {
        val rows = JSONArray()
        for (info in SITES) {
            val header = cookieHeader(info.key)
            val names = header.split(';').map { it.trim().substringBefore('=') }.filter { it.isNotEmpty() }
            val loggedIn = info.keyNames.all { names.contains(it) }
            val row = JSONObject()
                .put("site", info.key)
                .put("label", info.label)
                .put("loggedIn", loggedIn)
                .put("cookies", names.size)
                .put("updatedAt", JSONObject.NULL)
            if (!loggedIn) {
                row.put("online", JSONObject()
                    .put("site", info.key)
                    .put("label", info.label)
                    .put("ok", false)
                    .put("message", "端上未登录"))
            } else {
                row.put("online", verify(info, header))
            }
            rows.put(row)
        }
        return JSONObject().put("sites", rows)
    }

    /** 在线校验：拿真账号问一次，避免「有 cookie 但早过期」被显示成已登录。 */
    private fun verify(info: Site, cookie: String): JSONObject {
        val base = JSONObject()
            .put("site", info.key)
            .put("label", info.label)
        // 需要带凭据的站点（QQ）现拼地址；拼不出来就把原因说清楚，不去打空地址
        val target = info.verifyUrlFor?.invoke(cookie) ?: info.verifyUrl
        if (target.isEmpty()) {
            return base.put("ok", false).put("message", "cookie 里缺少 uin 或 qm_keyst，无法在线校验")
        }
        return try {
            val conn = (URL(target).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 12_000
                readTimeout = 12_000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", UA)
                setRequestProperty("Referer", info.verifyReferer)
                setRequestProperty("Accept", "application/json, text/plain, */*")
                if (cookie.isNotEmpty()) setRequestProperty("Cookie", cookie)
            }
            val text = try {
                conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            } finally {
                try { conn.disconnect() } catch (_: Exception) { }
            }
            val body = JSONObject(text)
            val (ok, message) = info.parse(body)
            base.put("ok", ok).put("message", message)
        } catch (error: Exception) {
            base.put("ok", JSONObject.NULL).put("message", "校验失败：${error.message}")
        }
    }

    /** 打开登录页（远端站点，无桥）。 */
    fun startLogin(ctx: Context, key: String): JSONObject {
        val info = site(key) ?: throw BridgeException("bad_input", "未知站点：$key")
        val intent = Intent(ctx, com.vdacc.app.LoginActivity::class.java).apply {
            putExtra("site", info.key)
            putExtra("url", info.loginUrl)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(intent)
        return JSONObject().put("started", true).put("site", info.key)
    }

    /**
     * 退出登录：把本站点已知的 cookie 逐个置空并立即 flush。
     *
     * 为什么不 `removeAllCookies`：那会把两个站点一起清掉（甚至影响别的 WebView 页面），
     * 用户只想退一个站时不能顺手把另一个也退了。
     */
    fun logout(key: String): JSONObject {
        val info = site(key) ?: throw BridgeException("bad_input", "未知站点：$key")
        val manager = CookieManager.getInstance()
        var cleared = 0
        for (url in info.probeUrls) {
            val raw = try { manager.getCookie(url) } catch (_: Exception) { null } ?: continue
            for (part in raw.split(';')) {
                val name = part.trim().substringBefore('=')
                if (name.isEmpty()) continue
                try {
                    manager.setCookie(url, "$name=; Max-Age=0; Path=/")
                    cleared += 1
                } catch (_: Exception) {
                    // 单条失败不影响其它
                }
            }
        }
        try { manager.flush() } catch (_: Exception) { }
        return JSONObject().put("cleared", cleared)
    }

    private const val UA =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"
}
