package com.vdacc.app

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 登录页（M6 后续）：一个**干净的** WebView，加载站点自己的登录页。
 *
 * 为什么不复用 MainActivity 的 WebView：那个 WebView 注入了桥（`VDACC_BRIDGE`），
 * 而桥能读写文件、发任意请求。把远端登录页放进同一个 WebView，等于把桥交给第三方站点。
 * 这里刻意**不注入任何 JavascriptInterface**，登录页只能做浏览器能做的事。
 *
 * cookie 由系统 `CookieManager` 持久化，关掉页面后仍在；点「完成」只是 flush 并回主界面，
 * 真正的「登录成功了吗」由 [com.vdacc.app.bridge.Auth.status] 用接口验一次，不靠页面自己说。
 */
class LoginActivity : Activity() {

    private lateinit var web: WebView

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val url = intent?.getStringExtra("url") ?: "https://www.bilibili.com"
        val site = intent?.getStringExtra("site") ?: ""

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(24, 16, 24, 16)
        }
        val title = TextView(this).apply {
            text = when (site) {
                "bilibili" -> "登录 B站（本页不注入任何桥）"
                "netease" -> "登录网易云（本页不注入任何桥）"
                else -> "登录"
            }
            textSize = 14f
        }
        val done = Button(this).apply {
            text = "完成"
            setOnClickListener { finishAndBack() }
        }
        bar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(done)
        root.addView(bar, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.setSupportMultipleWindows(true)
        web.webViewClient = WebViewClient()
        web.loadUrl(url)
        root.addView(web, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
    }

    /** 回到主界面：先 flush，保证刚拿到的 cookie 立刻落盘（否则进程一退可能丢）。 */
    private fun finishAndBack() {
        try {
            CookieManager.getInstance().flush()
        } catch (_: Exception) {
            // flush 失败不影响已经拿到的 cookie
        }
        finish()
    }

    override fun onBackPressed() {
        if (::web.isInitialized && web.canGoBack()) {
            web.goBack()
            return
        }
        finishAndBack()
    }

    override fun onDestroy() {
        try {
            if (::web.isInitialized) {
                web.removeAllViews()
                web.destroy()
            }
        } catch (_: Exception) {
            // 页面销毁失败无需处理
        }
        super.onDestroy()
    }
}
