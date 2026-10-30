package com.vdacc.app.bridge

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.vdacc.app.service.Notify
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * JS ↔ 原生的唯一入口。
 *
 * 通道形态沿用参考实现（HarmonyOS 版 PlatformBridge）的「**同步 post + 异步回投**」：
 *
 *   JS:   window.VDACC_BRIDGE.post(reqId, method, payloadJson)   ← @JavascriptInterface，立即返回
 *   原生: evaluateJavascript("__VDACC_BRIDGE_RESOLVE__('reqId','{...}')")   ← 活干完后回投
 *
 * 为什么必须是这个形状：`@JavascriptInterface` 方法只能同步返回值，而 fs 写盘、md5、
 * 将来的下载都是耗时操作；同步阻塞会把 JavaBridge 线程连同页面一起卡住。
 * 回投必须在主线程（evaluateJavascript 只能在 UI 线程调），所以这里用 Handler 转一次。
 *
 * 线程模型：**单线程 executor**。分块写必须严格保序，用线程池并发写同一个文件
 * 会静默写坏内容；M1 的下载并发放在 transfer 层，不在这里。
 */
class Bridge(private val ctx: Context, private val web: WebView) {

    companion object {
        /** 页面里 window.VDACC_BRIDGE 的注册名，改名要同步改 engine/shims/bridge.ts */
        const val NAME = "VDACC_BRIDGE"
        private const val TAG = "VDACC-Bridge"
        private const val ASSET_PREFIX = "file:///android_asset/"
    }

