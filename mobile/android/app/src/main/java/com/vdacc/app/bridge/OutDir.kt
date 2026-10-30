package com.vdacc.app.bridge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract

/**
 * 输出目录（M4 的 SAF 自选目录）。
 *
 * 默认落 `Download/VDACC`（Android 10+ 走 MediaStore，不需要权限）。用户选了目录之后，
 * 落盘改走 SAF：`DocumentsContract.createDocument` + `openOutputStream`，
 * 需要的是那条 **持久化 URI 授权**（`takePersistableUriPermission`），不是存储权限。
 *
 * 为什么要把选择结果存进 SharedPreferences：授权是持久的，但重装/清理数据会丢；
 * 存下来才能在下次启动时直接用，并在权限被撤销时**如实回退**（见 [Fs.publish]）。
 *
 * 为什么不在 JS 里选目录：`ACTION_OPEN_DOCUMENT_TREE` 必须由 Activity 发起并且有
 * onActivityResult 回来，桥是「同步 post + 异步回投」，中间没有 Activity 的结果回调位置。
 * 所以按钮放在壳上（与「连电脑」同一排），选完直接刷新页面让界面读到新目录。
 */
object OutDir {

    private const val PREF = "vdacc"
    private const val KEY = "outTree"

    @JvmStatic
    fun tree(ctx: Context): Uri? {
        val raw = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY, null) ?: return null
        return try {
            Uri.parse(raw)
        } catch (_: Exception) {
            null
        }
    }

    @JvmStatic
    fun set(ctx: Context, uri: Uri) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putString(KEY, uri.toString()).apply()
    }

    @JvmStatic
    fun clear(ctx: Context) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().remove(KEY).apply()
    }

    /** 用户能看懂的名字：SAF 给的是 `primary:Download/VDACC` 这类 id，取最后一段。 */
    @JvmStatic
    fun label(ctx: Context, uri: Uri): String {
        val id = try {
            DocumentsContract.getTreeDocumentId(uri)
        } catch (_: Exception) {
            return "自选目录"
        }
        val tail = id.substringAfterLast(':').ifBlank { id }
        return tail.substringAfterLast('/').ifBlank { "自选目录" }
    }

    /** 保存授权；失败不致命（本次仍可用，只是重启后可能失效）。 */
    @JvmStatic
    fun persist(ctx: Context, uri: Uri) {
        try {
            ctx.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (error: Exception) {
            android.util.Log.w("VDACC-OutDir", "持久化授权失败：${error.message}")
        }
    }
}
