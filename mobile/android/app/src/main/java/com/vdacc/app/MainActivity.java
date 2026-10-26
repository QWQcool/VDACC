package com.vdacc.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

/**
 * 极薄的 WebView 壳：连电脑上跑着的 VDACC 服务（--lan 启动），界面与下载都在电脑端。
 * 不引第三方依赖，避免为一个壳子拉进整套 AndroidX。
 *
 * 地址栏只在「连不上」时露出：正常加载完自动收起，右下角留一个「地址」小按钮随时叫回来；
 * 电脑离线时显示自己的错误页（带重试），而不是 Chromium 那句 ERR_xxx。
 */
public class MainActivity extends Activity {
    private static final String DEFAULT_URL = "http://192.168.1.100:8765/";
    private static final String PREF = "vdacc";

    private WebView web;
    private EditText address;
    private SharedPreferences prefs;
    private LinearLayout bar;
    private Button addressToggle;
    private boolean errorShown = false;
    private String failedUrl = "";

    /** 错误页里的「重试」按钮走这里，避免在错误页上再嵌一层地址栏。 */
    private class Bridge {
        @JavascriptInterface
        public void retry() {
            runOnUiThread(MainActivity.this::load);
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREF, MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);

        bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(Color.parseColor("#f6f7fb"));
        int pad = dp(6);
        bar.setPadding(pad, pad, pad, pad);

        address = new EditText(this);
        address.setSingleLine(true);
        address.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        address.setHint("http://电脑IP:8765/?token=...");
        address.setText(prefs.getString("url", DEFAULT_URL));

        // 允许 `adb shell am start ... -e url http://...` 直接带地址（装机联调用，也方便脚本）
        String launch = getIntent() != null ? getIntent().getStringExtra("url") : null;
        if (launch != null && !launch.trim().isEmpty()) address.setText(launch.trim());

        Button connect = new Button(this);
        connect.setText("连接");
        connect.setOnClickListener(v -> load());

        bar.addView(address, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(connect);
        column.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f6f7fb"));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);      // 界面用 localStorage 存 token / 主题 / 开关
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false); // 预览视频不要求再点一次
        web.addJavascriptInterface(new Bridge(), "vdacc");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!errorShown) showBar(false);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 只有主文档失败才换错误页；封面之类的子资源失败不该顶掉整个界面
                if (request == null || !request.isForMainFrame()) return;
                errorShown = true;
                failedUrl = request.getUrl() != null ? request.getUrl().toString() : address.getText().toString();
                showBar(true);
                String detail = error == null || error.getDescription() == null
                        ? "" : error.getDescription().toString();
                view.loadDataWithBaseURL(failedUrl, errorHtml(detail), "text/html", "utf-8", null);
            }
        });

        column.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(column);

        addressToggle = new Button(this);
        addressToggle.setText("地址");
        addressToggle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        addressToggle.setAlpha(0.86f);
        addressToggle.setVisibility(View.GONE);
        addressToggle.setOnClickListener(v -> showBar(true));
        FrameLayout.LayoutParams floatLp = new FrameLayout.LayoutParams(dp(64), dp(40),
                Gravity.END | Gravity.BOTTOM);
        floatLp.setMargins(0, 0, dp(10), dp(14));
        root.addView(addressToggle, floatLp);

        setContentView(root);

        if (!address.getText().toString().trim().isEmpty()) load();
    }

    private void showBar(boolean show) {
        bar.setVisibility(show ? View.VISIBLE : View.GONE);
        addressToggle.setVisibility(show ? View.GONE : View.VISIBLE);
    }

    private void load() {
        String url = address.getText().toString().trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            Toast.makeText(this, "地址要以 http:// 开头", Toast.LENGTH_SHORT).show();
            return;
        }
        prefs.edit().putString("url", url).apply();
        errorShown = false;
        web.loadUrl(url);
    }

    /** 离线页：说明「任务在电脑上跑」，并给一个真的重试按钮。 */
    private String errorHtml(String detail) {
        String safe = detail.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
        return "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<style>"
                + "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
                + "background:#f6f7fb;color:#171923;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:24px}"
                + ".box{max-width:360px;width:100%;background:#fff;border:1px solid rgba(15,23,42,.08);"
                + "border-radius:14px;padding:24px;box-shadow:0 1px 2px rgba(15,23,42,.04)}"
                + ".dot{width:40px;height:40px;border-radius:12px;background:rgba(236,72,153,.11);"
                + "color:#ec4899;display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:14px}"
                + "h1{font-size:17px;margin:0 0 8px}p{font-size:13px;line-height:21px;color:#596174;margin:0 0 6px}"
                + "code{font-size:11px;color:#8b93a7;word-break:break-all}"
                + "button{margin-top:18px;width:100%;height:42px;border:0;border-radius:10px;color:#fff;font-size:14px;"
                + "font-weight:600;background:linear-gradient(180deg,#f062a8,#ec4899)}"
                + "</style></head><body><div class=\"box\">"
                + "<div class=\"dot\">!</div>"
                + "<h1>连不上电脑上的 VDACC</h1>"
                + "<p>请确认电脑端服务仍在运行（<code>VDACC.bat</code> 或 <code>bun ts/src/server.ts --lan</code>），"
                + "且手机与电脑在同一个网络。</p>"
                + (safe.isEmpty() ? "" : "<p><code>" + safe + "</code></p>")
                + "<button onclick=\"vdacc.retry()\">重试</button>"
                + "</div></body></html>";
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
