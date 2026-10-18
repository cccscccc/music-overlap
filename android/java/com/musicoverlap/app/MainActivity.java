package com.musicoverlap.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 极简安卓壳：把手机浏览器换成 App 的样子，页面本身还是电脑上那个服务在发。
 *
 * 为什么不把 Node 也打进包里：播放要带 Referer，而 WebView 里的 JS 设不了这个头，
 * 必须由电脑那边的服务代发。把 Node 塞进来能做（60MB+），但那是另一个工程。
 *
 * 所以这个 App 干的事只有一件：找到你电脑上那个服务（扫一遍局域网 8787 端口），
 * 然后把它当网页打开。找不到就让你手填地址。
 */
public class MainActivity extends Activity {
    private static final int PORT = 8787;
    private static final String PREFS = "music_overlap";
    private static final String KEY_LAST = "last_base";

    private static final int BG = Color.parseColor("#0e0f15");
    private static final int INK = Color.parseColor("#e8ebf2");
    private static final int DIM = Color.parseColor("#9aa0ae");
    private static final int AMBER = Color.parseColor("#ffb648");

    private final Handler ui = new Handler(Looper.getMainLooper());
    /* 64 条并发：254 个地址 × 约 1.2s 超时，24 条要十几秒，64 条约 5 秒 */
    private final ExecutorService pool = Executors.newFixedThreadPool(64);

