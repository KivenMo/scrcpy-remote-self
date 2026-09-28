package com.wb.remoteagent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

/**
 * 无人值守模式：只有「手」，没有「眼」。
 *
 * <h3>为什么需要它</h3>
 * 录屏（{@link CaptureService}）的授权弹窗是系统强制的 —— 手机放在公司、人已经回家，
 * 就永远点不了那一下。而「打卡」这个需求其实不需要看见画面：只要知道现在停在哪个界面、
 * 按钮上写的是什么，就够了。无障碍服务能把这些读出来，而且它**完全不需要录屏授权**。
 *
 * 于是这个服务：
 *   - 不申请 MediaProjection，因此启动时没有任何弹窗；
 *   - 能开机自启（见 {@link BootReceiver}），没人管也能一直待命；
 *   - 上行只有文字（界面结构），没有视频流，流量可以忽略不计；
 *   - 下行的 tap / swipe / text / 系统按键 和录屏模式完全一样，都是无障碍注入。
 *
 * <h3>代价（必须说清楚）</h3>
 *   - 控制端看不到画面，只能看到一串「文字 + 坐标」。要盲操作，心里得先有数。
 *   - 灭屏时读不到界面（没有「活动窗口」），所以收到指令会先尝试唤醒屏幕。
 *   - 锁屏界面既读不到也点不了 —— 手机上不能设锁屏密码，或把锁屏时间调到最长。
 *   - 银行、支付等 FLAG_SECURE 界面同样受保护。
 *
 * 两套模式可以同时开（同一个配对码只允许一个被控端，先连上的算）。
 */
public class UnattendedService extends Service implements AgentConnection.Listener {

    private static final String TAG = "UnattendedSvc";

    public static final String ACTION_START = "com.wb.remoteagent.UNATTENDED_START";
    public static final String ACTION_STOP = "com.wb.remoteagent.UNATTENDED_STOP";

    public static final String EXTRA_HOST = "host";
    public static final String EXTRA_PORT = "port";
    public static final String EXTRA_ROOM = "room";

    /** 和 MainActivity 共用同一份配置。 */
    private static final String PREF = "ra";
    private static final String K_KEEP_AWAKE = "keepAwake";

    private static final String CHANNEL_ID = "remote-assist-standby";
    private static final int NOTIF_ID = 0x51A2;

    /** 唤醒屏幕后要等一会儿锁屏/桌面才画出来。 */
    private static final long WAKE_SETTLE_MS = 1200L;

    private final Handler main = new Handler(Looper.getMainLooper());

    private volatile AgentConnection conn;
    private SharedPreferences prefs;

    private PowerManager.WakeLock wakeLock;
    private PowerManager.WakeLock keepAwakeLock;

    private volatile long lastCommandAt;

    /** 服务是不是还活着。看门狗（{@link WatchdogReceiver}）靠它判断要不要重新拉起。 */
    private static volatile boolean running;

    public static boolean isRunning() {
        return running;
    }

