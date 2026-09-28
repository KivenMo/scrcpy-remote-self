package com.wb.remoteagent;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import java.security.SecureRandom;

public class MainActivity extends Activity {

    private static final int REQ_CAPTURE = 1001;
    private static final int REQ_NOTIF = 1002;
    private static final int REQ_MEDIA = 1003;

    private static final String PREF = "ra";
    private static final String K_HOST = "host";
    private static final String K_PORT = "port";
    private static final String K_ROOM = "room";
    /** 无人值守模式：开机自启（BootReceiver 读这个）。 */
    private static final String K_UNATTENDED = "unattended";
    /** 常亮：手机插着电放公司时打开。 */
    private static final String K_KEEP_AWAKE = "keepAwake";

    private static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    private EditText etHost, etPort, etRoom, etTlsPin;
    private TextView tvA11y, tvStatus, tvMedia, tvBoot, tvTls;
    private Button btnStart, btnStop, btnUnattended, btnAutoStart, btnKeepAwake, btnAutostartCfg, btnTlsPin;
    private CheckBox cbTls;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREF, Context.MODE_PRIVATE);

        etHost = findViewById(R.id.etHost);
        etPort = findViewById(R.id.etPort);
        etRoom = findViewById(R.id.etRoom);
        tvA11y = findViewById(R.id.tvA11y);
        tvStatus = findViewById(R.id.tvStatus);
        tvMedia = findViewById(R.id.tvMedia);
        btnStart = findViewById(R.id.btnStart);
        btnStop = findViewById(R.id.btnStop);
        btnUnattended = findViewById(R.id.btnUnattended);
        btnAutoStart = findViewById(R.id.btnAutoStart);
        btnKeepAwake = findViewById(R.id.btnKeepAwake);
        btnAutostartCfg = findViewById(R.id.btnAutostartCfg);
        tvBoot = findViewById(R.id.tvBoot);

        cbTls = findViewById(R.id.cbTls);
        etTlsPin = findViewById(R.id.etTlsPin);
        tvTls = findViewById(R.id.tvTls);
        btnTlsPin = findViewById(R.id.btnTlsPin);

        etHost.setText(prefs.getString(K_HOST, ""));
        etPort.setText(String.valueOf(prefs.getInt(K_PORT, 8081)));

        // 加密设置：勾选状态和指纹都从 prefs 恢复。
        //
        // 指纹框**必须回填**。一开始故意留空（想着「框里是你要断言的，下面是当前生效的」），
        // 结果踩了个真坑：用户已经配好指纹、下次进来直接点启动，persistTlsPrefs() 看到
        // 框是空的就 remove 掉了 —— 严校验被静默降级成 TOFU，而且界面上看不出任何变化。
        // 现在框里就是当前生效的指纹，「清空」是用户明确的动作。
        cbTls.setChecked(AgentTls.isEnabled(this));
        String savedPin = AgentTls.pinOf(this);
        if (savedPin != null) etTlsPin.setText(savedPin);
        cbTls.setOnCheckedChangeListener((v, checked) -> refreshTlsState());
        etTlsPin.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) {}
            @Override public void afterTextChanged(android.text.Editable s) { refreshTlsState(); }
        });
        btnTlsPin.setOnClickListener(v -> {
            etTlsPin.setText("");
            prefs.edit().remove(AgentTls.K_TLS_PIN).apply();
            refreshTlsState();
            Toast.makeText(this, "已清掉记住的指纹，下次连接会重新学习", Toast.LENGTH_SHORT).show();
        });
        refreshTlsState();

        String room = prefs.getString(K_ROOM, "");
        if (TextUtils.isEmpty(room)) {
            room = newCode();
            prefs.edit().putString(K_ROOM, room).apply();
        }
        etRoom.setText(room);

        findViewById(R.id.btnNewCode).setOnClickListener(v -> {
            String c = newCode();
            etRoom.setText(c);
            prefs.edit().putString(K_ROOM, c).apply();
            Toast.makeText(this, "已换新配对码，记得同步告诉控制端", Toast.LENGTH_SHORT).show();
        });

        findViewById(R.id.btnA11y).setOnClickListener(v -> {
            try {
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            } catch (Throwable e) {
                Toast.makeText(this, "打不开无障碍设置，请手动到「设置 → 无障碍」里找", Toast.LENGTH_LONG).show();
            }
        });

        findViewById(R.id.btnBattery).setOnClickListener(v -> requestBatteryExemption());

        findViewById(R.id.btnMedia).setOnClickListener(v -> requestMediaPermission());

        btnStart.setOnClickListener(v -> startSession());
        btnStop.setOnClickListener(v -> stopSession());
        btnUnattended.setOnClickListener(v -> startUnattended());
        btnAutostartCfg.setOnClickListener(v -> openAutostartSettings());

        btnAutoStart.setOnClickListener(v -> {
            boolean on = !prefs.getBoolean(K_UNATTENDED, false);
            prefs.edit().putBoolean(K_UNATTENDED, on).apply();
            refreshUnattendedState();
            Toast.makeText(this, on
                            ? "已打开：下次开机自动进入文字模式待命"
                            : "已关闭：开机后需要手动点一下",
                    Toast.LENGTH_LONG).show();
        });

        btnKeepAwake.setOnClickListener(v -> {
            boolean on = !prefs.getBoolean(K_KEEP_AWAKE, false);
            prefs.edit().putBoolean(K_KEEP_AWAKE, on).apply();
            refreshUnattendedState();
            Toast.makeText(this, on
                            ? "已打开屏幕常亮（费电，建议插着电）"
                            : "已关闭屏幕常亮",
                    Toast.LENGTH_LONG).show();
            // 服务在跑的话立刻生效（onStartCommand 会先 applyKeepAwake 再判断是否已连上）
            Intent svc = new Intent(this, UnattendedService.class);
            svc.setAction(UnattendedService.ACTION_START);
            svc.putExtra(UnattendedService.EXTRA_HOST, prefs.getString(K_HOST, ""));
            svc.putExtra(UnattendedService.EXTRA_PORT, prefs.getInt(K_PORT, 8081));
            svc.putExtra(UnattendedService.EXTRA_ROOM, prefs.getString(K_ROOM, ""));
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc);
                else startService(svc);
            } catch (Throwable ignored) {}
        });

        etRoom.setOnClickListener(v -> {
            // 方便复制给别人
            String c = etRoom.getText().toString().trim();
            if (!c.isEmpty()) {
                android.content.ClipboardManager cm =
                        (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("配对码", c));
                    Toast.makeText(this, "配对码已复制：" + c, Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshA11yState();
        refreshMediaState();
        refreshUnattendedState();
        // 服务可能刚在后台 TOFU 学到了指纹，回到前台要能看到
        refreshTlsState();
    }

    /* ---------------- 无人值守（不录屏） ---------------- */

    /**
     * 起一个不申请录屏的前台服务：没有系统弹窗，所以手机放公司也能一直待命。
     * 控制端看不到画面，但能读界面文字、按文字点、开应用。
     */
    private void startUnattended() {
        String host = etHost.getText().toString().trim()
                .replace("http://", "").replace("https://", "");
        int slash = host.indexOf('/');
        if (slash > 0) host = host.substring(0, slash);
        int colon = host.indexOf(':');
        String portStr = etPort.getText().toString().trim();
        if (colon > 0) {
            portStr = host.substring(colon + 1);
            host = host.substring(0, colon);
        }
        String room = etRoom.getText().toString().trim().toUpperCase();

        if (TextUtils.isEmpty(host)) {
            Toast.makeText(this, "请先填服务器地址", Toast.LENGTH_SHORT).show();
            return;
        }
        if (room.length() < 4) {
            Toast.makeText(this, "配对码太短", Toast.LENGTH_SHORT).show();
            return;
        }
        int port;
        try {
            port = Integer.parseInt(portStr);
        } catch (Throwable e) {
            port = 8081;
        }

        if (!isAccessibilityEnabled()) {
            Toast.makeText(this, "还没开无障碍服务 —— 文字模式全靠它，先开了再用",
                    Toast.LENGTH_LONG).show();
        }

        // 同一个配对码只允许一个被控端，先连上的算。这里先把自己那套录屏会话停掉，
        // 免得两边打架、控制端忽上忽下。
        stopCapture();

        prefs.edit()
                .putString(K_HOST, host)
                .putInt(K_PORT, port)
                .putString(K_ROOM, room)
                .apply();
        persistTlsPrefs();

        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
            }
        }

        Intent svc = new Intent(this, UnattendedService.class);
        svc.setAction(UnattendedService.ACTION_START);
        svc.putExtra(UnattendedService.EXTRA_HOST, host);
        svc.putExtra(UnattendedService.EXTRA_PORT, port);
        svc.putExtra(UnattendedService.EXTRA_ROOM, room);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc);
            else startService(svc);
            setStatus("已进入【文字模式】待命 —— 没有任何授权弹窗。\n\n配对码：" + room
                    + "\n\n控制端连上后会看到这台手机的界面文字，可以按文字点、开应用。看不到画面。\n"
                    + "手机放公司没人管的话，把下面「开机自动启动」也打开。");
        } catch (Throwable e) {
            setStatus("启动文字模式失败：" + e);
        }
    }

    /**
     * 打开系统的「自启动 / 启动管理」设置页。
     *
     * 为什么需要这个按钮：实测在华为 EMUI 上，即使 BOOT_COMPLETED 的接收器注册正确，
     * 系统也会把广播直接吞掉（logcat 里只看到 BroadcastQueue「Finished」，
     * 我们的 onReceive 一次都没被调用），除非应用在「应用启动管理」里被允许自启动。
     * 而各家 ROM 都没给这个页面标准 action，只能挨个试组件名。
     */
    private void openAutostartSettings() {
        String[][] candidates = {
                // 华为：应用启动管理
                {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
                {"com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"},
                {"com.huawei.systemmanager", "com.huawei.systemmanager.mainscreen.MainScreenActivity"},
                // 小米
                {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
                // OPPO / vivo / 乐视
                {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
                {"com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
                {"com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity"},
        };
        for (String[] c : candidates) {
            try {
                Intent i = new Intent();
                i.setComponent(new ComponentName(c[0], c[1]));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
                Toast.makeText(this, "在这个页面里找到「远程协助」，允许它自启动", Toast.LENGTH_LONG).show();
                return;
            } catch (Throwable ignored) {
                // 没有这个组件、或没有权限（华为的启动管理页就要求一个厂商私有权限），试下一个
            }
        }
        // 退路：本应用的「应用信息」页，多数 ROM 上从那里能摸到自启动开关
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
            Toast.makeText(this,
                    "这台手机不让直接打开启动管理。请手动到「手机管家 → 应用启动管理」，"
                            + "把「远程协助」的自启动打开。", Toast.LENGTH_LONG).show();
        } catch (Throwable e) {
            Toast.makeText(this,
                    "请手动到「手机管家 → 应用启动管理」里把本应用设为允许自启动",
                    Toast.LENGTH_LONG).show();
        }
    }

    /**
     * 把加密设置落盘。
     * 两个模式的服务都是从 SharedPreferences 直接读的（开机自启那条路径没有 extra），
     * 所以必须在启动服务之前写进去。
     */
    private void persistTlsPrefs() {
        String pin = AgentTls.normalize(etTlsPin.getText().toString());
        SharedPreferences.Editor e = prefs.edit().putBoolean(AgentTls.K_TLS, cbTls.isChecked());
        if (pin == null) {
            // 框里空着 = 清掉旧指纹，让服务重新 TOFU 学一次
            e.remove(AgentTls.K_TLS_PIN);
        } else {
            e.putString(AgentTls.K_TLS_PIN, pin);
        }
        e.apply();
        refreshTlsState();
    }

    /** 把「到底加没加密、现在认的是哪个指纹」讲清楚 —— 这块最容易配错了还浑然不觉。 */
    private void refreshTlsState() {
        if (tvTls == null) return;
        if (!cbTls.isChecked()) {
            tvTls.setText("未启用加密 —— 配对码、屏幕画面、输入的密码都是明文，只适合局域网。");
            tvTls.setTextColor(0xFF9AA1AB);
            btnTlsPin.setEnabled(false);
            return;
        }
        btnTlsPin.setEnabled(true);

        // 框里是什么就按什么执行，所以状态说明直接照框里说，不再区分「填的/记住的」
        String typed = AgentTls.normalize(etTlsPin.getText().toString());
        if (typed == null) {
            tvTls.setText("已启用加密，指纹框是空的。\n"
                    + "第一次连接会把服务器证书指纹记下来（TOFU），之后每次连接都严格比对。\n"
                    + "第一次连接挡不住主动中间人 —— 方便的话把服务器上 tools/make-cert.sh "
                    + "打印的指纹填到上面，那样从第一次就是严的。");
            tvTls.setTextColor(0xFF8A6100);
        } else {
            tvTls.setText("已启用加密，将严格校验这个指纹：\n" + typed
                    + "\n和服务器上 tools/make-cert.sh 打印的核对一下：一致就说明没被顶替。");
            tvTls.setTextColor(0xFF1D9E75);
        }
    }

    private void refreshUnattendedState() {
        if (btnAutoStart == null) return;
        boolean auto = prefs.getBoolean(K_UNATTENDED, false);
        btnAutoStart.setText("开机自动启动：" + (auto ? "开" : "关"));
        btnAutoStart.setTextColor(auto ? 0xFF1D9E75 : 0xFF3C4450);
        boolean keep = prefs.getBoolean(K_KEEP_AWAKE, false);
        btnKeepAwake.setText("屏幕常亮：" + (keep ? "开" : "关"));
        btnKeepAwake.setTextColor(keep ? 0xFF1D9E75 : 0xFF3C4450);

        // 上次开机自启的结果。手机放公司时，这是唯一能远程判断「它到底起没起来」的线索。
        long at = prefs.getLong(BootReceiver.K_LAST_BOOT_AT, 0);
        if (tvBoot == null) return;
        if (at == 0) {
            tvBoot.setText("上次开机自启：还没有过记录");
            tvBoot.setTextColor(0xFF9AA1AB);
        } else {
            boolean ok = prefs.getBoolean(BootReceiver.K_LAST_BOOT_OK, false);
            String when = new java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault())
                    .format(new java.util.Date(at));
            tvBoot.setText("上次开机自启：" + (ok ? "成功" : "失败") + "（" + when + "）"
                    + (ok ? "" : "\n" + prefs.getString(BootReceiver.K_LAST_BOOT_NOTE, "")));
            tvBoot.setTextColor(ok ? 0xFF1D9E75 : 0xFFD64545);
        }
    }

    /** 只停录屏那一路，文字模式不受影响。 */
    private void stopCapture() {
        Intent svc = new Intent(this, CaptureService.class);
        svc.setAction(CaptureService.ACTION_STOP);
        try {
            startService(svc);
        } catch (Throwable ignored) {}
    }

    private void stopUnattended() {
        Intent svc = new Intent(this, UnattendedService.class);
        svc.setAction(UnattendedService.ACTION_STOP);
        try {
            startService(svc);
        } catch (Throwable ignored) {}
    }

    /* ---------------- 取文件权限（可选） ---------------- */

    private void refreshMediaState() {
        if (tvMedia == null) return;
        if (MediaFileLister.hasPermission(this)) {
            tvMedia.setText("取文件权限：已授予");
            tvMedia.setTextColor(0xFF1D9E75);
        } else {
            tvMedia.setText("取文件权限：未授予");
            tvMedia.setTextColor(0xFF9AA1AB);
        }
    }

    private void requestMediaPermission() {
        if (MediaFileLister.hasPermission(this)) {
            Toast.makeText(this, "已经授权过了", Toast.LENGTH_SHORT).show();
            return;
        }
        String[] perms;
        if (Build.VERSION.SDK_INT >= 33) {
            // 33+ 拆成了图片和视频两个权限，一起要
            perms = new String[]{
                    "android.permission.READ_MEDIA_IMAGES",
                    "android.permission.READ_MEDIA_VIDEO",
            };
        } else {
            perms = new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
        }
        try {
            requestPermissions(perms, REQ_MEDIA);
        } catch (Throwable e) {
            Toast.makeText(this, "申请权限失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_MEDIA) return;
        refreshMediaState();
        if (MediaFileLister.hasPermission(this)) {
            Toast.makeText(this, "好了，控制端现在可以把手机上的照片取走", Toast.LENGTH_SHORT).show();
        } else {
            Toast.makeText(this, "没有授权，取文件功能会不可用（其它功能不受影响）",
                    Toast.LENGTH_LONG).show();
        }
    }

    /* ---------------- 无障碍状态 ---------------- */

    private void refreshA11yState() {
        boolean on = isAccessibilityEnabled();
        if (on) {
            tvA11y.setText("无障碍服务：已开启");
            tvA11y.setTextColor(0xFF1D9E75);
        } else {
            tvA11y.setText("无障碍服务：未开启");
            tvA11y.setTextColor(0xFFD64545);
        }
    }

    private boolean isAccessibilityEnabled() {
        try {
            String enabled = Settings.Secure.getString(
                    getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (enabled == null) return false;
            ComponentName cn = new ComponentName(this, RemoteAccessibilityService.class);
            String flat = cn.flattenToString();
            String flatShort = cn.flattenToShortString();
            String lower = enabled.toLowerCase();
            return lower.contains(flat.toLowerCase()) || lower.contains(flatShort.toLowerCase());
        } catch (Throwable e) {
            return false;
        }
    }

    /* ---------------- 启动 / 停止 ---------------- */

    private void startSession() {
        String host = etHost.getText().toString().trim()
                .replace("http://", "").replace("https://", "");
        int slash = host.indexOf('/');
        if (slash > 0) host = host.substring(0, slash);
        int colon = host.indexOf(':');
        String portStr = etPort.getText().toString().trim();
        if (colon > 0) {
            portStr = host.substring(colon + 1);
            host = host.substring(0, colon);
        }
        String room = etRoom.getText().toString().trim().toUpperCase();

        if (TextUtils.isEmpty(host)) {
            Toast.makeText(this, "请先填服务器地址", Toast.LENGTH_SHORT).show();
            return;
        }
        if (room.length() < 4) {
            Toast.makeText(this, "配对码太短", Toast.LENGTH_SHORT).show();
            return;
        }
        int port;
        try {
            port = Integer.parseInt(portStr);
        } catch (Throwable e) {
            port = 8081;
        }

        if (!isAccessibilityEnabled()) {
            Toast.makeText(this, "还没开无障碍服务，开了才能远程点击", Toast.LENGTH_LONG).show();
        }

        prefs.edit()
                .putString(K_HOST, host)
                .putInt(K_PORT, port)
                .putString(K_ROOM, room)
                .apply();
        persistTlsPrefs();

        // 同一个配对码只允许一个被控端。先把文字模式停掉，免得两边抢连接。
        stopUnattended();

        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
            }
        }

        MediaProjectionManager mpm =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            Toast.makeText(this, "本机不支持录屏", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE);
        } catch (Throwable e) {
            Toast.makeText(this, "调不起录屏授权：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_CAPTURE) return;

        if (resultCode != RESULT_OK || data == null) {
            setStatus("你拒绝了录屏授权，远程协助没有启动。");
            return;
        }

        Intent svc = new Intent(this, CaptureService.class);
        svc.setAction(CaptureService.ACTION_START);
        svc.putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode);
        svc.putExtra(CaptureService.EXTRA_RESULT_DATA, data);
        svc.putExtra(CaptureService.EXTRA_HOST, etHost.getText().toString().trim()
                .replace("http://", "").replace("https://", ""));
        int port;
        try {
            port = Integer.parseInt(etPort.getText().toString().trim());
        } catch (Throwable e) {
            port = 8081;
        }
        svc.putExtra(CaptureService.EXTRA_PORT, port);
        svc.putExtra(CaptureService.EXTRA_ROOM, etRoom.getText().toString().trim().toUpperCase());
        svc.putExtra(CaptureService.EXTRA_WIDTH, 720);
        svc.putExtra(CaptureService.EXTRA_FPS, 12);
        svc.putExtra(CaptureService.EXTRA_QUALITY, 60);
        svc.putExtra(CaptureService.EXTRA_BITRATE, 1500000);
        svc.putExtra(CaptureService.EXTRA_CODEC, "h264");

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(svc);
            } else {
                startService(svc);
            }
            btnStop.setEnabled(true);
            setStatus("已启动。\n\n配对码：" + etRoom.getText().toString().trim().toUpperCase()
                    + "\n\n现在用控制端手机连上服务器，输入这个配对码即可看到画面。");
        } catch (Throwable e) {
            setStatus("启动失败：" + e);
        }
    }

    private void stopSession() {
        stopCapture();
        stopUnattended();
        btnStop.setEnabled(false);
        setStatus("已停止。");
    }

    /* ---------------- 电池白名单 ---------------- */

    private void requestBatteryExemption() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Toast.makeText(this, "已经在白名单里了", Toast.LENGTH_SHORT).show();
                return;
            }
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Throwable e) {
            Toast.makeText(this, "请在「设置 → 电池 → 应用启动管理」里把本应用设为允许后台运行",
                    Toast.LENGTH_LONG).show();
        }
    }

    private void setStatus(String s) {
        tvStatus.setText(s);
    }

    private static String newCode() {
        SecureRandom r = new SecureRandom();
        StringBuilder sb = new StringBuilder(8);
        for (int i = 0; i < 8; i++) sb.append(ALPHABET.charAt(r.nextInt(ALPHABET.length())));
        return sb.toString();
    }
}
