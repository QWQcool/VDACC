package com.vdacc.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
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

import com.vdacc.app.bridge.Bridge;
import com.vdacc.app.bridge.OutDir;

/**
 * 两种模式共用一个壳：
 *
 * - **本地引擎（默认）**：加载 `file:///android_asset/ui/m0.html`，解析/下载都在本机跑
 *   （M0 只有自检页；M1 之后是 Vue 界面 + local-api.js）。
 * - **连电脑**：原来的用法，加载 `http://<电脑IP>:8765/?token=...`，界面与下载都在电脑端。
 *
 * 为什么保留局域网模式：它是已经验收过的可用路径（USB 反向代理实测通过），
 * 端上能力没补齐之前不能把它弄丢；两种模式互不干扰，靠右下角按钮切换。
 *
 * 安全上的两条：
 * 1. 只对 `file:///android_asset/` 打开 fileAccess；连电脑时关掉，远程页面不能读本地文件。
 * 2. 桥的 trusted 状态由 onPageStarted 的 URL 前缀决定，非本地页面调用一律拒绝
 *    （Android 的 @JavascriptInterface 没有来源白名单参数，只能自己做）。
 */
public class MainActivity extends Activity {
    /** 产品界面（web/vue 的产物，API 层已换成 ui/local-api.js）。 */
    private static final String LOCAL_APP = "file:///android_asset/ui/app/index.html?token=local";
    /** M0/M1 的验证页：`-e probe xxx` 时加载，脚本化验收用。 */
    private static final String LOCAL_VERIFY = "file:///android_asset/ui/m0.html";
    private static final String DEFAULT_URL = "http://192.168.1.100:8765/";
    private static final String PREF = "vdacc";
    private static final int REQ_STORAGE = 1001;

    private WebView web;
    private EditText address;
    private SharedPreferences prefs;
    private LinearLayout bar;
    private Button addressToggle;
    /**
     * 右下角唯一的悬浮按钮。
     *
     * 原来是「目录」+「连电脑」两个 86×40 的按钮，真机上正好压住档位那一行文字
     * （1080P/720P 的价格被盖掉一半）。收进一个 44×44 的菜单后占地降到四分之一。
     */
    private Button moreToggle;
    private Bridge bridge;

    private boolean localMode = true;
    /** 验收脚本用：`-e probe 1` 跑落盘探针，`-e probe net` 跑网络探针。 */
    private String autoProbe = null;
    /** 系统分享进来的一段文本（B站/抖音的「分享」几乎都是 text/plain），启动后自动解析。 */
    private String sharedText = null;
    private static final int REQ_DIR = 1002;
    private boolean barVisible = true;
    private boolean errorShown = false;
    private String failedUrl = "";

    /** 错误页里的「重试」按钮走这里，避免在错误页上再嵌一层地址栏。 */
    private class ErrorPageBridge {
        @JavascriptInterface
        public void retry() {
            runOnUiThread(MainActivity.this::reloadCurrent);
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREF, MODE_PRIVATE);

        // API 33+ 通知要用户授权：没授权前台服务照样跑，只是通知栏看不到进度。
        // 不阻塞界面，拒绝了也不报错（M1 的验收靠通知栏，所以这里主动要一次）。
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
        }

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
        if (launch != null && !launch.trim().isEmpty()) {
            address.setText(launch.trim());
        }
        // 系统分享（B站/抖音/音乐 App 的「分享」基本都是 text/plain）
        sharedText = extractShare(getIntent());

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

        bridge = new Bridge(this, web);
        web.addJavascriptInterface(bridge, Bridge.NAME);
        web.addJavascriptInterface(new ErrorPageBridge(), "vdacc");
        // 调试期留一个入口：chrome://inspect 可以看到页面控制台（M0 排查用）
        WebView.setWebContentsDebuggingEnabled(true);

