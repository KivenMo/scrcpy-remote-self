package com.wb.remoteagent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.text.TextUtils;
import android.util.Log;

/**
 * 开机自启。
 *
 * 手机放在公司，没人去点「开始」那个按钮 —— 关机、重启、被系统回收之后必须能自己爬起来，
 * 否则第二天到公司就得本人到场，这个方案就没有意义了。
 *
 * 只在用户主动把「开机自动启动」打开之后才生效（配置项 unattended = true），
 * 默认是关的。
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "BootReceiver";

    private static final String PREF = "ra";

    /** 记录最近一次开机自启的结果，好在界面上告诉用户「到底成没成」。 */
    public static final String K_LAST_BOOT_AT = "lastBootStartAt";
    public static final String K_LAST_BOOT_OK = "lastBootStartOk";
    public static final String K_LAST_BOOT_NOTE = "lastBootStartNote";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                // 国产 ROM 的自启广播，各家名字不一样，常见的两种都收
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)
                && !"com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }

        SharedPreferences p = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        if (!p.getBoolean("unattended", false)) {
            Log.i(TAG, "没开「开机自动启动」，跳过");
            return;
        }

        String host = p.getString("host", "");
        String room = p.getString("room", "");
        if (TextUtils.isEmpty(host) || TextUtils.isEmpty(room)) {
            note(p, false, "配置里没有服务器地址或配对码");
            Log.w(TAG, "配置里没有服务器地址或配对码，无法自启");
            return;
        }

        Intent svc = new Intent(ctx, UnattendedService.class);
        svc.setAction(UnattendedService.ACTION_START);
        svc.putExtra(UnattendedService.EXTRA_HOST, host);
        svc.putExtra(UnattendedService.EXTRA_PORT, p.getInt("port", 8081));
        svc.putExtra(UnattendedService.EXTRA_ROOM, room);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(svc);
            else ctx.startService(svc);
            note(p, true, "已拉起，room=" + room);
            Log.i(TAG, "开机自启：已拉起无人值守服务 room=" + room);
        } catch (Throwable e) {
            // 部分 ROM 在开机广播里禁掉前台服务，只能等用户手动打开一次应用
            note(p, false, "启动被系统拒绝：" + e);
            Log.w(TAG, "开机自启失败: " + e);
        }
    }

    private static void note(SharedPreferences p, boolean ok, String msg) {
        p.edit()
                .putLong(K_LAST_BOOT_AT, System.currentTimeMillis())
                .putBoolean(K_LAST_BOOT_OK, ok)
                .putString(K_LAST_BOOT_NOTE, msg)
                .apply();
    }
}
