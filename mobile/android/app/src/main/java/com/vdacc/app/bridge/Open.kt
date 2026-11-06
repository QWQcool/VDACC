package com.vdacc.app.bridge

import android.content.ActivityNotFoundException
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.MediaStore
import org.json.JSONObject

/**
 * 打开 / 预览已下载的成品文件（B3）。
 *
 * 两个必须说清楚的设计点：
 *
 * 1. **Android 没有「在文件夹里选中文件」**。桌面端的 `/api/reveal` 是
 *    `explorer /select,`，手机上没有对应动作，所以这里把语义定成「用系统默认应用打开这个文件」，
 *    并让返回体如实带上 `opened` / `mime`——界面不会误以为它打开的是目录。
 * 2. **页面不能自己拼路径**。WebView 页面是 `file:///android_asset/`，
 *    既读不到 `/sdcard/Download/VDACC`（分区存储），也不该拿到私有暂存目录。
 *    所以这里只做一件事：按文件名把公共条目找出来，换成 `content://` 交给页面或系统。
 *
 * 查找顺序：`content://` 直接用 → MediaStore 下载库（默认目录）→ SAF 自选目录。
 * 三者都找不到时抛 `not_found`，不返回一个「看起来能播」的假地址。
 */
class Open(private val ctx: Context) {

    private fun fileNameOf(path: String): String {
        val clean = path.substringBefore('?').trim()
        return clean.substringAfterLast('/').substringAfterLast('\\')
    }

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "mp4", "m4v", "mkv", "webm", "mov", "ts" -> "video/*"
        "mp3", "flac", "m4a", "aac", "wav", "ogg", "opus" -> "audio/*"
        else -> "*/*"
    }

    /** 文件名 → `content://`。同名多条时取最新插入的那条（重复下载会覆盖同名条目）。 */
    private fun find(path: String): Uri? {
        val raw = path.trim()
        if (raw.startsWith("content://")) return Uri.parse(raw)
        val name = fileNameOf(raw)
        if (name.isEmpty()) return null

        val resolver = ctx.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        resolver.query(
            collection,
            arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.DISPLAY_NAME}=?",
            arrayOf(name),
            "${MediaStore.MediaColumns._ID} DESC",
        )?.use { cursor ->
            if (cursor.moveToFirst()) return ContentUris.withAppendedId(collection, cursor.getLong(0))
        }

        val tree = OutDir.tree(ctx) ?: return null
        val treeDocId = DocumentsContract.getTreeDocumentId(tree)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, treeDocId)
        resolver.query(
            children,
            arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
            null, null, null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(1) == name) {
                    return DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0))
                }
            }
        }
        return null
    }

    /** 预览：只把地址给页面（`<video src>` 用），不启动任何界面。 */
    fun preview(path: String): JSONObject {
        val uri = find(path)
            ?: throw BridgeException("not_found", "找不到这个文件（可能已被移动或删除）：$path")
        return JSONObject()
            .put("url", uri.toString())
            .put("mime", mimeOf(fileNameOf(path)))
    }

    /** 打开：交给系统默认应用。没有能处理该类型的应用时如实报 unsupported。 */
    fun reveal(path: String): JSONObject {
        val uri = find(path)
            ?: throw BridgeException("not_found", "找不到这个文件（可能已被移动或删除）：$path")
        val mime = mimeOf(fileNameOf(path))
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            ctx.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            throw BridgeException("unsupported", "系统里没有能打开 $mime 的应用")
        }
        return JSONObject().put("opened", true).put("uri", uri.toString()).put("mime", mime)
    }
}
