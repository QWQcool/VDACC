package com.vdacc.app.bridge

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.io.RandomAccessFile

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

    companion object {
        /** readHead 的硬上限：见 {@link #readHead} 的说明。 */
        private const val MAX_READ_HEAD = 4 * 1024 * 1024
    }

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

    internal fun stagingFile(name: String) = File(paths.staging, "$name.part")

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

        // 用户选了自选目录就写那儿（SAF）。写失败要**回退**而不是让下载失败：
        // 授权可能被用户在系统设置里撤销、目录可能被删——那时下载其实已经成功了，
        // 报失败会让用户白下一次；回退到 Download/VDACC 并留一条 note 更诚实。
        val tree = OutDir.tree(ctx)
        var note = ""
        if (tree != null) {
            try {
                val saf = publishViaSaf(tree, name, source)
                source.delete()
                return saf.put("bytes", bytes)
            } catch (error: Exception) {
                note = "自选目录写入失败（${error.message ?: "未知原因"}），已回退到 Download/VDACC"
                android.util.Log.w("VDACC-Fs", note)
            }
        }

        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            publishViaMediaStore(name, source)
        } else {
            publishViaFile(name, source)
        }
        // 公共目录已经确认写入后才删暂存，顺序不能反
        source.delete()
        if (note.isNotEmpty()) result.put("note", note)
        return result.put("bytes", bytes)
    }

    /**
     * 写到用户通过 SAF 选的目录。
     *
     * 三步都是 SAF 的硬要求：同名先删（`createDocument` 遇到同名会给 `xxx (1).mp4`，
     * 用户重下同一首会攒一堆）、按 MIME 建文档、写入后再查一次真实大小。
     */
    private fun publishViaSaf(tree: android.net.Uri, name: String, source: File): JSONObject {
        val resolver = ctx.contentResolver
        val treeDocId = DocumentsContract.getTreeDocumentId(tree)
        val treeDoc = DocumentsContract.buildDocumentUriUsingTree(tree, treeDocId)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, treeDocId)

        resolver.query(
            children,
            arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
            null, null, null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(1) == name) {
                    DocumentsContract.deleteDocument(
                        resolver,
                        DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0)),
                    )
                }
            }
        }

        val created = DocumentsContract.createDocument(resolver, treeDoc, mimeOf(name), name)
            ?: throw BridgeException("EIO", "SAF 拒绝创建文档（目录可能只读）")
        try {
            resolver.openOutputStream(created)?.use { out ->
                source.inputStream().use { input -> input.copyTo(out, 64 * 1024) }
            } ?: throw BridgeException("EIO", "SAF 没有给出可写流")
        } catch (error: Exception) {
            try { DocumentsContract.deleteDocument(resolver, created) } catch (_: Exception) { }
            throw if (error is BridgeException) error
            else BridgeException("EIO", "写入自选目录失败：${error.message}", error)
        }

        val size = try {
            resolver.query(
                created, arrayOf(DocumentsContract.Document.COLUMN_SIZE), null, null, null,
            )?.use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else source.length() } ?: source.length()
        } catch (_: Exception) {
            source.length()
        }
        return JSONObject()
            .put("path", "${OutDir.label(ctx, tree)}/$name")
            .put("name", name)
            .put("outKind", "saf")
            .put("size", size)
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

    /* ───────────────────────── 读头 / 重写（M1-e 写标签用） ───────────────────────── */

    /**
     * 读暂存文件开头的若干字节（base64 回投）。
     *
     * 为什么需要：端上没有 ffmpeg，网易云要给 mp3 写 ID3v2、给 flac 写 Vorbis comment，
     * 两者都需要**先看见文件头**——mp3 要知道有没有旧 ID3 标签（否则会在旧标签前面再塞一个，
     * 播放器读到的是旧的那个），flac 要遍历 metadata block 链找到音频帧的起始偏移。
     *
     * 上限 4MB：flac 的块链（含内嵌封面）正常几十 KB，超过这个量说明不是我们认识的形状，
     * 宁可让调用方按「读不全」处理（跳过写标签、保留音频），也不要为极端文件把 JS 堆撑爆。
     */
    fun readHead(nameRaw: String, bytes: Int): JSONObject {
        val name = safeName(nameRaw)
        val file = stagingFile(name)
        if (!file.exists()) throw BridgeException("ENOENT", "暂存文件不存在：${file.absolutePath}")
        val total = file.length()
        val want = minOf(bytes.coerceIn(0, MAX_READ_HEAD).toLong(), total).toInt()
        val buf = ByteArray(want)
        var read = 0
        file.inputStream().use { input ->
            while (read < want) {
                val got = input.read(buf, read, want - read)
                if (got < 0) break
                read += got
            }
        }
        return JSONObject()
            .put("size", total)
            .put("bytes", read)
            .put("base64", android.util.Base64.encodeToString(
                if (read == want) buf else buf.copyOf(read), android.util.Base64.NO_WRAP))
            .put("truncated", total > read)
    }

    /**
     * 用「新前缀 + 原文件 [skip, EOF)」替换暂存文件内容。
     *
     * 为什么是这个形状而不是「改中间某一段」：mp3 的 ID3v2 与 flac 的 metadata 都在**文件开头**，
     * 写标签等价于「换掉开头那一段、后面的音频字节原样保留」。skip 由 JS 侧算出来
     * （mp3 = 旧 ID3 标签长度，flac = 原 metadata 链长度），原生只负责按偏移拷字节。
     *
     * 为什么要临时文件：`RandomAccessFile` 原地重写会在 prefix 比 skip 长的时候覆盖还没读的音频数据；
     * 写临时文件 + 同目录 rename 才能保证**要么是旧文件、要么是完整新文件**，不会留下半截。
     */
    fun rewrite(nameRaw: String, prefixBase64: String, skip: Long): JSONObject {
        val name = safeName(nameRaw)
        val source = stagingFile(name)
        if (!source.exists()) throw BridgeException("ENOENT", "暂存文件不存在：${source.absolutePath}")
        val prefix = try {
            android.util.Base64.decode(prefixBase64, android.util.Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            throw BridgeException("EINVAL", "prefix 不是合法 base64：${error.message}", error)
        }
        val temp = File(source.parentFile, "${source.name}.rewrite")
        try {
            RandomAccessFile(source, "r").use { input ->
                if (skip < 0 || skip > input.length()) {
                    throw BridgeException("EINVAL", "skip=$skip 超出文件大小 ${input.length()}")
                }
                input.seek(skip)
                FileOutputStream(temp).use { out ->
                    out.write(prefix)
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        out.write(buffer, 0, read)
                    }
                    out.flush()
                }
            }
        } catch (error: Exception) {
            temp.delete()
            throw if (error is BridgeException) error
            else BridgeException("EIO", "重写暂存文件失败：${error.message}", error)
        }
        // 同目录 rename 是原子的；先删旧文件再改名，失败时把临时文件清掉，不留两份
        if (!source.delete() || !temp.renameTo(source)) {
            temp.delete()
            throw BridgeException("EIO", "替换暂存文件失败（${source.absolutePath}）")
        }
        return JSONObject()
            .put("bytes", source.length())
            .put("prefixBytes", prefix.size)
            .put("skip", skip)
    }

    /* ───────────────────────── 暂存区内改名（M2 合并/拆轨用） ───────────────────────── */

    /**
     * 暂存区内把 `.part` 改个名字（不解码、不拷贝字节）。
     *
     * 两个用途：
     * 1. 合并成功后 publish 的是 `<name>.mp4`，而两条流下载时叫 `<name>.mp4.video`——
     *    必须在 staging 里改名，否则公共目录里会出现 `xxx.mp4.video` 这种怪文件；
     * 2. 拆轨时把视频轨改名成 `.video.mp4`、音频轨 `.audio.m4a`，MediaStore 才能按扩展名给对 MIME。
     */
    fun rename(fromRaw: String, toRaw: String): JSONObject {
        val from = stagingFile(safeName(fromRaw))
        val toName = safeName(toRaw)
        val to = stagingFile(toName)
        if (!from.exists()) throw BridgeException("ENOENT", "暂存文件不存在：${from.absolutePath}")
        if (to.exists() && !to.delete()) throw BridgeException("EACCES", "无法覆盖 ${to.absolutePath}")
        if (!from.renameTo(to)) throw BridgeException("EIO", "改名失败：${from.name} → ${to.name}")
        return JSONObject().put("name", toName).put("bytes", to.length())
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