        // 页面里的 console.error / 未捕获异常转发到 logcat：
        // 端上出问题时 adb logcat 是唯一能看到 JS 报错的入口（WebView 默认什么都不打）
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                android.util.Log.d("VDACC-Console", message.message()
                        + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!localMode && !errorShown) setBarVisible(false);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 只有主文档失败才换错误页；封面之类的子资源失败不该顶掉整个界面
                if (request == null || !request.isForMainFrame()) return;
                errorShown = true;
                String detail = error == null || error.getDescription() == null
                        ? "" : error.getDescription().toString();
                if (localMode) {
                    view.loadDataWithBaseURL(null, localErrorHtml(detail), "text/html", "utf-8", null);
                    return;
                }
                failedUrl = request.getUrl() != null ? request.getUrl().toString() : address.getText().toString();
                setBarVisible(true);
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
        addressToggle.setOnClickListener(v -> setBarVisible(true));
        FrameLayout.LayoutParams addrLp = new FrameLayout.LayoutParams(dp(64), dp(40),
                Gravity.END | Gravity.BOTTOM);
        addrLp.setMargins(0, 0, dp(10), dp(14));
        root.addView(addressToggle, addrLp);

        moreToggle = new Button(this);
        moreToggle.setText("⋯");
        moreToggle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        moreToggle.setAlpha(0.9f);
        moreToggle.setOnClickListener(this::showMoreMenu);
        FrameLayout.LayoutParams moreLp = new FrameLayout.LayoutParams(dp(44), dp(44),
                Gravity.END | Gravity.BOTTOM);
        moreLp.setMargins(0, 0, dp(10), dp(62));
        root.addView(moreToggle, moreLp);

        setContentView(root);

