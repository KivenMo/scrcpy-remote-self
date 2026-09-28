package com.wb.remoteagent;

import android.content.Context;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.WindowManager;

/** 取屏幕真实像素尺寸（含状态栏与导航栏区域）。 */
public final class ScreenInfo {

    private ScreenInfo() {}

    public static Point getRealSize(Context ctx) {
        WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        if (wm == null) return new Point(1080, 1920);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Rect b = wm.getCurrentWindowMetrics().getBounds();
                if (b.width() > 0 && b.height() > 0) return new Point(b.width(), b.height());
            }
        } catch (Throwable ignored) {
        }
        try {
            DisplayMetrics dm = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            if (dm.widthPixels > 0 && dm.heightPixels > 0) {
                return new Point(dm.widthPixels, dm.heightPixels);
            }
        } catch (Throwable ignored) {
        }
        return new Point(1080, 1920);
    }
}
