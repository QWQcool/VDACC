package com.vdacc.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

/**
 * 极薄的 WebView 壳：连电脑上跑着的 VDACC 服务（--lan 启动），界面与下载都在电脑端。
 * 不引第三方依赖，避免为一个壳子拉进整套 AndroidX。
 */
public class MainActivity extends Activity {
    private static final String DEFAULT_URL = "http://192.168.1.100:8765/";
    private static final String PREF = "vdacc";

    private WebView web;
    private EditText address;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREF, MODE_PRIVATE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);

        address = new EditText(this);
        address.setSingleLine(true);
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

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);      // 界面用 localStorage 存 token / 主题 / 开关
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false); // 预览视频不要求再点一次
        web.setWebViewClient(new WebViewClient());

        root.addView(bar);
        root.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        if (!address.getText().toString().trim().isEmpty()) load();
    }

    private void load() {
        String url = address.getText().toString().trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            Toast.makeText(this, "地址要以 http:// 开头", Toast.LENGTH_SHORT).show();
            return;
        }
        prefs.edit().putString("url", url).apply();
        web.loadUrl(url);
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
