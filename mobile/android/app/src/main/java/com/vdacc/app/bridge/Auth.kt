package com.vdacc.app.bridge

import android.content.Context
import android.content.Intent
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

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
     * 只认两个站点的**接口域名**：`*.bilibili.com` 与 `*.163.com`。
     * CDN（`m700.music.126.net`、`upos-*.bilivideo.com`）不带 cookie——
     * 与桌面端一致（那里也是只给接口带 Cookie，播放地址本身是签名的）。
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
            else -> return ""
        }
        return cookieHeader(key)
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
        return try {
            val conn = (URL(info.verifyUrl).openConnection() as HttpURLConnection).apply {
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
