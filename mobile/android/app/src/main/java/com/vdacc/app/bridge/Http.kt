package com.vdacc.app.bridge

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPInputStream

/**
 * 网络请求（`http.request`）。
 *
 * 为什么必须有这个桥：页面跑在 `file:///android_asset/` 下，属于不透明来源，
 * 直接 `fetch('https://www.douyin.com/...')` 会被 CORS 挡掉——抖音不会给我们
 * `Access-Control-Allow-Origin`。鸿蒙版靠 `httpRequest` 桥解决同一个问题。
 *
 * 为什么不用 OkHttp：设计稿写的是 OkHttp，但它是第三方依赖（约 800KB），
 * 与「零依赖壳」的既有约定冲突；M1 需要的只是 GET/POST、自定义头、重定向、超时、
 * 二进制读取，`HttpURLConnection` 全部覆盖。等真需要连接池/HTTP2 再评估。
 *
 * 为什么响应体要设上限：这是「一次往返拿完整 body」的接口，不是流式下载。
 * 视频/音频必须走 `transfer.*`（流式写盘），走这里会把整个文件读进内存并 base64
 * 膨胀 1.4 倍——端上直接 OOM。超限就明确报错，不静默截断。
 */
class Http {

    companion object {
        /** 24MB：足够装下任何 JSON 接口响应，又不会把内存打爆。 */
        private const val MAX_BODY = 24 * 1024 * 1024
        private const val DEFAULT_TIMEOUT = 20_000
    }

    fun request(payload: JSONObject): JSONObject {
        val url = payload.optString("url").trim()
        if (url.isEmpty()) throw BridgeException("bad_request", "http.request 缺少 url")
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            throw BridgeException("bad_request", "只支持 http/https：$url")
        }

        val method = payload.optString("method", "GET").uppercase()
        val timeout = payload.optInt("timeoutMs", DEFAULT_TIMEOUT).coerceIn(1_000, 120_000)
        val bodyBytes = payload.optString("bodyBase64").takeIf { it.isNotEmpty() }?.let {
            try {
                Base64.decode(it, Base64.NO_WRAP)
            } catch (error: IllegalArgumentException) {
                throw BridgeException("bad_request", "bodyBase64 不是合法 base64")
            }
        }

        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeout
            readTimeout = timeout
            instanceFollowRedirects = true
            // 默认 UA 是 Java/xx，平台会直接判成爬虫；真 UA 由 JS 侧传进来
            setRequestProperty("User-Agent", "vdacc")
        }

        val headers = payload.optJSONObject("headers")
        var callerSetCookie = false
        if (headers != null) {
            for (name in headers.keys()) {
                val value = headers.optString(name)
                if (value.isNotEmpty()) connection.setRequestProperty(name, value)
                if (name.equals("Cookie", ignoreCase = true)) callerSetCookie = true
            }
        }
        // 登录态由原生补：JS 侧拿不到也不该拿到 cookie（引擎代码因此零改动）。
        // 调用方显式设了 Cookie 就尊重它的（桌面端导出的场景）。
        if (!callerSetCookie) {
            val cookie = Auth.headerFor(url)
            if (cookie.isNotEmpty()) connection.setRequestProperty("Cookie", cookie)
        }

        try {
            if (bodyBytes != null && method != "GET" && method != "HEAD") {
                connection.doOutput = true
                // 不设这个的话 HttpURLConnection 会把 body 转成 chunked，
                // 有些接口（抖音）对 chunked 的 POST 直接拒
                connection.setFixedLengthStreamingMode(bodyBytes.size)
                connection.outputStream.use { it.write(bodyBytes) }
            }

            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val raw = stream?.use { readCapped(it, connection.getContentEncoding()) } ?: ByteArray(0)

            return JSONObject()
                .put("status", status)
                .put("url", connection.url?.toString() ?: url)
                .put("headers", pairs(connection.headerFields, skip = "set-cookie"))
                .put("setCookie", setCookies(connection.headerFields))
                .put("bytes", raw.size)
                .put("bodyBase64", Base64.encodeToString(raw, Base64.NO_WRAP))
        } catch (error: BridgeException) {
            throw error
        } catch (error: Exception) {
            // 断网/DNS/超时都在这里：给一个稳定错误码，JS 侧才能区分「网络问题」与「接口报错」
            throw BridgeException("ENET", "${error.javaClass.simpleName}: ${error.message}")
        } finally {
            try {
                connection.disconnect()
            } catch (_: Exception) {
                // 已经断了
            }
        }
    }

    /**
     * 读响应体，超过上限就报错而不是截断（截断的 JSON 会变成更难查的 bad_json）。
     *
     * 为什么要单独处理 **deflate**：B站的弹幕接口 `x/v1/dm/list.so` 回的是
     * `Content-Encoding: deflate` 的 XML。原来只认 gzip，deflate 的响应会被当成二进制文本
     * 直接交给 JS，表现为「弹幕 0 条」——看起来像「这个视频没有弹幕」，很难归因。
     */
    private fun readCapped(stream: java.io.InputStream, encoding: String?): ByteArray {
        val enc = (encoding ?: "").lowercase()
        if (enc.contains("gzip")) return readAll(GZIPInputStream(stream))
        if (enc.contains("deflate")) {
            // 两种 deflate：zlib 包装（RFC1950，B站用这种）与裸 deflate（RFC1951）
            val raw = readAll(stream)
            return try {
                inflate(raw, nowrap = false)
            } catch (_: Exception) {
                inflate(raw, nowrap = true)
            }
        }
        return readAll(stream)
    }

    private fun readAll(source: java.io.InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val read = source.read(buffer)
            if (read < 0) break
            if (out.size() + read > MAX_BODY) {
                throw BridgeException(
                    "body_too_large",
                    "响应超过 ${MAX_BODY / 1024 / 1024}MB，媒体请走 transfer（流式），不要用 http.request",
                )
            }
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    private fun inflate(raw: ByteArray, nowrap: Boolean): ByteArray {
        val inflater = java.util.zip.Inflater(nowrap)
        return java.util.zip.InflaterInputStream(raw.inputStream(), inflater).use { readAll(it) }
    }

    /** headerFields 的 key 可能为 null（首行状态），值是 List；同名头合成一行用 \n 分隔。 */
    private fun pairs(fields: Map<String?, List<String>>?, skip: String): JSONObject {
        val out = JSONObject()
        if (fields == null) return out
        for ((name, values) in fields) {
            if (name == null) continue
            if (name.equals(skip, ignoreCase = true)) continue
            out.put(name.lowercase(), values.joinToString("\n"))
        }
        return out
    }

    /** Set-Cookie 必须按**数组**回传：多条 cookie 合成一行会让 CookieJar 只解析到第一条。 */
    private fun setCookies(fields: Map<String?, List<String>>?): JSONArray {
        val out = JSONArray()
        if (fields == null) return out
        for ((name, values) in fields) {
            if (name == null || !name.equals("set-cookie", ignoreCase = true)) continue
            for (value in values) out.put(value)
        }
        return out
    }
}
