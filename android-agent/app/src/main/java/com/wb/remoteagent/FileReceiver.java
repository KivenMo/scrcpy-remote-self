package com.wb.remoteagent;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * 接收控制端传过来的文件。
 *
 * Android 10 及以上走 MediaStore 写进公共「下载」目录，不需要任何存储权限；
 * Android 9 及以下退到应用自己的外部目录（同样不需要权限，但不在下载目录里）。
 */
public class FileReceiver {

    private static final String TAG = "FileReceiver";

    private final Context ctx;

    private OutputStream out;
    private Uri pendingUri;     // MediaStore 用
    private File plainFile;     // 旧系统用
    private String name = "";
    private long expected;
    private long written;
    private boolean active;

    public FileReceiver(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    public boolean isActive() {
        return active;
    }

    /** 开始接收。返回将要保存的位置（给人看的字符串）。 */
    public synchronized String start(String rawName, long size, String mime) throws IOException {
        abort();
        name = sanitize(rawName);
        expected = size;
        written = 0;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
            cv.put(MediaStore.Downloads.MIME_TYPE,
                    (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime);
            cv.put(MediaStore.Downloads.IS_PENDING, 1);

            ContentResolver cr = ctx.getContentResolver();
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) throw new IOException("无法在下载目录创建文件");
            OutputStream os = cr.openOutputStream(uri, "w");
            if (os == null) {
                try { cr.delete(uri, null, null); } catch (Throwable ignored) {}
                throw new IOException("无法写入下载目录");
            }
            pendingUri = uri;
            out = os;
            active = true;
            return "下载/" + name;
        }

        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = ctx.getFilesDir();
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建目录 " + dir);
        File f = new File(dir, name);
        plainFile = f;
        out = new FileOutputStream(f);
        active = true;
        return f.getAbsolutePath();
    }

    /** 追加一块数据。 */
    public synchronized void chunk(byte[] data) throws IOException {
        if (!active || out == null) return;
        out.write(data);
        written += data.length;
    }

    /** 收完，落盘。返回保存位置。 */
    public synchronized String finish() throws IOException {
        if (!active) throw new IOException("没有正在接收的文件");
        try {
            out.flush();
            out.close();
        } finally {
            out = null;
        }

        String where;
        if (pendingUri != null) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.IS_PENDING, 0);
            try {
                ctx.getContentResolver().update(pendingUri, cv, null, null);
            } catch (Throwable e) {
                Log.w(TAG, "落盘标记失败: " + e);
            }
            where = "下载/" + name;
            pendingUri = null;
        } else {
            where = plainFile == null ? name : plainFile.getAbsolutePath();
            plainFile = null;
        }

        Log.i(TAG, "文件接收完成 " + where + "  " + written + " 字节");
        active = false;
        return where;
    }

    /** 中途失败或取消。 */
    public synchronized void abort() {
        if (out != null) {
            try { out.close(); } catch (Throwable ignored) {}
            out = null;
        }
        if (pendingUri != null) {
            try { ctx.getContentResolver().delete(pendingUri, null, null); } catch (Throwable ignored) {}
            pendingUri = null;
        }
        if (plainFile != null && plainFile.exists()) {
            try { plainFile.delete(); } catch (Throwable ignored) {}
            plainFile = null;
        }
        active = false;
        written = 0;
    }

    public synchronized long written() {
        return written;
    }

    public synchronized long expected() {
        return expected;
    }

    /** 去掉路径分隔符等危险字符，避免写到别的地方去。 */
    private static String sanitize(String raw) {
        String s = (raw == null || raw.trim().isEmpty()) ? "file" : raw.trim();
        s = s.replace('\\', '_').replace('/', '_').replace(':', '_');
        s = s.replaceAll("[\\x00-\\x1f]", "");
        if (s.equals(".") || s.equals("..")) s = "file";
        if (s.length() > 120) {
            int dot = s.lastIndexOf('.');
            String ext = (dot > 0 && s.length() - dot <= 10) ? s.substring(dot) : "";
            s = s.substring(0, 120 - ext.length()) + ext;
        }
        return s;
    }
}
