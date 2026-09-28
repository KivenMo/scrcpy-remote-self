package com.wb.remoteagent;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;

/**
 * 把手机上的一个文件分片推给控制端（被控端 -> 控制端）。
 *
 * 复用画面那条二进制通道、同一套 10 字节帧头，只是 kind 换成 0x03，
 * 所以中继服务器完全不用改，控制端也只要在 parseFrame 之后按 kind 分流。
 *
 * 背压：AgentConnection.sendPacket 是 synchronized + 阻塞写，
 * 所以这里在独立线程里发，socket 缓冲满了自然就写不动、自动降速，
 * 不会把内存撑爆。每片之间睡 2ms 是为了别把画面饿死 —— 两者共用一条连接。
 */
public class FileSender {

    private static final String TAG = "RA-FileSender";

    private static final int KIND_FILE = 0x03;
    private static final int FRAME_HEADER = 10;
    private static final int CHUNK = 64 * 1024;

    /** 每片之间让一下路，给画面帧留点带宽 */
    private static final long YIELD_MS = 2;

    public interface Emitter {
        /** 一帧文件分片，已经套好 10 字节头 */
        void emitChunk(byte[] framed);
        void emitJson(JSONObject o);
    }

    private volatile boolean cancelled;
    private volatile Thread thread;

    public boolean isActive() {
        Thread t = thread;
        return t != null && t.isAlive();
    }

    public void cancel() {
        cancelled = true;
        Thread t = thread;
        if (t != null) t.interrupt();
    }

    /**
     * 起一个线程把文件推出去。会先 cancel 掉上一个，保证同一时刻只发一个文件。
     */
    public void start(final Context ctx, final MediaFileLister.Item item, final Emitter e) {
        cancel();
        cancelled = false;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                stream(ctx, item, e);
            }
        }, "ra-filesend");
        thread = t;
        t.start();
    }

    private void stream(Context ctx, MediaFileLister.Item item, Emitter e) {
        InputStream in = null;
        long sent = 0;
        try {
            JSONObject begin = new JSONObject();
            begin.put("t", "fbegin");
            begin.put("name", item.name);
            begin.put("size", item.size);     // 拿不到时为 0，控制端会放宽校验
            begin.put("mime", item.mime);
            e.emitJson(begin);

            in = ctx.getContentResolver().openInputStream(item.uri);
            if (in == null) throw new java.io.IOException("打不开这个文件（可能已被删除）");

            byte[] buf = new byte[CHUNK];
            int n;
            while (!cancelled && (n = in.read(buf)) > 0) {
                byte[] framed = new byte[FRAME_HEADER + n];
                framed[0] = (byte) KIND_FILE;
                framed[1] = 0;
                // pts 对文件没有意义，留 0
                System.arraycopy(buf, 0, framed, FRAME_HEADER, n);
                e.emitChunk(framed);
                sent += n;
                if (cancelled) break;
                try {
                    Thread.sleep(YIELD_MS);
                } catch (InterruptedException ie) {
                    break;
                }
            }

            JSONObject done = new JSONObject();
            done.put("t", "fdone");
            if (cancelled) {
                done.put("ok", false);
                done.put("msg", "已取消");
            } else if (item.size > 0 && sent != item.size) {
                // 读到的比媒体库记录少，说明文件被改过或者中途出错，如实报错
                done.put("ok", false);
                done.put("msg", "只读到 " + sent + " / " + item.size + " 字节");
            } else {
                done.put("ok", true);
                done.put("name", item.name);
            }
            e.emitJson(done);
            Log.i(TAG, "文件发送结束 " + item.name + " sent=" + sent + " expect=" + item.size);

        } catch (Throwable t) {
            Log.w(TAG, "发送文件失败: " + t);
            try {
                JSONObject done = new JSONObject();
                done.put("t", "fdone");
                done.put("ok", false);
                done.put("msg", String.valueOf(t.getMessage()));
                e.emitJson(done);
            } catch (Throwable ignored) {}
        } finally {
            if (in != null) try { in.close(); } catch (Throwable ignored) {}
            thread = null;
        }
    }
}
