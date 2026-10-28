package com.vdacc.app.bridge

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.provider.MediaStore
import org.json.JSONObject
import java.io.File
import java.io.OutputStream

/**
 * 文件能力：**先写私有 staging 的 `.part`，完成后 publish 到 Download/VDACC**。
 *
 * 为什么分两段（而不是直接写公共目录）：
 * 1. MediaStore 条目在 `IS_PENDING=1` 期间对其它 App 不可见，但它不是普通 File，
 *    拿不到随机偏移写；M1 的断点续传必须依赖一个真实可 stat/可 seek 的 `.part`；
 * 2. 失败/取消时只留私有目录里的垃圾，不会在用户「下载」里出现半截文件。
 *
 * 所有方法都由 [Bridge] 的单线程 executor 调用：分块写必须保序，
 * 用线程池并发写同一个文件会静默写坏内容（不是丢一块，是整段错位）。
 */
class Fs(private val ctx: Context, private val paths: Paths) {

    private class Handle(val name: String, val file: File, val out: OutputStream) {
        var bytes: Long = 0
    }

    private val handles = LinkedHashMap<String, Handle>()
    private var seq = 0

    /* ───────────────────────────── 路径校验 ───────────────────────────── */

    /**
     * 只接受**纯文件名**。桥里任何一处接受带分隔符的路径，就等于把整个私有目录
     * （以及将来的 SAF 目录）交给页面，页面又是可被引擎/模板影响的，所以这里从严。
     */
    internal fun safeName(raw: String): String {
        val name = raw.trim()
        if (name.isEmpty()) throw BridgeException("EINVAL", "文件名不能为空")
        if (name == "." || name == ".." || name.contains('/') || name.contains('\\')) {
            throw BridgeException("EINVAL", "文件名不能包含路径分隔符或 ..（收到 \"$raw\"）")
        }
        if (name.length > 120) throw BridgeException("EINVAL", "文件名过长（${name.length} 字符，上限 120）")
        return name
    }