    /* ================= 生命周期 ================= */

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(PREF, Context.MODE_PRIVATE);
        running = true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopEverything();
            WatchdogReceiver.cancel(this);   // 用户明确要停，别让看门狗又拉起来
            stopSelf();
            return START_NOT_STICKY;
        }

        String host = intent == null ? null : intent.getStringExtra(EXTRA_HOST);
        int port = intent == null ? 8081 : intent.getIntExtra(EXTRA_PORT, 8081);
        String room = intent == null ? null : intent.getStringExtra(EXTRA_ROOM);

        // 开机自启（BootReceiver）不带 extra，参数从配置里读回来。
        // 进程被系统回收后 START_STICKY 重启也一样走这条路。
        if (host == null || host.isEmpty()) host = prefs.getString("host", "");
        if (room == null || room.isEmpty()) room = prefs.getString("room", "");
        if (port <= 0) port = prefs.getInt("port", 8081);

        if (host == null || host.isEmpty() || room == null || room.isEmpty()) {
            Log.w(TAG, "没有服务器地址或配对码，无法待命");
            stopSelf();
            return START_NOT_STICKY;
        }

        startForegroundCompat();
        applyKeepAwake();
        // 进程被 ROM 清掉之后，靠这个闹钟自己爬起来（开机那一次仍然需要自启白名单）
        WatchdogReceiver.schedule(this);

        if (conn != null && conn.isConnected()) {
            return START_STICKY;      // 已经在跑，别重复连
        }

        conn = new AgentConnection(host, port, room,
                Build.MANUFACTURER + " " + Build.MODEL + "（文字模式）",
                "unattended",
                AgentTls.isEnabled(this), AgentTls.pinOf(this), AgentTls.tofuOf(this),
                this);
        conn.start();
        Log.i(TAG, "无人值守已启动 " + host + ":" + port + " room=" + room
                + (AgentTls.isEnabled(this) ? " (TLS)" : " (明文)"));
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        stopEverything();
        super.onDestroy();
    }

    private void stopEverything() {
        AgentConnection c = conn;
        conn = null;
        if (c != null) c.stop();
        releaseWakelock();
        if (keepAwakeLock != null && keepAwakeLock.isHeld()) {
            try { keepAwakeLock.release(); } catch (Throwable ignored) {}
        }
    }

    /* ================= 通知 ================= */

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "远程协助 · 待命", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        b.setContentTitle("远程协助 · 待命中")
                .setContentText("文字模式，不录屏。控制端可读界面文字并操作")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setOngoing(true)
                .setContentIntent(pi);

        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                return;
            } catch (Throwable e) {
                // 个别 ROM 对前台服务类型校验更严，退一步用无类型方式启动
                Log.w(TAG, "带类型启动前台服务失败，降级重试: " + e);
            }
        }
        startForeground(NOTIF_ID, n);
    }

    /* ================= 屏幕 ================= */

    private boolean isScreenOn() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            return pm == null || pm.isInteractive();
        } catch (Throwable e) {
            return true;
        }
    }

    /**
     * 把屏幕点亮，让「活动窗口」存在，无障碍才读得到界面。
     * SCREEN_BRIGHT_WAKE_LOCK 早已标记废弃，但至今仍是唯一能由应用主动亮屏的手段。
     */
    @SuppressWarnings("deprecation")
    private boolean wakeScreen() {
        if (isScreenOn()) return true;
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return false;
            if (wakeLock == null) {
                wakeLock = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                                | PowerManager.ACQUIRE_CAUSES_WAKEUP
                                | PowerManager.ON_AFTER_RELEASE,
                        "remote-assist:wake");
                wakeLock.setReferenceCounted(false);
            }
            wakeLock.acquire(25000L);      // 25 秒后自动放掉，不用手工收
            Log.i(TAG, "已唤醒屏幕");
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "唤醒屏幕失败: " + e);
            return false;
        }
    }

    private void releaseWakelock() {
        PowerManager.WakeLock w = wakeLock;
        if (w != null && w.isHeld()) {
            try { w.release(); } catch (Throwable ignored) {}
        }
    }

    /** 常亮开关：手机插着电放在公司时打开，省得每次指令都要先唤醒。 */
    @SuppressWarnings("deprecation")
    private void applyKeepAwake() {
        boolean want = prefs != null && prefs.getBoolean(K_KEEP_AWAKE, false);
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            if (want) {
                if (keepAwakeLock == null) {
                    keepAwakeLock = pm.newWakeLock(
                            PowerManager.SCREEN_DIM_WAKE_LOCK, "remote-assist:keepawake");
                    keepAwakeLock.setReferenceCounted(false);
                }
                if (!keepAwakeLock.isHeld()) keepAwakeLock.acquire();
            } else if (keepAwakeLock != null && keepAwakeLock.isHeld()) {
                keepAwakeLock.release();
            }
        } catch (Throwable e) {
            Log.w(TAG, "常亮开关设置失败: " + e);
        }
    }

    /* ================= 连接回调 ================= */

    @Override
    public void onState(boolean connected, String info) {
        Log.i(TAG, connected ? "已连上中继 " + info : "断线：" + info);
    }

    @Override
    public void onFingerprintLearned(String fingerprint) {
        // 自签证书第一次连接（TOFU）。存下来，之后每次连接都会严格比对。
        AgentTls.saveLearnedPin(this, fingerprint);
        if (conn != null) conn.setTlsPin(fingerprint);
    }

    @Override
    public void onBinary(byte[] data) {
        // 文字模式不接收文件分片。真要用「传文件」，走录屏模式那套。
    }

    @Override
    public void onCommand(JSONObject cmd) {
        String t = cmd.optString("t");
        lastCommandAt = SystemClock.elapsedRealtime();
        RemoteAccessibilityService a11y = RemoteAccessibilityService.get();

        switch (t) {

            case "controller-joined": {
                // 新控制端进来了：先把话说清楚，再主动送一份当前界面过去，
                // 省得对方对着空白面板不知道下一步点哪儿。
                sendStatus("这台手机是【文字模式】：没有录屏，看不到画面。"
                        + "点「读屏」可以取到当前界面的文字和按钮。");
                main.postDelayed(() -> dumpUi(true), 300);
                return;
            }

            case "ping": {
                sendJson("pong", "mode", "unattended");
                return;
            }

            case "paired":
                // 中继收到 hello 之后回的执条，不需要处理，但别打「不认识的指令」
                return;

            /* ---- 读界面 ---- */
            case "dump":
            case "ui":
                dumpUi(cmd.optBoolean("wake", true));
                return;

            /* ---- 按文字点 ---- */
            case "taptext": {
                String q = cmd.optString("q", cmd.optString("text", ""));
                if (a11y == null) { ack("taptext", false, "无障碍服务没在运行，读不到也点不了"); return; }
                if (q.isEmpty()) { ack("taptext", false, "没说要点哪个文字"); return; }
                // scroll=true 时，找不到可见的匹配会先往上滚几屏再找
                String err = a11y.tapByText(q, cmd.optBoolean("scroll", false));
                ack("taptext", err == null, err == null ? "点了「" + q + "」" : err);
                if (err == null) main.postDelayed(() -> dumpUi(false), 700);   // 顺手把点完的结果送回去
                return;
            }

            /* ---- 开应用 ---- */
            case "open":
            case "launch": {
                String pkg = cmd.optString("pkg", "");
                String label = cmd.optString("label", "");
                if (a11y == null) { ack(t, false, "无障碍服务没在运行"); return; }
                boolean ok;
                if (!label.isEmpty()) {
                    ok = a11y.launchAppByLabel(label);
                } else if (pkg.contains(".")) {
                    ok = a11y.launchApp(pkg);            // 看着像包名，直接用，最准
                } else {
                    ok = a11y.launchAppByLabel(pkg);     // 只是个中文名，按名字找
                }
                ack(t, ok, ok ? "已打开" + (label.isEmpty() ? pkg : label)
                              : "打不开：" + (label.isEmpty() ? pkg : label));
                if (ok) main.postDelayed(() -> dumpUi(false), 1800);   // 等应用起来再读一次
                return;
            }

            case "apps": {
                try {
                    JSONObject out = new JSONObject();
                    out.put("t", "apps");
                    out.put("list", AppCatalog.listLaunchable(this));
                    send(out);
                } catch (Throwable e) {
                    Log.w(TAG, "取应用列表失败: " + e);
                }
                return;
            }

            /* ---- 触摸 / 按键 / 文字：和录屏模式完全一致 ---- */
            case "tap":
                if (a11y != null) a11y.tap((float) cmd.optDouble("x", 0), (float) cmd.optDouble("y", 0));
                return;

            case "long":
                if (a11y != null) a11y.longPress((float) cmd.optDouble("x", 0), (float) cmd.optDouble("y", 0));
                return;

            case "swipe":
                if (a11y != null) {
                    a11y.swipe((float) cmd.optDouble("x1", 0), (float) cmd.optDouble("y1", 0),
                            (float) cmd.optDouble("x2", 0), (float) cmd.optDouble("y2", 0),
                            (long) cmd.optDouble("d", 300));
                }
                return;

            case "key": {
                String k = cmd.optString("k");
                if (a11y == null) return;
                if ("enter".equals(k)) a11y.imeEnter();
                else a11y.globalKey(k);
                return;
            }

            case "text": {
                boolean ok = a11y != null && a11y.inputText(cmd.optString("s"));
                if (!ok) sendStatus("写不进文字：先在界面上点一下输入框（taptext），并确认无障碍服务已开启");
                return;
            }

            case "clip": {
                boolean ok = a11y != null && a11y.setClipboard(cmd.optString("v", ""));
                if (ok && cmd.optBoolean("paste", false) && a11y != null) a11y.pasteIntoFocus();
                if (!ok) sendStatus("写入剪贴板失败");
                return;
            }

            case "clipget": {
                String text = null;
                String src = "none";
                if (a11y != null) {
                    text = a11y.readClipboard();
                    if (text != null) src = "clipboard";
                    else {
                        text = a11y.readFocusedText();
                        if (text != null) src = "focused";
                    }
                }
                try {
                    JSONObject o = new JSONObject();
                    o.put("t", "clip");
                    o.put("src", src);
                    o.put("v", text == null ? "" : text);
                    send(o);
                } catch (Throwable ignored) {}
                return;
            }

            /* ---- 控制端问「用哪种编码」时，明确回答「没有画面」---- */
            case "codec": {
                try {
                    JSONObject o = new JSONObject();
                    o.put("t", "codec");
                    o.put("v", "none");
                    o.put("mode", "unattended");
                    o.put("msg", "这台手机是文字模式，没有录屏授权，看不到画面。请用「读屏」看界面文字。");
                    send(o);
                } catch (Throwable ignored) {}
                sendStatus("文字模式：没有画面可看，用「读屏」取当前界面的文字。");
                return;
            }

            case "quality":
                // 没有视频，画质参数无从谈起。明确回一句，别让控制端空等。
                ack("quality", false, "文字模式没有画面，画质参数无效");
                return;

            default:
                Log.d(TAG, "不认识的指令: " + t);
        }
    }

    /* ================= 读屏 ================= */

    private void dumpUi(boolean allowWake) {
        RemoteAccessibilityService a11y = RemoteAccessibilityService.get();
        if (a11y == null) {
            sendStatus("无障碍服务没在运行 —— 文字模式全靠它，请到「设置 → 无障碍」里打开");
            return;
        }

        String json = a11y.readUi();
        if (json != null) {
            sendUi(json);
            return;
        }

        // 读不到，最常见的原因就是屏幕黑着：灭屏时系统没有「活动窗口」。
        if (!allowWake) {
            sendStatus("读不到界面（屏幕可能是黑的）。再发一次并允许唤醒屏幕试试。");
            return;
        }
        if (isScreenOn()) {
            sendStatus("屏幕是亮的，但读不到界面 —— 可能是锁屏界面（锁屏读不到也点不了）");
            return;
        }
        if (!wakeScreen()) {
            sendStatus("读不到界面，而且唤不醒屏幕");
            return;
        }
        main.postDelayed(() -> {
            RemoteAccessibilityService a2 = RemoteAccessibilityService.get();
            String j2 = a2 == null ? null : a2.readUi();
            if (j2 != null) sendUi(j2);
            else sendStatus("已亮屏，但还是读不到界面 —— 多半是停在锁屏界面上了");
        }, WAKE_SETTLE_MS);
    }

    /** 把 readUi() 的 JSON 原样转发，只补上类型和当前屏幕状态。 */
    private void sendUi(String rawJson) {
        try {
            JSONObject o = new JSONObject(rawJson);
            o.put("t", "ui");
            o.put("mode", "unattended");
            o.put("screenOn", isScreenOn());
            send(o);
            int n = o.optJSONArray("items") == null ? 0 : o.optJSONArray("items").length();
            Log.i(TAG, "已送界面文字 " + n + " 项");
        } catch (Throwable e) {
            Log.w(TAG, "转发界面文字失败: " + e);
        }
    }

    /* ================= 发送 ================= */

    private void send(JSONObject o) {
        AgentConnection c = conn;
        if (c != null) c.sendJson(o);
    }

    private void sendJson(String t, String key, Object value) {
        try {
            JSONObject o = new JSONObject();
            o.put("t", t);
            if (key != null) o.put(key, value);
            send(o);
        } catch (Throwable ignored) {}
    }

    private void ack(String op, boolean ok, String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("t", "ack");
            o.put("op", op);
            o.put("ok", ok);
            o.put("msg", msg);
            send(o);
        } catch (Throwable ignored) {}
        sendStatus(msg);
    }

    /** 复用控制端已有的 status 通道，人话直接显示在面板上。 */
    private void sendStatus(String msg) {
        sendJson("status", "msg", msg);
    }

    /** 距上一条指令过去了多久（毫秒）。诊断用。 */
    public long idleMs() {
        long t = lastCommandAt;
        return t == 0 ? -1 : SystemClock.elapsedRealtime() - t;
    }
}