    private FrameLayout root;
    private WebView web;
    private LinearLayout panel;
    private TextView status;
    private EditText manual;
    private SharedPreferences prefs;
    private String current = null;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        Window w = getWindow();
        w.setStatusBarColor(BG);
        w.setNavigationBarColor(BG);
        buildUi();
        start(prefs.getString(KEY_LAST, null), "正在寻找电脑上的服务…");
    }

    /* ────────────────────────── 界面 ────────────────────────── */

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.setVisibility(View.GONE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // 对比完自动起播
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " MusicOverlapApp/0.1");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                // 站内链接留在 WebView，外链交给系统浏览器
                if (url != null && current != null && url.startsWith(current)) return false;
                try {
                    startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse(url)));
                } catch (Exception ignore) { /* 没有浏览器就算了 */ }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                // 页面主文档加载失败时退回到「找服务」界面，而不是留一张白屏
                if (failingUrl != null && current != null
                        && failingUrl.startsWith(current) && v.getUrl() != null
                        && v.getUrl().equals(failingUrl)) {
                    start(current, "连不上了，重新找一下…");
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                showPanel(current == null ? "" : current, "长按可以换一个地址");
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_VERTICAL);
        panel.setPadding(dp(26), dp(40), dp(26), dp(40));

        TextView title = new TextView(this);
        title.setText("音乐重合度");
        title.setTextColor(AMBER);
        title.setTextSize(26);
        title.setGravity(Gravity.START);
        panel.addView(title, lp(0, dp(8)));

        TextView sub = new TextView(this);
        sub.setText("手机上的页面来自你电脑上跑着的那个服务");
        sub.setTextColor(DIM);
        sub.setTextSize(13);
        panel.addView(sub, lp(0, dp(18)));

        status = new TextView(this);
        status.setTextColor(INK);
        status.setTextSize(14);
        status.setLineSpacing(dp(4), 1f);
        panel.addView(status, lp(0, dp(22)));

        manual = new EditText(this);
        manual.setHint("也可以手填：http://192.168.5.12:8787");
        manual.setHintTextColor(Color.parseColor("#5b6070"));
        manual.setTextColor(INK);
        manual.setTextSize(15);
        manual.setSingleLine(true);
        manual.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        panel.addView(manual, lp(0, dp(14)));

        Button go = new Button(this);
        go.setText("连接这个地址");
        go.setAllCaps(false);
        go.setTextColor(Color.parseColor("#171207"));
        go.setBackgroundColor(AMBER);
        go.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String typed = manual.getText().toString().trim();
                if (typed.length() == 0) return;
                start(normalize(typed), "正在连接 " + normalize(typed) + " …");
            }
        });
        panel.addView(go, lp(0, dp(10)));

        Button again = new Button(this);
        again.setText("重新搜索");
        again.setAllCaps(false);
        again.setTextColor(INK);
        again.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                start(null, "正在搜索局域网…");
            }
        });
        panel.addView(again, lp(0, dp(6)));

        root.addView(panel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private LinearLayout.LayoutParams lp(int top, int bottom) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = top;
        p.bottomMargin = bottom;
        return p;
    }

    private void showPanel(String hint, String message) {
        web.setVisibility(View.GONE);
        panel.setVisibility(View.VISIBLE);
        status.setText(message);
        if (hint != null && hint.length() > 0) manual.setText(hint);
    }

    private void showWeb(String base) {
        panel.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(base + "/");
    }

    /* ────────────────────────── 连接与发现 ────────────────────────── */

    /** 手输/上次的地址 → 规范成 http://host:port */
    private static String normalize(String raw) {
        String s = raw.trim();
        if (s.length() == 0) return null;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        // 没写端口就补上
        String rest = s.substring(s.indexOf("://") + 3);
        if (rest.indexOf(':') < 0) s = s + ":" + PORT;
        return s;
    }

    private void start(final String hint, final String message) {
        showPanel(hint, message);
        final String last = prefs.getString(KEY_LAST, null);
        pool.execute(new Runnable() {
            @Override public void run() {
                String found = null;
                if (hint != null && isUp(hint)) found = hint;
                if (found == null && last != null && isUp(last)) found = last;
                if (found == null) found = scan();
                final String f = found;
                ui.post(new Runnable() {
                    @Override public void run() { onFound(f); }
                });
            }
        });
    }

    private void onFound(String base) {
        if (base == null) {
            showPanel(current == null ? "" : current,
                    "没找到。确认：\n① 电脑上开着「手机访问.bat」\n② 手机连的是同一个 WiFi\n"
                            + "③ 电脑和手机在同一个网段\n\n也可以把电脑地址填在下面。");
            return;
        }
        current = base;
        prefs.edit().putString(KEY_LAST, base).apply();
        showWeb(base);
    }

    /** GET /api/health，看是不是这个工具在应答 */
    private boolean isUp(String base) {
        if (base == null) return false;
        HttpURLConnection c = null;
        try {
            URL u = new URL(base + "/api/health");
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(900);
            c.setReadTimeout(1200);
            c.setRequestMethod("GET");
            if (c.getResponseCode() != 200) return false;
            InputStream in = c.getInputStream();
            byte[] buf = new byte[512];
            int n = in.read(buf);
            in.close();
            if (n <= 0) return false;
            String body = new String(buf, 0, n, "UTF-8");
            return body.contains("\"ok\":true");
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 扫本机的 /24 网段：并行试 1..254，谁答话就用谁 */
    private String scan() {
        List<String> prefixes = new ArrayList<String>();
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                if (ni.isLoopback() || !ni.isUp()) continue;
                Enumeration<InetAddress> as = ni.getInetAddresses();
                while (as.hasMoreElements()) {
                    InetAddress a = as.nextElement();
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    String ip = a.getHostAddress();
                    if (ip == null || ip.startsWith("169.254.")) continue;
                    int dot = ip.lastIndexOf('.');
                    if (dot > 0) {
                        String p = ip.substring(0, dot + 1);
                        if (!prefixes.contains(p) && !p.startsWith("127.")) prefixes.add(p);
                    }
                }
            }
        } catch (Exception ignore) { /* 拿不到网卡就只试回环 */ }

        if (prefixes.isEmpty()) return null;

        final String[] hit = new String[1];
        for (final String p : prefixes) {
            if (hit[0] != null) break;
            final CountDownLatch latch = new CountDownLatch(254);
            for (int i = 1; i <= 254; i++) {
                final String base = "http://" + p + i + ":" + PORT;
                pool.execute(new Runnable() {
                    @Override public void run() {
                        try {
                            if (hit[0] == null && isUp(base)) hit[0] = base;
                        } finally {
                            latch.countDown();
                        }
                    }
                });
            }
            try { latch.await(12, TimeUnit.SECONDS); } catch (InterruptedException ignore) { }
        }
        return hit[0];
    }

    /* ────────────────────────── 生命周期 ────────────────────────── */

    @Override
    public void onBackPressed() {
        if (web.getVisibility() == View.VISIBLE && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        try { pool.shutdownNow(); } catch (Exception ignore) { }
        if (web != null) {
            try {
                web.stopLoading();
                web.destroy();
            } catch (Exception ignore) { }
        }
        super.onDestroy();
    }
}
