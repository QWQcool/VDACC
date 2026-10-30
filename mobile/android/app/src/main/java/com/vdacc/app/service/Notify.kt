package com.vdacc.app.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.vdacc.app.MainActivity

/**
 * 「下载完成」通知（M4）。
 *
 * 为什么由 JS 侧驱动而不是 [DownloadService] 自己判断：
 * 音乐与 B站 的流程是「先下到 staging → 补标签/合并 → 再 publish」，真正的完成时刻在 JS 里。
 * 服务只看得见传输层，拿它当完成信号会在补标签期间就报「下载完成」，误导性更强。
 * 所以这里只留一个薄接口：谁的 publish 成功，谁调用 `ui.done`。
 *
 * 为什么单独一个渠道：下载进度（每秒更新、静音、可被系统降权）与「下载完成」
 * 是两类通知，混在一个渠道里用户没法只关掉进度。
 */
object Notify {

    private const val CHANNEL_DONE = "vdacc-done"
    private const val DONE_ID = 2001

    private fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_DONE) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_DONE, "下载完成", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "下载完成后的提醒，点一下回到任务列表"
            },
        )
    }

    /**
     * 发一条「下载完成」。
     *
     * @param name 文件名（用户能对上的东西，不是内部 id）
     * @param path 用户可见位置（MediaStore 的相对路径或自选目录），放进副标题
     */
    fun done(ctx: Context, name: String, path: String) {
        if (name.isBlank()) return
        try {
            ensureChannel(ctx)
            val open = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pending = PendingIntent.getActivity(
                ctx, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                android.app.Notification.Builder(ctx, CHANNEL_DONE)
            } else {
                @Suppress("DEPRECATION")
                android.app.Notification.Builder(ctx)
            }
            // 壳子本来就没有自带图标资源（res 下只有 strings.xml），用系统图标：
            // 通知栏小图标必须是纯白剪影，系统这个正好，且不引入一张只为通知存在的图
            val notification = builder
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("下载完成")
                .setContentText(if (path.isBlank()) name else "$name · $path")
                .setAutoCancel(true)
                .setContentIntent(pending)
                .build()
            (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(DONE_ID, notification)
        } catch (error: Exception) {
            // 通知失败不能影响下载结果本身
            android.util.Log.w("VDACC-Notify", "完成通知发送失败：${error.message}")
        }
    }
}