    private val paths = Paths(ctx)
    private val fs = Fs(ctx, paths)
    private val http = Http()
    private val media = Media(fs)
    private val transfer = Transfer(ctx, paths, fs).also { engine ->
        // 进度/完成是被推的，不走 reqId 信封：一次下载可能有上百条进度
        engine.emit = { jobId, payload -> emitEvent("transfer", jobId, payload) }
    }
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "vdacc-bridge")
    }

    /**
     * 网络调用单独一个池：`http.request` 动辄几秒，放在单线程 worker 上会把
     * fs 写块、进度回投全部堵在后面（下载流程里两者是交替的）。fs 必须保序，
     * http 不需要，所以拆开。
     */
    private val httpPool: ExecutorService = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "vdacc-http")
    }
    private val main = Handler(Looper.getMainLooper())

    /**
     * 只信任本地 asset 页面。Android 的 @JavascriptInterface **没有**来源白名单参数
     * （鸿蒙的 registerJavaScriptProxy 有 urlPermissionList），所以自己判。
     *
     * 为什么不在 MainActivity 里用 onPageStarted 记一个布尔标志：
     * @JavascriptInterface 方法由渲染线程**直接**调用，而 onPageStarted 是投递到 UI 线程的
     * 回调。页面很小（本地 asset）时，JS 可能在 UI 线程处理到 onPageStarted 之前就跑完了——
     * 真机上实测 `paths` 因此被误判成 untrusted。改成每次调用都**在 UI 线程当场读 web.url**，
     * 既不依赖时序，也不需要维护状态。
     */
    @JavascriptInterface
    fun post(reqId: String, method: String, payloadJson: String) {
        main.post {
            val url = try {
                web.url
            } catch (error: Exception) {
                null
            }
            if (url == null || !url.startsWith(ASSET_PREFIX)) {
                deliver(reqId, errorEnvelope("untrusted_page", "当前页面不是本地 asset 页面（${url ?: "未知"}），桥已拒绝调用"))
                return@post
            }
            val task = Runnable {
                val envelope = try {
                    val payload = if (payloadJson.isBlank()) JSONObject() else JSONObject(payloadJson)
                    JSONObject().put("ok", true).put("data", dispatch(method, payload))
                } catch (error: BridgeException) {
                    errorEnvelope(error.code, error.message)
                } catch (error: Exception) {
                    // 兜底也要带码：JS 侧按 code 分支，没码就等于让上层猜
                    errorEnvelope("EIO", error.message ?: error.javaClass.simpleName)
                }
                deliver(reqId, envelope)
            }
            // fs 必须保序（单线程）；http / auth 是耗时调用（auth 要联网校验），不跟着排队
            if (method.startsWith("http.") || method.startsWith("auth.")) {
                httpPool.execute(task)
            } else {
                worker.execute(task)
            }
        }
    }

    private fun dispatch(method: String, payload: JSONObject): Any = when (method) {
        "paths" -> {
            // 用户选了自选目录（SAF）就以它为准：界面上「保存到」必须与实际落盘位置一致
            val tree = OutDir.tree(ctx)
            JSONObject()
                .put("out", if (tree != null) "${OutDir.label(ctx, tree)}（自选目录）" else paths.outDisplay)
                .put("outKind", if (tree != null) "saf" else paths.outKind)
                .put("staging", paths.staging.absolutePath)
                .put("cache", paths.cache.absolutePath)
        }

        // 完成通知由 JS 侧发出：真正的完成时刻在 publish 之后（补标签/合并都在 JS 里）
        "ui.done" -> {
            Notify.done(ctx, payload.optString("name"), payload.optString("path"))
            JSONObject().put("shown", true)
        }

        // 登录（M6 后续）：状态只报「有没有/是否有效」，cookie 本身不回传 JS
        "auth.status" -> Auth.status()
        "auth.loggedIn" -> JSONObject().put("loggedIn", Auth.loggedIn(payload.optString("site")))
        "auth.login" -> Auth.startLogin(ctx, payload.optString("site"))
        "auth.logout" -> Auth.logout(payload.optString("site"))

        "http.request" -> http.request(payload)

        "transfer.start" -> transfer.start(payload)
        "transfer.cancel" -> transfer.cancel(payload)

        "crypto.md5Hex" -> md5Hex(payload.optString("text"))

        "fs.openWrite" -> fs.openWrite(payload.optString("name"))
        "fs.writeChunk" -> fs.writeChunk(payload.optString("handle"), payload.optString("base64"))
        "fs.closeWrite" -> fs.closeWrite(payload.optString("handle"))
        "fs.publish" -> fs.publish(payload.optString("name"))
        "fs.stat" -> fs.stat(payload.optString("name"))
        "fs.readHead" -> fs.readHead(payload.optString("name"), payload.optInt("bytes", 65536))
        "fs.rewrite" -> fs.rewrite(payload.optString("name"), payload.optString("base64"), payload.optLong("skip", 0))
        "fs.mkdirp" -> fs.mkdirp(payload.optString("path"))
        "fs.rename" -> fs.rename(payload.optString("from"), payload.optString("to"))

        // 音视频合并走 worker（默认分支）：它要读两个文件写一个文件，和 fs 抢同一个暂存区，
        // 放到 httpPool 里与下载并发跑会互相拖慢，而且合并期间没有别的桥调用需要插队。
        "media.mux" -> media.mux(
            payload.optString("video"),
            payload.optString("audio"),
            payload.optString("name"),
        )

        else -> throw BridgeException("unsupported_method", "端上还没有实现 $method")
    }

    private fun md5Hex(text: String): String {
        val digest = MessageDigest.getInstance("MD5").digest(text.toByteArray(Charsets.UTF_8))
        val out = StringBuilder(digest.size * 2)
        for (byte in digest) out.append(String.format("%02x", byte))
        return out.toString()
    }

    private fun errorEnvelope(code: String, message: String?): JSONObject = JSONObject()
        .put("ok", false)
        .put("error", JSONObject().put("code", code).put("message", message ?: code))

    /**
     * 回投结果。JSON 是合法 JS 表达式，用 JSONObject.quote 转成字符串字面量塞进去，
     * 不手拼引号——消息里带换行/引号时手拼必坏。
     */
    private fun deliver(reqId: String, envelope: JSONObject) {
        val script = "window.__VDACC_BRIDGE_RESOLVE__(${JSONObject.quote(reqId)},${JSONObject.quote(envelope.toString())})"
        main.post {
            try {
                web.evaluateJavascript(script, null)
            } catch (error: Exception) {
                // 页面正在销毁时 evaluateJavascript 会抛，不要让异常冒到桥线程外
                Log.w(TAG, "回投失败 reqId=$reqId：${error.message}")
            }
        }
    }

    /**
     * 事件回投（进度/完成），与 [deliver] 的区别：这是**推**，没有 reqId，
     * 页面按 jobId 订阅。名字与 shims/transfer.ts 里的全局函数必须一致。
     */
    private fun emitEvent(name: String, id: String, payload: JSONObject) {
        val args = "${JSONObject.quote(name)},${JSONObject.quote(id)},${JSONObject.quote(payload.toString())}"
        val script = "window.__VDACC_EVENT__&&window.__VDACC_EVENT__($args)"
        main.post {
            try {
                web.evaluateJavascript(script, null)
            } catch (error: Exception) {
                Log.w(TAG, "事件回投失败 $name/$id：${error.message}")
            }
        }
    }

    /** 页面退出时清理：关掉还开着的输出流并停掉桥线程。 */
    fun close() {
        try {
            fs.closeAll()
        } catch (error: Exception) {
            Log.w(TAG, "关闭文件句柄失败：${error.message}")
        }
        try {
            transfer.closeAll()
        } catch (error: Exception) {
            Log.w(TAG, "关闭传输线程失败：${error.message}")
        }
        worker.shutdownNow()
        httpPool.shutdownNow()
    }
}