    private fun stagingFile(name: String) = File(paths.staging, "$name.part")

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "txt", "log", "json", "md" -> "text/plain"
        "mp4", "m4v" -> "video/mp4"
        "m4a" -> "audio/mp4"
        "mp3" -> "audio/mpeg"
        "flac" -> "audio/flac"
        "webm" -> "video/webm"
        "mkv" -> "video/x-matroska"
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "srt" -> "application/x-subrip"
        else -> "application/octet-stream"
    }

    /* ───────────────────────────── 分块写入 ───────────────────────────── */

    fun openWrite(nameRaw: String): JSONObject {
        val name = safeName(nameRaw)
        val file = stagingFile(name)
        file.parentFile?.let { if (!it.exists() && !it.mkdirs()) {
            throw BridgeException("EACCES", "无法创建暂存目录 ${it.absolutePath}")
        } }

        // M0 用覆盖写；M1 的续传会改成「按已有大小 seek 后追加」，那时候 truncate 由 resume 参数决定
        val out = try {
            file.outputStream()
        } catch (error: Exception) {
            throw BridgeException("EIO", "打不开暂存文件 ${file.absolutePath}：${error.message}", error)
        }
        seq += 1
        val handle = "h$seq"
        handles[handle] = Handle(name, file, out)
        return JSONObject()
            .put("handle", handle)
            .put("stagingPath", file.absolutePath)
    }

    fun writeChunk(handleId: String, base64: String): JSONObject {
        val handle = handles[handleId] ?: throw BridgeException("EBADHANDLE", "句柄不存在或已关闭：$handleId")
        val bytes = try {
            android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            throw BridgeException("EINVAL", "chunk 不是合法 base64：${error.message}", error)
        }
        return try {
            handle.out.write(bytes)
            handle.out.flush() // 立刻落盘：进程被杀时已写部分仍可用（M1 续传的前提）
            handle.bytes += bytes.size
            JSONObject().put("bytes", bytes.size)
        } catch (error: Exception) {
            throw BridgeException("EIO", "写盘失败：${error.message}", error)
        }
    }

    fun closeWrite(handleId: String): JSONObject {
        val handle = handles.remove(handleId)
            ?: throw BridgeException("EBADHANDLE", "句柄不存在或已关闭：$handleId")
        try {
            handle.out.flush()
            handle.out.close()
        } catch (error: Exception) {
            throw BridgeException("EIO", "关闭文件失败：${error.message}", error)
        }
        return JSONObject()
            .put("bytes", handle.bytes)
            .put("path", handle.file.absolutePath)
            .put("name", handle.name)
    }

    /* ───────────────────────────── publish ───────────────────────────── */

    /**
     * 把 staging 的 `.part` 落到用户可见的 `Download/VDACC`。
     * 成功后删除 `.part`；失败则保留，M1 可以据此重试。
     */
    fun publish(nameRaw: String): JSONObject {
        val name = safeName(nameRaw)
        val source = stagingFile(name)
        if (!source.exists()) throw BridgeException("ENOENT", "暂存文件不存在：${source.absolutePath}")
        val bytes = source.length()

        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            publishViaMediaStore(name, source)
        } else {
            publishViaFile(name, source)
        }
        // 公共目录已经确认写入后才删暂存，顺序不能反
        source.delete()
        return result.put("bytes", bytes)
    }

    private fun publishViaMediaStore(name: String, source: File): JSONObject {
        val resolver = ctx.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val relative = "Download/VDACC/"

        // 同名先删，保证重复跑探针时文件名稳定（MediaStore 默认会给重名加 (1)）
        resolver.query(
            collection,
            arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME}=?",
            arrayOf(relative, name),
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                resolver.delete(ContentUris.withAppendedId(collection, cursor.getLong(0)), null, null)
            }
        }

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(name))
            put(MediaStore.MediaColumns.RELATIVE_PATH, relative)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values)
            ?: throw BridgeException("EIO", "MediaStore 拒绝创建条目（可能是同名冲突或存储不可用）")

        try {
            resolver.openOutputStream(uri)?.use { out ->
                source.inputStream().use { input -> input.copyTo(out, 64 * 1024) }
            } ?: throw BridgeException("EIO", "MediaStore 没有给出可写流")
            // IS_PENDING=0 之后文件才对其它 App 可见（「文件」App 里能看到）
            val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(uri, done, null, null)
        } catch (error: Exception) {
            resolver.delete(uri, null, null) // 失败不留半截条目
            throw if (error is BridgeException) error
            else BridgeException("EIO", "写入 Download/VDACC 失败：${error.message}", error)
        }

        var actual = name
        var size = source.length()
        resolver.query(
            uri,
            arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE),
            null, null, null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                actual = cursor.getString(0) ?: name
                size = cursor.getLong(1)
            }
        }
        return JSONObject()
            .put("path", "Download/VDACC/$actual")
            .put("name", actual)
            .put("outKind", "mediastore")
            .put("size", size)
    }

    @Suppress("DEPRECATION")
    private fun publishViaFile(name: String, source: File): JSONObject {
        val dir = paths.publicDir()
        if (!dir.exists() && !dir.mkdirs()) {
            throw BridgeException(
                "EACCES",
                "无法创建 ${dir.absolutePath}：Android 9 及以下需要「存储」权限，请在系统设置里授予",
            )
        }
        val target = File(dir, name)
        if (target.exists() && !target.delete()) {
            throw BridgeException("EACCES", "无法覆盖已存在的 ${target.absolutePath}")
        }
        try {
            source.inputStream().use { input -> target.outputStream().use { out -> input.copyTo(out, 64 * 1024) } }
        } catch (error: Exception) {
            throw BridgeException("EIO", "写入 ${target.absolutePath} 失败：${error.message}", error)
        }
        // 让「文件」/相册立刻看到它，否则要等下一次全盘扫描
        MediaScannerConnection.scanFile(ctx, arrayOf(target.absolutePath), null, null)
        return JSONObject()
            .put("path", "Download/VDACC/$name")
            .put("name", name)
            .put("outKind", "file")
            .put("size", target.length())
    }

    /* ───────────────────────────── stat / mkdirp ───────────────────────────── */

    fun stat(nameRaw: String): JSONObject {
        val name = safeName(nameRaw)
        val staging = stagingFile(name)
        if (staging.exists()) {
            return JSONObject()
                .put("exists", true)
                .put("size", staging.length())
                .put("path", staging.absolutePath)
                .put("staging", true)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = ctx.contentResolver
            resolver.query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE),
                "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME}=?",
                arrayOf("Download/VDACC/", name),
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    return JSONObject()
                        .put("exists", true)
                        .put("size", cursor.getLong(1))
                        .put("path", "Download/VDACC/${cursor.getString(0) ?: name}")
                        .put("staging", false)
                }
            }
        } else {
            val target = File(paths.publicDir(), name)
            if (target.exists()) {
                return JSONObject()
                    .put("exists", true)
                    .put("size", target.length())
                    .put("path", "Download/VDACC/$name")
                    .put("staging", false)
            }
        }
        return JSONObject().put("exists", false).put("size", 0).put("path", "").put("staging", false)
    }

    /** 暂存区建目录（M1 按标题分子目录时用）；不接受绝对路径。 */
    fun mkdirp(relRaw: String): JSONObject {
        val rel = relRaw.replace('\\', '/').trim('/')
        if (rel.split('/').any { it == ".." }) throw BridgeException("EINVAL", "mkdirp 不接受 ..")
        val dir = if (rel.isEmpty()) paths.staging else File(paths.staging, rel)
        if (!dir.exists() && !dir.mkdirs()) throw BridgeException("EACCES", "无法创建目录 ${dir.absolutePath}")
        return JSONObject().put("path", dir.absolutePath)
    }

    /** 进程退出前把还开着的句柄收干净，避免 .part 停在未 flush 状态。 */
    fun closeAll() {
        for ((_, handle) in handles) {
            try {
                handle.out.flush()
                handle.out.close()
            } catch (_: Exception) {
                // 关闭失败没有补救手段，静默即可（.part 仍在，M1 会按大小续传）
            }
        }
        handles.clear()
    }
}