        // Android 9 及以下写公共 Download 需要「存储」权限（10+ 走 MediaStore，不需要）
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
        }

        // 带 url 启动参数 => 老用法（连电脑）；否则进本地引擎模式
        localMode = launch == null || launch.trim().isEmpty();
        // 验收脚本用：`am start ... -e probe 1` 让页面自动跑一次落盘探针，省掉「滚动 + 手点」
        autoProbe = getIntent() == null ? null : getIntent().getStringExtra("probe");
        applyMode();
    }

    /** 本地页面地址；带 `-e probe 1` 启动时让页面自动跑一次落盘探针（验收脚本用）。 */
    private String localUrl() {
        // 验收脚本（-e probe xxx）走 m0 验证页；正常启动直接进产品界面（token 由 local-api 忽略）
        if (autoProbe != null) {
            return LOCAL_VERIFY + "?probe=" + android.net.Uri.encode(autoProbe);
        }
        // 分享进来的文本拼成 `?url=`：界面自己会读这个参数并自动解析（与桌面端深链同一套）
        if (sharedText != null && !sharedText.trim().isEmpty()) {
            return LOCAL_APP + "&url=" + android.net.Uri.encode(sharedText.trim());
        }
        return LOCAL_APP;
    }

    /**
     * 从 Intent 里取「用户想下载的东西」。
     *
     * 只认 text/plain：分享面板里最常见的形态是「标题 + 链接」的一段文字，
     * 引擎的 `firstUrl` 会自己把链接抽出来。不做 VIEW 的 http/https 接管——
     * 那会让 VDACC 出现在「用什么打开网页」的候选里，是个过重的声明。
     */
    private String extractShare(Intent intent) {
        if (intent == null) return null;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            String type = intent.getType();
            if (type == null || type.startsWith("text/")) {
                String text = intent.getStringExtra(Intent.EXTRA_TEXT);
                if (text != null && !text.trim().isEmpty()) return text;
            }
        }
        return null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTop：App 已经在前台时再分享一次，走这里而不是重建
        setIntent(intent);
        String shared = extractShare(intent);
        if (shared == null) return;
        sharedText = shared;
        localMode = true;
        applyMode();
    }

    /** 选保存目录（SAF）。选完刷新页面，让「保存到」与实际落盘位置一致。 */
    private void pickOutDir() {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(intent, REQ_DIR);
        } catch (Exception error) {
            Toast.makeText(this, "这台设备没有目录选择器：" + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_DIR) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            Toast.makeText(this, "没有选择目录，继续用 Download/VDACC", Toast.LENGTH_SHORT).show();
            return;
        }
        OutDir.persist(this, data.getData());
        OutDir.set(this, data.getData());
        Toast.makeText(this, "保存到：" + OutDir.label(this, data.getData()), Toast.LENGTH_LONG).show();
        if (localMode) {
            errorShown = false;
            web.loadUrl(localUrl());
        } else {
            Toast.makeText(this, "切到「本地引擎」模式后生效", Toast.LENGTH_LONG).show();
        }
    }

    /** 右下角菜单：保存目录 / 恢复默认 / 切换模式（菜单文字每次打开时按当前状态生成）。 */
    private void showMoreMenu(View anchor) {
        android.widget.PopupMenu popup = new android.widget.PopupMenu(this, anchor);
        popup.getMenu().add(0, 1, 0, "选择保存目录");
        popup.getMenu().add(0, 2, 1, "恢复默认目录（Download/VDACC）");
        popup.getMenu().add(0, 3, 2, localMode ? "切换到「连电脑」模式" : "切换到「本地引擎」模式");
        popup.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1:
                    pickOutDir();
                    return true;
                case 2:
                    OutDir.clear(this);
                    Toast.makeText(this, "已恢复默认：Download/VDACC", Toast.LENGTH_LONG).show();
                    if (localMode) {
                        errorShown = false;
                        web.loadUrl(localUrl());
                    }
                    return true;
                case 3:
                    localMode = !localMode;
                    applyMode();
                    return true;
                default:
                    return false;
            }
        });
        popup.show();
    }

    /** 把当前模式刷到界面上：本地模式不显示地址栏（它在那儿没有意义）。 */
    private void applyMode() {
        if (localMode) {
            bar.setVisibility(View.GONE);
            addressToggle.setVisibility(View.GONE);
            // targetSdk >= 30 时 fileAccess 默认关闭，不显式打开会连 asset 页面都加载不了
            web.getSettings().setAllowFileAccess(true);
            errorShown = false;
            web.loadUrl(localUrl());
            return;
        }

        // 远程页面不许读本地文件：同一个 WebView 里切模式时必须显式收回
        web.getSettings().setAllowFileAccess(false);
        setBarVisible(true);
        String url = address.getText().toString().trim();
        if (url.startsWith("http://") || url.startsWith("https://")) load();
    }

    private void setBarVisible(boolean show) {
        if (localMode) {
            bar.setVisibility(View.GONE);
            addressToggle.setVisibility(View.GONE);
            return;
        }
        barVisible = show;
        bar.setVisibility(show ? View.VISIBLE : View.GONE);
        addressToggle.setVisibility(show ? View.GONE : View.VISIBLE);
    }

    private void reloadCurrent() {
        if (localMode) {
            errorShown = false;
            web.loadUrl(localUrl());
            return;
        }
        load();
    }

    private void load() {
        String url = address.getText().toString().trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            Toast.makeText(this, "地址要以 http:// 开头", Toast.LENGTH_SHORT).show();
            return;
        }
        prefs.edit().putString("url", url).apply();
        errorShown = false;
        barVisible = false;
        web.loadUrl(url);
    }

    /** 离线页：说明「任务在电脑上跑」，并给一个真的重试按钮。 */
    private String errorHtml(String detail) {
        String safe = esc(detail);
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

    /** 本地页面加载失败（APK 里没有打包进引擎/页面）：说清楚是安装包的问题，别让人以为是断网。 */
    private String localErrorHtml(String detail) {
        String safe = esc(detail);
        return "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<style>"
                + "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
                + "background:#f6f7fb;color:#171923;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:24px}"
                + ".box{max-width:360px;width:100%;background:#fff;border:1px solid rgba(15,23,42,.08);"
                + "border-radius:14px;padding:24px}"
                + "h1{font-size:17px;margin:0 0 8px}p{font-size:13px;line-height:21px;color:#596174;margin:0 0 6px}"
                + "code{font-size:11px;color:#8b93a7;word-break:break-all}"
                + "button{margin-top:18px;width:100%;height:42px;border:0;border-radius:10px;color:#fff;font-size:14px;"
                + "font-weight:600;background:linear-gradient(180deg,#f062a8,#ec4899)}"
                + "</style></head><body><div class=\"box\">"
                + "<h1>本地引擎页面没加载出来</h1>"
                + "<p>安装包里缺少 <code>assets/ui/m0.html</code> 或 <code>assets/engine/engine.bundle.js</code>。"
                + "先跑 <code>bun mobile/android/engine/build.mjs</code> 再重新构建 APK。</p>"
                + (safe.isEmpty() ? "" : "<p><code>" + safe + "</code></p>")
                + "<button onclick=\"vdacc.retry()\">重试</button>"
                + "</div></body></html>";
    }

    private static String esc(String raw) {
        if (raw == null) return "";
        return raw.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
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

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.close();
        if (web != null) {
            web.removeJavascriptInterface(Bridge.NAME);
            web.destroy();
        }
        super.onDestroy();
    }
}
