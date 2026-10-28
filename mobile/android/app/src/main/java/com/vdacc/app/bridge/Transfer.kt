package com.vdacc.app.bridge

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 流式下载（`transfer.start` / `transfer.cancel`）。
 *
 * 为什么不在 JS 里下：端上 `fetch` 走的是 `http.request`（一次性拿完整 body），
 * 一个 50MB 的视频要 base64 膨胀 1.4 倍再进 JS 堆，直接 OOM。这里原生按 64KB 流式写
 * staging 的 `.part`，内存占用与文件大小无关。
 *
 * 三个设计点：
 * 1. **进度靠事件推**（`__VDACC_EVENT__('transfer', jobId, {...})`），不用 reqId 信封——
 *    进度是持续推送，不是一问一答；`transfer.start` 立刻返回 jobId，调用方按 jobId 订阅。
 * 2. **续传靠 `.part` 的真实长度**：重下时带 `Range: bytes=<已有>-`，服务端回 206 就追加，
 *    回 200 说明它不认 Range，那就从 0 重写（不能把新内容接在旧内容后面）。
 * 3. **取消是协作式的**：置 flag + `disconnect()`，工作线程在下一个读块处退出，
 *    已写的内容留在 `.part` 里（下次能续），不会留下半截的公共文件。
 */
class Transfer(private val ctx: Context, private val paths: Paths, private val fs: Fs) {

    companion object {
        private const val BUFFER = 64 * 1024
        private const val PROGRESS_GAP_MS = 200L
    }

    private class Job(
        val id: String,
        val name: String,
        val url: String,
        val referer: String,
        val userAgent: String,
    ) {
        @Volatile var cancelled = false
        @Volatile var connection: HttpURLConnection? = null
        @Volatile var bytes = 0L
        @Volatile var total = 0L
    }

    private class Cancelled : Exception("cancelled")

    private val jobs = ConcurrentHashMap<String, Job>()
    private val pool: ExecutorService = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "vdacc-transfer")
    }
    private var seq = 0

    /** 由 [Bridge] 注入：把事件回投到页面（UI 线程）。 */
    var emit: (String, JSONObject) -> Unit = { _, _ -> }

    private fun stagingFile(name: String) = File(paths.staging, "$name.part")

    fun start(payload: JSONObject): JSONObject {
        val url = payload.optString("url").trim()
        if (url.isEmpty()) throw BridgeException("bad_request", "transfer.start 缺少 url")
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            throw BridgeException("bad_request", "只支持 http/https：$url")
        }
        // 复用 Fs 的校验：转移层同样不能接受带分隔符的文件名
        val name = fs.safeName(payload.optString("name"))
        val referer = payload.optString("referer", "")
        val userAgent = payload.optString("userAgent").ifEmpty {
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"
        }

        val job = synchronized(this) {
            seq += 1
            Job("t$seq", name, url, referer, userAgent)
        }
        jobs[job.id] = job
        val resumeFrom = stagingFile(name).length()

        pool.execute { run(job) }
        return JSONObject()
            .put("jobId", job.id)
            .put("name", name)
            .put("resumeFrom", resumeFrom)
    }

    fun cancel(payload: JSONObject): JSONObject {
        val id = payload.optString("jobId")
        val job = jobs[id] ?: return JSONObject().put("cancelled", false).put("reason", "任务不存在或已结束")
        job.cancelled = true
        // disconnect 会让阻塞中的 read() 立刻抛，不用等下一个 64KB
        try {
            job.connection?.disconnect()
        } catch (_: Exception) {
            // 已经断了
        }
        return JSONObject().put("cancelled", true)
    }

    private fun run(job: Job) {
        val file = stagingFile(job.name)
        var written = if (file.exists()) file.length() else 0L
        try {
            file.parentFile?.let { if (!it.exists() && !it.mkdirs()) {
                throw BridgeException("EACCES", "无法创建暂存目录 ${it.absolutePath}")
            } }

            val conn = (URL(job.url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                instanceFollowRedirects = true
                connectTimeout = 20_000
                readTimeout = 30_000
                setRequestProperty("User-Agent", job.userAgent)
                if (job.referer.isNotEmpty()) setRequestProperty("Referer", job.referer)
                if (written > 0) setRequestProperty("Range", "bytes=$written-")
            }
            job.connection = conn

            val status = conn.responseCode
            if (status !in 200..299) throw BridgeException("http_$status", "下载失败 HTTP $status")

            val resumed = status == 206 && written > 0
            if (!resumed) written = 0L // 服务端不认 Range：从 0 重写，别把新内容接在旧内容后面
            val length = conn.contentLengthLong
            job.total = if (length > 0) length + (if (resumed) written else 0L) else 0L
            job.bytes = written

            emit(job.id, JSONObject()
                .put("status", "start")
                .put("bytes", written)
                .put("total", job.total)
                .put("resumeFrom", if (resumed) written else 0L))

            FileOutputStream(file, resumed).use { out ->
                conn.inputStream.use { input ->
                    val buffer = ByteArray(BUFFER)
                    var lastEmit = 0L
                    while (true) {
                        if (job.cancelled) throw Cancelled()
                        val read = input.read(buffer)
                        if (read < 0) break
                        out.write(buffer, 0, read)
                        written += read
                        job.bytes = written
                        val now = System.currentTimeMillis()
                        if (now - lastEmit >= PROGRESS_GAP_MS) {
                            lastEmit = now
                            emit(job.id, JSONObject()
                                .put("status", "progress")
                                .put("bytes", written)
                                .put("total", job.total))
                        }
                    }
                }
                out.flush()
            }

            if (job.cancelled) throw Cancelled()

            // 完成：publish 到 Download/VDACC（.part 由 Fs 负责删除）
            val published = fs.publish(job.name)
            emit(job.id, JSONObject()
                .put("status", "done")
                .put("bytes", published.optLong("size", written))
                .put("path", published.optString("path"))
                .put("name", published.optString("name", job.name))
                .put("outKind", published.optString("outKind")))
        } catch (_: Cancelled) {
            emit(job.id, JSONObject()
                .put("status", "cancelled")
                .put("bytes", if (file.exists()) file.length() else written)
                .put("total", job.total))
        } catch (error: BridgeException) {
            emit(job.id, JSONObject()
                .put("status", "failed")
                .put("code", error.code)
                .put("message", error.message ?: error.code)
                .put("bytes", if (file.exists()) file.length() else written)
                .put("total", job.total))
        } catch (error: Exception) {
            emit(job.id, JSONObject()
                .put("status", "failed")
                .put("code", "EIO")
                .put("message", "${error.javaClass.simpleName}: ${error.message}")
                .put("bytes", if (file.exists()) file.length() else written)
                .put("total", job.total))
        } finally {
            jobs.remove(job.id)
            try {
                job.connection?.disconnect()
            } catch (_: Exception) {
                // 忽略
            }
        }
    }

    fun closeAll() {
        for (job in jobs.values) {
            job.cancelled = true
            try {
                job.connection?.disconnect()
            } catch (_: Exception) {
                // 忽略
            }
        }
        jobs.clear()
        pool.shutdownNow()
    }
}
