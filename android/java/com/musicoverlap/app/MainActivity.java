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
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;
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
    /* 自带引擎起不来时，把真实原因留在屏幕上——「没找到」四个字没法用来修 bug */
    private TextView diag;
    private Button retry;
    private ProgressBar prepBar;
    private TextView prepNote;
    private long prepTotal = 0;
    private long prepDone = 0;
    private int prepShown = -1;
    private EditText manual;
    private SharedPreferences prefs;
    private String current = null;
    private Process nodeProc = null;
    /** 自带引擎的 stdout/stderr。起不来的时候，这几行是唯一能看懂原因的东西 */
    private final StringBuilder engineLog = new StringBuilder();

    /** 本地自带的那台 Node（如果这个包塞了它）*/
    private static final String LOCAL_BASE = "http://127.0.0.1:" + PORT;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        Window w = getWindow();
        w.setStatusBarColor(BG);
        w.setNavigationBarColor(BG);
        buildUi();
        boot();
    }

    /* ── 启动顺序：先试包里自带的引擎（真独立），不行再退回「连电脑」 ── */
    private void boot() {
        showPanel(null, "正在启动…（第一次会解压运行环境，稍等几秒）");
        if (retry != null) retry.setVisibility(View.GONE);
        pool.execute(new Runnable() {
            @Override public void run() {
                boolean local = false;
                StringBuilder why = new StringBuilder();
                try {
                    extractAssets();
                } catch (Throwable t) {
                    why.append("解压运行环境失败：").append(t).append('\n');
                }
                if (why.length() == 0) {
                    for (int attempt = 1; attempt <= 2 && !local; attempt++) {
                        try {
                            local = startNode();
                        } catch (Throwable t) {
                            why.append("第 ").append(attempt).append(" 次启动引擎出错：").append(t).append('\n');
                        }
                        if (!local) {
                            stopNode();
                            try { Thread.sleep(600); } catch (InterruptedException ignore) { }
                        }
                    }
                    if (!local) {
                        // 解压半截最容易造成「戳记在、文件不在」：把戳记清掉，下次重铺一遍
                        new File(getFilesDir(), ".prepared").delete();
                    }
                }
                final boolean ok = local;
                final String detail = why.toString().trim();
                ui.post(new Runnable() {
                    @Override public void run() {
                        if (ok) {
                            showWeb(LOCAL_BASE);
                            return;
                        }
                        synchronized (engineLog) {
                            String all = engineLog.toString().trim();
                            if (all.length() > 0) {
                                String[] lines = all.split("\n");
                                StringBuilder tail = new StringBuilder();
                                for (int i = Math.max(0, lines.length - 10); i < lines.length; i++) {
                                    tail.append(lines[i]).append('\n');
                                }
                                if (detail.length() > 0) why.append('\n');
                                why.append(tail.toString().trim());
                            }
                        }
                        if (diag != null) {
                            String text = why.toString().trim();
                            if (text.length() > 0) {
                                diag.setText(text);
                                diag.setVisibility(View.VISIBLE);
                            } else {
                                diag.setText("（引擎没有输出，也没有抛异常）");
                                diag.setVisibility(View.VISIBLE);
                            }
                        }
                        if (retry != null) retry.setVisibility(View.VISIBLE);
                        start(prefs.getString(KEY_LAST, null), "自带引擎没起来，退回到「连电脑」模式…");
                    }
                });
            }
        });
    }

    /** 把 assets/app/** 铺到 filesDir/app/**，assets/libs/** 铺到 filesDir/libs/**
     *  只在包版本变化后铺一次：vendor 里有 88MB 的运行时，每次启动都拷一遍会明显卡。 */
    private static final String PREP_VERSION = "1";

    private void extractAssets() throws Exception {
        File stamp = new File(getFilesDir(), ".prepared");
        String want = PREP_VERSION + ":" + getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        if (stamp.exists() && extractedOk()) {
            try {
                java.io.BufferedReader br = new java.io.BufferedReader(
                        new java.io.InputStreamReader(new java.io.FileInputStream(stamp), "UTF-8"));
                String have = br.readLine();
                br.close();
                if (want.equals(have)) return;
            } catch (Exception ignore) { }
        }
        // 先量总量，再拷 —— 进度条才有意义（大约 88MB）
        prepTotal = 0;
        prepDone = 0;
        try { measureAssetTree("app"); } catch (Exception ignore) { }
        try { measureAssetTree("libs"); } catch (Exception ignore) { }
        ui.post(new Runnable() {
            @Override public void run() {
                if (prepBar != null) prepBar.setVisibility(prepTotal > 0 ? View.VISIBLE : View.GONE);
                if (prepNote != null) prepNote.setVisibility(prepTotal > 0 ? View.VISIBLE : View.GONE);
            }
        });
        copyAssetTree("app", new File(getFilesDir(), "app"));
        try {
            copyAssetTree("libs", new File(getFilesDir(), "libs"));
        } catch (Exception ignore) {
            // 包里没塞 libs（就是「连电脑」版），不是错误
        }
        new File(getFilesDir(), "tmp").mkdirs();
        java.io.FileOutputStream fo = new java.io.FileOutputStream(stamp);
        fo.write((want + "\n").getBytes("UTF-8"));
        fo.close();
        ui.post(new Runnable() {
            @Override public void run() {
                if (prepBar != null) prepBar.setVisibility(View.GONE);
                if (prepNote != null) prepNote.setVisibility(View.GONE);
            }
        });
    }

    /** 戳记只是「上次铺完了」的记录。文件被系统清掉/上次铺到一半就退出时，戳记可能是假的，
     *  所以真开工前再确认几个关键文件都在。 */
    private boolean extractedOk() {
        File script = new File(getFilesDir(), "app/server.mjs");
        File pub = new File(getFilesDir(), "app/public/index.html");
        File exe = new File(getApplicationInfo().nativeLibraryDir, "libnode.so");
        File libs = new File(getFilesDir(), "libs");
        String[] names = libs.list();
        return script.exists() && pub.exists() && exe.exists() && names != null && names.length >= 5;
    }

    /** 递归把这棵资源树里的字节数加起来（打开即知大小，不读内容） */
    private void measureAssetTree(String assetPath) throws Exception {
        String[] list = getAssets().list(assetPath);
        if (list == null || list.length == 0) {
            InputStream in = getAssets().open(assetPath);
            prepTotal += in.available();
            in.close();
            return;
        }
        for (String name : list) measureAssetTree(assetPath + "/" + name);
    }

    /** 拷贝进度：只在百分比变化时刷 UI，别每 16KB 都 post 一次 */
    private void bumpProgress(long n) {
        prepDone += n;
        if (prepTotal <= 0) return;
        final int pct = (int) Math.min(100, prepDone * 100 / prepTotal);
        if (pct == prepShown) return;
        prepShown = pct;
        final long doneMb = prepDone / (1024 * 1024);
        final long totalMb = prepTotal / (1024 * 1024);
        ui.post(new Runnable() {
            @Override public void run() {
                if (prepBar != null) prepBar.setProgress(pct);
                if (prepNote != null) {
                    prepNote.setText("正在准备运行环境 " + pct + "%（" + doneMb + " / " + totalMb + " MB）");
                }
                if (pct < 100) status.setText("第一次启动要解压运行环境，大约十几秒…");
                else status.setText("运行环境就绪，正在启动引擎…");
            }
        });
    }

    private void copyAssetTree(String assetPath, File destDir) throws Exception {
        String[] list = getAssets().list(assetPath);
        if (list == null || list.length == 0) {
            // 叶子：是文件
            destDir.getParentFile().mkdirs();
            InputStream in = getAssets().open(assetPath);
            FileOutputStream out = new FileOutputStream(destDir);
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); bumpProgress(n); }
            in.close();
            out.close();
            return;
        }
        destDir.mkdirs();
        for (String name : list) copyAssetTree(assetPath + "/" + name, new File(destDir, name));
    }

    /** 起包里的 node（libnode.so），等它把 /api/health 答上来 */
    private boolean startNode() throws Exception {
        String libDir = getApplicationInfo().nativeLibraryDir;
        File exe = new File(libDir, "libnode.so");
        File script = new File(getFilesDir(), "app/server.mjs");
        if (!exe.exists() || !script.exists()) return false;

        ProcessBuilder pb = new ProcessBuilder(exe.getAbsolutePath(), script.getAbsolutePath(),
                String.valueOf(PORT));
        pb.directory(new File(getFilesDir(), "app"));
        pb.redirectErrorStream(true);
        pb.environment().put("LD_LIBRARY_PATH", libDir + ":" + new File(getFilesDir(), "libs").getAbsolutePath());
        pb.environment().put("HOME", getFilesDir().getAbsolutePath());
        pb.environment().put("TMPDIR", new File(getFilesDir(), "tmp").getAbsolutePath());
        nodeProc = pb.start();

        // 把引擎输出收集起来：万一它在真机上起不来，用户截图就能告诉我缺什么
        final Process proc = nodeProc;
        Thread reader = new Thread(new Runnable() {
            @Override public void run() {
                try {
                    java.io.BufferedReader br = new java.io.BufferedReader(
                            new java.io.InputStreamReader(proc.getInputStream(), "UTF-8"));
                    String line;
                    while ((line = br.readLine()) != null) {
                        synchronized (engineLog) {
                            engineLog.append(line).append('\n');
                            if (engineLog.length() > 4000) engineLog.delete(0, engineLog.length() - 4000);
                        }
                    }
                } catch (Exception ignore) { }
            }
        });
        reader.setDaemon(true);
        reader.start();

        for (int i = 0; i < 60; i++) {          // 最多等 30 秒：真机上第一次启动 + WebView 抢 CPU，20 秒偶尔不够
            if (isUp(LOCAL_BASE)) return true;
            if (nodeProc != null) {
                try {
                    int code = nodeProc.exitValue();
                    return false;                // 进程已经退了，别白等
                } catch (IllegalThreadStateException alive) { /* 还活着 */ }
            }
            Thread.sleep(500);
        }
        return isUp(LOCAL_BASE);
    }

    private void stopNode() {
        if (nodeProc != null) {
            try { nodeProc.destroy(); } catch (Exception ignore) { }
            nodeProc = null;
        }
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
        sub.setText("自带运行环境，不依赖电脑");
        sub.setTextColor(DIM);
        sub.setTextSize(13);
        panel.addView(sub, lp(0, dp(18)));

        status = new TextView(this);
        status.setTextColor(INK);
        status.setTextSize(14);
        status.setLineSpacing(dp(4), 1f);
        panel.addView(status, lp(0, dp(22)));

        diag = new TextView(this);
        diag.setTextColor(Color.parseColor("#8a90a0"));
        diag.setTextSize(11);
        diag.setTypeface(android.graphics.Typeface.MONOSPACE);
        diag.setLineSpacing(dp(2), 1f);
        diag.setTextIsSelectable(true);
        diag.setVisibility(View.GONE);
        panel.addView(diag, lp(dp(10), dp(4)));

        // 第一次启动要铺 88MB 运行时：没有进度反馈的话，用户只会觉得「卡住了」
        prepBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        prepBar.setMax(100);
        prepBar.setProgress(0);
        prepBar.setVisibility(View.GONE);
        panel.addView(prepBar, lp(0, dp(10)));

        prepNote = new TextView(this);
        prepNote.setTextColor(DIM);
        prepNote.setTextSize(12);
        prepNote.setVisibility(View.GONE);
        panel.addView(prepNote, lp(0, dp(10)));

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

        retry = new Button(this);
        retry.setText("再试一次自带引擎");
        retry.setAllCaps(false);
        retry.setTextColor(INK);
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (diag != null) { diag.setText(""); diag.setVisibility(View.GONE); }
                retry.setVisibility(View.GONE);
                boot();
            }
        });
        panel.addView(retry, lp(0, dp(8)));

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
        stopNode();
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
