package com.vdacc.app.bridge

import android.content.Context
import android.os.Build
import android.os.Environment
import java.io.File

/**
 * 端上「目录」的三个身份，必须分开讲清楚，混在一起就会写出「看起来成功了其实在私有目录」的假象。
 *
 * - staging：`Android/data/com.vdacc.app/files/staging`。真实 File，可写、可 stat、可续传。
 *   M1 的 `.part` 断点续传只能落在这里——MediaStore 里的条目没法按偏移续写。
 * - out：用户在系统「文件」里看到的 `Download/VDACC`。
 *   Android 10+ 不允许直接 File 写公共目录，必须经 MediaStore；所以这里只是**展示名**，
 *   不是一定能 open() 的路径。
 * - cache：`cacheDir`，临时解压/封面缩放用，系统可随时清理。
 */
class Paths(private val ctx: Context) {

    /** 私有暂存目录。getExternalFilesDir 在部分机型可能为 null（外部存储未挂载），退回内部存储。 */
    val staging: File
        get() {
            val base = ctx.getExternalFilesDir(null) ?: ctx.filesDir
            return File(base, "staging").also { if (!it.exists()) it.mkdirs() }
        }

    val cache: File
        get() = ctx.cacheDir

    /** 给用户看的相对路径，与桌面端 `下载/` 语义对齐（只是名字，不能拿去 File 打开）。 */
    val outDisplay: String = "Download/VDACC"

    /** mediastore（API 29+）/ file（26–28，需要 WRITE_EXTERNAL_STORAGE）。 */
    val outKind: String
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) "mediastore" else "file"

    /** 仅 API 26–28 有意义；29+ 用 MediaStore，不再碰这个目录。 */
    @Suppress("DEPRECATION")
    fun publicDir(): File =
        File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "VDACC")
}
