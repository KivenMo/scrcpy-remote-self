package com.wb.remoteagent;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

/**
 * 看门狗：定期把无人值守服务重新拉起来。
 *
 * <h3>为什么光靠 START_STICKY 不够</h3>
 * START_STICKY 只在「进程被系统因为内存压力杀掉」时才会重启服务。而国产 ROM
 * （华为/小米/OPPO 等）有自己的清理策略，会把应用整个「冻结」或强制停止 ——
 * 这种情况下系统认为是你自己停的，不会帮你重启。
 *
 * <h3>为什么不能只靠开机广播</h3>
 * 实测在华为 EMUI 上，即使 BOOT_COMPLETED 的接收器注册完全正确，
 * 系统也会把广播直接吞掉（logcat 里只有 BroadcastQueue「Finished」，
 * 我们的 onReceive 一次都没被调用），除非应用在「应用启动管理」里被允许自启动。
 * 那是一次性的手动设置，见 MainActivity 里的按钮。
 *
 * <h3>这个看门狗能补上什么</h3>
 * 闹钟只依赖应用自己 —— 只要服务曾经起来过一次（用户手动打开，或已加入自启白名单），
 * 之后哪怕进程被杀，闹钟到点也会把它重新拉起来。手机上唯一需要人工干预的，
 * 就只剩下「重启之后第一次」。
 *
 * 用 ELAPSED_REALTIME_WAKEUP + 不精确重复：不需要精确闹钟权限（Android 12+ 默认不给），
 * 而且服务本来就在前台跑着，被 Doze 稍微推迟几分钟没有影响。
 */
public class WatchdogReceiver extends BroadcastReceiver {

    private static final String TAG = "Watchdog";

    public static final String ACTION_TICK = "com.wb.remoteagent.WATCHDOG";

    /** 15 分钟一次。够快能救回来，又不至于太费电。 */
    private static final long INTERVAL_MS = 15 * 60 * 1000L;

    private static final int REQ_CODE = 0x51A3;

    private static PendingIntent pending(Context ctx) {
        Intent i = new Intent(ctx, WatchdogReceiver.class);
        i.setAction(ACTION_TICK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, REQ_CODE, i, flags);
    }

    /** 服务起来时调用。重复调用是安全的（同一个 PendingIntent 会覆盖）。 */
    public static void schedule(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            am.setInexactRepeating(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + INTERVAL_MS,
                    INTERVAL_MS,
                    pending(ctx));
            Log.i(TAG, "看门狗已排程，每 " + (INTERVAL_MS / 60000) + " 分钟一次");
        } catch (Throwable e) {
            Log.w(TAG, "排程失败: " + e);
        }
    }

    /** 用户主动停止时调用，否则刚停 15 分钟又被自己拉起来了。 */
    public static void cancel(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.cancel(pending(ctx));
            Log.i(TAG, "看门狗已取消");
        } catch (Throwable e) {
            Log.w(TAG, "取消失败: " + e);
        }
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        // 用户关掉了这个功能就别再拉
        if (!ctx.getSharedPreferences("ra", Context.MODE_PRIVATE).getBoolean("unattended", false)) {
            Log.i(TAG, "「开机自动启动」已关，看门狗退出");
            cancel(ctx);
            return;
        }
        if (UnattendedService.isRunning()) {
            return;   // 还活着，什么都不用做
        }
        Log.i(TAG, "服务不在了，拉起来");
        Intent svc = new Intent(ctx, UnattendedService.class);
        svc.setAction(UnattendedService.ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(svc);
            else ctx.startService(svc);
        } catch (Throwable e) {
            Log.w(TAG, "拉起失败: " + e);
        }
    }
}
