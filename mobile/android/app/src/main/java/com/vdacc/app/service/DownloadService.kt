package com.vdacc.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.vdacc.app.MainActivity
import com.vdacc.app.bridge.Transfer

/**
 * 下载期间的前台服务。
 *
 * 为什么必须有：Android 会把后台进程降级/冻结（Doze、App Standby、后台网络限制），
 * 光靠进程内的传输线程，锁屏半分钟就可能被挂起——设计稿 §8 的
 * 「锁屏 30 秒后回来进度仍在走」在没有前台服务时**无法保证**。
 * 前台服务把进程标成「用户可见的正在干活」，同时允许持续联网。
 *
 * 为什么不把下载放进 Service 里跑：传输线程属于 [Transfer]（桥的一部分），
 * 服务只负责「让系统别杀这个进程」和「把进度显示到通知栏」。
 * 服务不持有下载状态，只**轮询** [Transfer.current]——这样进程被回收后
 * 不会留下一个「以为自己在下载」的服务。
 */
class DownloadService : Service() {

    companion object {
        private const val TAG = "VDACC-Service"
        private const val CHANNEL_ID = "vdacc-download"
        private const val NOTIFICATION_ID = 1001
        private const val TICK_MS = 600L
        /** 连续几个空拍就认为下载结束（给 done→publish 留一点收尾时间）。 */
        private const val IDLE_TICKS_TO_STOP = 3

        fun start(ctx: Context) {
            try {
                val intent = Intent(ctx, DownloadService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(intent)
                } else {
                    ctx.startService(intent)
                }
            } catch (error: Exception) {
                // 前台服务被系统拒绝（例如后台启动限制）不该让下载失败，但要留下痕迹
                Log.w(TAG, "启动前台服务失败：${error.message}")
            }
        }

        fun stop(ctx: Context) {
            try {
                ctx.stopService(Intent(ctx, DownloadService::class.java))
            } catch (_: Exception) {
                // 已经停了
            }
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var idleTicks = 0

    private val tick = object : Runnable {
        override fun run() {
            val snapshot = Transfer.current()
            if (snapshot == null) {
                idleTicks += 1
                if (idleTicks >= IDLE_TICKS_TO_STOP) {
                    stopSelf()
                    return
                }
            } else {
                idleTicks = 0
                notify(snapshot.optString("name"), snapshot.optLong("bytes"), snapshot.optLong("total"))
            }
            handler.postDelayed(this, TICK_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 必须立刻 startForeground：Android 8+ 只给 5 秒窗口，超时会 ANR/崩
        startForeground(NOTIFICATION_ID, build(null, 0, 0))
        handler.removeCallbacks(tick)
        handler.post(tick)
        // 不用 STICKY：进程被杀说明传输也没了，重启一个空服务没有意义
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "下载", NotificationManager.IMPORTANCE_LOW).apply {
                description = "下载进度与结果"
                setShowBadge(false)
                enableVibration(false)
            },
        )
    }

    private fun notify(name: String?, bytes: Long, total: Long) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        try {
            manager.notify(NOTIFICATION_ID, build(name, bytes, total))
        } catch (error: Exception) {
            Log.w(TAG, "更新通知失败：${error.message}")
        }
    }

    private fun build(name: String?, bytes: Long, total: Long): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val text = if (total > 0) {
            "${mb(bytes)} / ${mb(total)}"
        } else {
            mb(bytes)
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setContentTitle(name ?: "准备下载…")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)

        if (total > 0) {
            val percent = ((bytes * 100) / total).toInt().coerceIn(0, 100)
            builder.setProgress(100, percent, false)
        } else {
            builder.setProgress(0, 0, true)
        }
        return builder.build()
    }

    private fun mb(value: Long): String = String.format("%.1f MB", value / 1048576.0)
}
