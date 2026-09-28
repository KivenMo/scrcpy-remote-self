package com.wb.remoteagent;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 列出手机上的照片和视频，供控制端「取文件」用。
 *
 * 为什么只列媒体库、不列任意目录：
 * Android 10 起是分区存储，第三方应用没有权限随便读别人的文件。
 * 能干净拿到、且只需要一个常规运行时权限的，就是媒体库（照片 / 视频）。
 * 所以这里只做媒体库，别的一概不碰。
 *
 * 权限：
 *   API 33+  READ_MEDIA_IMAGES / READ_MEDIA_VIDEO
 *   API 26~32  READ_EXTERNAL_STORAGE
 */
public class MediaFileLister {

    /** 列出来的单条 */
    public static class Item {
        public String id;        // "image:1234" / "video:5678"
        public String name;
        public long size;        // 拿不到时为 0
        public String kind;      // image / video
        public String mime;
        public String date;      // yyyy-MM-dd
        public Uri uri;
    }

    /** 一次最多列这么多，免得控制端下拉框几万条 */
    public static final int MAX_ITEMS = 300;

    private static final String[] PROJ = {
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.DATE_ADDED,
    };

    /* ---------------- 权限 ---------------- */

    /** 当前 SDK 下要读媒体库，需要申请哪个权限 */
    public static String requiredPermission() {
        if (Build.VERSION.SDK_INT >= 33) return "android.permission.READ_MEDIA_IMAGES";
        return "android.permission.READ_EXTERNAL_STORAGE";
    }

    public static boolean hasPermission(Context ctx) {
        if (Build.VERSION.SDK_INT >= 33) {
            boolean img = ctx.checkSelfPermission("android.permission.READ_MEDIA_IMAGES")
                    == PackageManager.PERMISSION_GRANTED;
            boolean vid = ctx.checkSelfPermission("android.permission.READ_MEDIA_VIDEO")
                    == PackageManager.PERMISSION_GRANTED;
            return img || vid;
        }
        return ctx.checkSelfPermission("android.permission.READ_EXTERNAL_STORAGE")
                == PackageManager.PERMISSION_GRANTED;
    }

    /** 没有权限时给控制端一句人话 */
    public static String emptyNote(Context ctx) {
        if (!hasPermission(ctx)) {
            return "被控端还没有授予「读取照片和视频」权限，"
                 + "请在手机上的「远程协助」App 里点一下授权按钮。";
        }
        return "手机媒体库里没有照片或视频。";
    }

    /* ---------------- 列表 ---------------- */

    public static List<Item> list(Context ctx) {
        List<Item> out = new ArrayList<>();
        if (!hasPermission(ctx)) return out;
        // 照片和视频各查一遍，谁新谁排在前面
        query(ctx, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "image", "image/*", out);
        query(ctx, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "video", "video/*", out);
        out.sort((a, b) -> b.date.compareTo(a.date));
        if (out.size() > MAX_ITEMS) return new ArrayList<>(out.subList(0, MAX_ITEMS));
        return out;
    }

    private static void query(Context ctx, Uri collection, String kind, String fallbackMime, List<Item> out) {
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(
                    collection, PROJ, null, null,
                    MediaStore.MediaColumns.DATE_ADDED + " DESC");
            if (c == null) return;
            int iId = c.getColumnIndex(MediaStore.MediaColumns._ID);
            int iName = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
            int iSize = c.getColumnIndex(MediaStore.MediaColumns.SIZE);
            int iMime = c.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE);
            int iDate = c.getColumnIndex(MediaStore.MediaColumns.DATE_ADDED);
            if (iId < 0) return;

            while (c.moveToNext()) {
                long rowId = c.getLong(iId);
                Item it = new Item();
                it.id = kind + ":" + rowId;
                it.kind = kind;
                it.uri = ContentUris.withAppendedId(collection, rowId);
                it.name = iName >= 0 && !c.isNull(iName)
                        ? c.getString(iName) : (kind + "_" + rowId);
                it.size = iSize >= 0 && !c.isNull(iSize) ? c.getLong(iSize) : 0L;
                it.mime = iMime >= 0 && !c.isNull(iMime) ? c.getString(iMime) : fallbackMime;
                it.date = fmtDate(iDate >= 0 && !c.isNull(iDate) ? c.getLong(iDate) : 0L);
                out.add(it);
            }
        } catch (Throwable ignored) {
            // 某个集合查不到（比如设备没有视频）就算了，不要影响另一个
        } finally {
            if (c != null) try { c.close(); } catch (Throwable ignored) {}
        }
    }

    private static String fmtDate(long seconds) {
        if (seconds <= 0) return "";
        try {
            return new SimpleDateFormat("yyyy-MM-dd", Locale.US)
                    .format(new Date(seconds * 1000L));
        } catch (Throwable e) {
            return "";
        }
    }

    /* ---------------- 按 id 找回来 ---------------- */

    public static Item find(Context ctx, String id) {
        if (id == null) return null;
        int p = id.indexOf(':');
        if (p <= 0) return null;
        String kind = id.substring(0, p);
        long rowId;
        try {
            rowId = Long.parseLong(id.substring(p + 1));
        } catch (Throwable e) {
            return null;
        }

        Uri collection;
        String fallbackMime;
        if ("image".equals(kind)) {
            collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            fallbackMime = "image/*";
        } else if ("video".equals(kind)) {
            collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
            fallbackMime = "video/*";
        } else {
            return null;
        }
        if (!hasPermission(ctx)) return null;

        Uri uri = ContentUris.withAppendedId(collection, rowId);
        Item it = new Item();
        it.id = id;
        it.kind = kind;
        it.uri = uri;
        it.name = kind + "_" + rowId;
        it.mime = fallbackMime;
        it.size = 0L;
        it.date = "";

        // 名字 / 类型 / 大小尽量从库里补全
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(uri, PROJ, null, null, null);
            if (c != null && c.moveToFirst()) {
                int iName = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
                int iSize = c.getColumnIndex(MediaStore.MediaColumns.SIZE);
                int iMime = c.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE);
                if (iName >= 0 && !c.isNull(iName)) it.name = c.getString(iName);
                if (iSize >= 0 && !c.isNull(iSize)) it.size = c.getLong(iSize);
                if (iMime >= 0 && !c.isNull(iMime)) it.mime = c.getString(iMime);
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) try { c.close(); } catch (Throwable ignored) {}
        }

        // 还是没有大小就换个口子问一次（有些设备 DISPLAY_NAME/SIZE 会是空）
        if (it.size <= 0) it.size = sizeViaOpenable(ctx.getContentResolver(), uri);
        return it;
    }

    /** 兜底：用 OpenableColumns.SIZE 再问一次 */
    private static long sizeViaOpenable(ContentResolver cr, Uri uri) {
        Cursor c = null;
        try {
            c = cr.query(uri, new String[]{OpenableColumns.SIZE}, null, null, null);
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Throwable ignored) {
        } finally {
            if (c != null) try { c.close(); } catch (Throwable ignored) {}
        }
        return 0L;
    }
}
