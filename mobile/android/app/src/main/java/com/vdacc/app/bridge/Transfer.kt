package com.vdacc.app.bridge

import android.content.Context
import android.os.PowerManager
import com.vdacc.app.service.DownloadService
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
        private const val WAKE_TIMEOUT_MS = 30 * 60 * 1000L

        /**
         * 当前下载的快照，给 [DownloadService] 轮询用。
         * 为什么是静态快照而不是回调：服务与传输线程的生命周期互相独立，
         * 静态值只读不写，进程被回收也不会留下「服务以为在下载」的假象。
         */
        @Volatile
        private var active: JSONObject? = null

        fun current(): JSONObject? = active
    }

    private class Job(
        val id: String,
        val name: String,
        val url: String,
        val referer: String,
        val userAgent: String,
        /** 字节/秒，0 = 不限速。设计稿 §9：限速从 JS 的 throttle 移到原生读速。 */
        val limitBytesPerSec: Long,
        /**
         * 下载完成后是否直接 publish 到 Download/VDACC。
         *
         * false 时停在 staging 的 `.part` 并把绝对路径回投，由上层补完再 publish——
         * 网易云要写 ID3/Vorbis 标签与封面（端上没有 ffmpeg，只能在文件落公共目录前改），
         * M2 的 B站 音视频合并同理。默认 true，保持既有调用方行为不变。
         */
        val publishOnDone: Boolean,
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

    /** 按已写字节发 Range；`from = 0` 时就是普通 GET。 */
    private fun open(job: Job, from: Long): HttpURLConnection =
        (URL(job.url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            instanceFollowRedirects = true
            connectTimeout = 20_000
            readTimeout = 30_000
            setRequestProperty("User-Agent", job.userAgent)
            if (job.referer.isNotEmpty()) setRequestProperty("Referer", job.referer)
            // 登录态由原生补（与 http.request 同一规则）；CDN 域名不会命中
            val cookie = Auth.headerFor(job.url)
            if (cookie.isNotEmpty()) setRequestProperty("Cookie", cookie)
            if (from > 0) setRequestProperty("Range", "bytes=$from-")
        }

    /**
     * HEAD 拿远端大小，只用于判定 416 的两种成因。
     *
     * 拿不到（HEAD 被拒/无 content-length）返回 0，调用方按「远端变了」处理——从 0 重来。
     * 宁可多重下一遍，也不要把一个可能过期的 `.part` 当成成品 publish 出去。
     */
    private fun remoteSize(job: Job): Long {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(job.url).openConnection() as HttpURLConnection).apply {
                requestMethod = "HEAD"
                instanceFollowRedirects = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("User-Agent", job.userAgent)
                if (job.referer.isNotEmpty()) setRequestProperty("Referer", job.referer)
            }
            conn.responseCode
            conn.contentLengthLong.takeIf { it > 0 } ?: 0L
        } catch (_: Exception) {
            0L
        } finally {
            try { conn?.disconnect() } catch (_: Exception) { }
        }
    }

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

        val limit = payload.optLong("limitBytesPerSec", 0L).coerceAtLeast(0L)
        // 缺省 true：老调用方（抖音/M0 探针）不需要知道这个参数
        val publishOnDone = payload.optBoolean("publish", true)

        val job = synchronized(this) {
            seq += 1
            Job("t$seq", name, url, referer, userAgent, limit, publishOnDone)
        }
        jobs[job.id] = job
        val resumeFrom = stagingFile(name).length()

        // 前台服务 + 唤醒锁：锁屏后系统会冻结后台进程并限制网络，
        // 没有这两样「锁屏 30 秒进度仍在走」就是空话
        acquireWake()
        DownloadService.start(ctx)

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

            var conn = open(job, written)
            job.connection = conn

            var status = conn.responseCode
            // 416 = Range 起点已在文件末尾之外。两个真实成因：
            // 1) 上次正好把整条流写完（被杀在 publish 之前）——`.part` 就是完整文件，直接算完成；
            // 2) 远端内容变短了——从 0 重来。
            // 不判这个的话，「下满但没来得及 publish」的任务每次重开都会永远失败在 416（真机踩到）。
            var alreadyComplete = false
            if (status == 416 && written > 0) {
                val remote = remoteSize(job)
                if (remote > 0 && remote == written) {
                    alreadyComplete = true
                    job.total = remote
                } else {
                    written = 0L
                    try { conn.disconnect() } catch (_: Exception) { }
                    try { file.delete() } catch (_: Exception) { }
                    conn = open(job, 0)
                    job.connection = conn
                    status = conn.responseCode
                    if (status !in 200..299) throw BridgeException("http_$status", "下载失败 HTTP $status")
                }
            }
            // alreadyComplete 时 status 仍是 416：那正是「已经下完」的信号，不能当错误抛
            if (!alreadyComplete && status !in 200..299) {
                throw BridgeException("http_$status", "下载失败 HTTP $status")
            }

            val resumed = status == 206 && written > 0
            if (!resumed && !alreadyComplete) written = 0L // 服务端不认 Range：从 0 重写，别接在旧内容后面
            val length = conn.contentLengthLong
            job.total = if (alreadyComplete) written
            else if (length > 0) length + (if (resumed) written else 0L) else 0L
            job.bytes = written

            publishState(job, written, job.total)
            emit(job.id, JSONObject()
                .put("status", "start")
                .put("bytes", written)
                .put("total", job.total)
                .put("resumeFrom", if (resumed || alreadyComplete) written else 0L))

            // 已经完整（416 且远端大小与 `.part` 相同）就不用再读一遍
            if (!alreadyComplete) {
                FileOutputStream(file, resumed).use { out ->
                    conn.inputStream.use { input ->
                        val buffer = ByteArray(BUFFER)
                        var lastEmit = 0L
                        var runBytes = 0L
                        val pacingStart = System.currentTimeMillis()
                        while (true) {
                            if (job.cancelled) throw Cancelled()
                            val read = input.read(buffer)
                            if (read < 0) break
                            out.write(buffer, 0, read)
                            written += read
                            runBytes += read
                            job.bytes = written
                            if (job.limitBytesPerSec > 0) {
                                // 按「本次已读字节 / 限速」算出应到的时刻，超前的部分睡回去
                                val due = pacingStart + runBytes * 1000L / job.limitBytesPerSec
                                val waitMs = due - System.currentTimeMillis()
                                if (waitMs > 0) Thread.sleep(minOf(waitMs, 400L))
                            }
                            val now = System.currentTimeMillis()
                            if (now - lastEmit >= PROGRESS_GAP_MS) {
                                lastEmit = now
                                publishState(job, written, job.total)
                                emit(job.id, JSONObject()
                                    .put("status", "progress")
                                    .put("bytes", written)
                                    .put("total", job.total))
                            }
                        }
                    }
                    out.flush()
                }
            }

            if (job.cancelled) throw Cancelled()

            if (!job.publishOnDone) {
                // 停在 staging：上层补标签/合并后再自己 publish，失败时这里什么都不删（可续传）
                emit(job.id, JSONObject()
                    .put("status", "done")
                    .put("bytes", file.length())
                    .put("path", file.absolutePath)
                    .put("name", job.name)
                    .put("outKind", "staging")
                    .put("staged", true))
                return
            }

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
            if (jobs.isEmpty()) {
                active = null
                releaseWake()
                DownloadService.stop(ctx)
            }
        }
    }

    /* ───────────────────────── 前台服务 / 唤醒锁 ───────────────────────── */

    private var wakeLock: PowerManager.WakeLock? = null

    private fun acquireWake() {
        if (wakeLock?.isHeld == true) return
        try {
            val power = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vdacc:transfer").apply {
                setReferenceCounted(false)
                acquire(WAKE_TIMEOUT_MS)
            }
        } catch (error: Exception) {
            // 拿不到锁不致命：前台服务仍然生效，只是锁屏时可能被降频
            android.util.Log.w("VDACC-Transfer", "获取唤醒锁失败：${error.message}")
        }
    }

    private fun releaseWake() {
        try {
            wakeLock?.takeIf { it.isHeld }?.release()
        } catch (_: Exception) {
            // 忽略
        }
        wakeLock = null
    }

    /** 更新给服务轮询的快照（字节数/总量/文件名）。 */
    private fun publishState(job: Job, bytes: Long, total: Long) {
        active = JSONObject()
            .put("jobId", job.id)
            .put("name", job.name)
            .put("bytes", bytes)
            .put("total", total)
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
