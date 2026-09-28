package com.wb.remoteagent;

import android.util.Log;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 与中继服务器的 TCP 长连接。
 *
 * 帧格式：[4 字节大端长度][1 字节类型][负载]
 *   0x01 = JSON 文本（下行指令）
 *   0x02 = JPEG 二进制（上行画面）
 *
 * 断线自动重连，指数退避到 15 秒。
 *
 * 中继开了 TLS 时（tls=true）这一层就套在 TLS 里；帧格式完全不变，
 * 因为 TLS 握手在拿到 socket 之前就结束了，收发逻辑一个字都不用改。
 */
public class AgentConnection {

    public interface Listener {
        void onCommand(JSONObject cmd);

        /** 控制端发来的二进制分片（文件传输用） */
        void onBinary(byte[] data);

        void onState(boolean connected, String info);

        /**
         * TLS 首次连接（TOFU）学到的服务器证书指纹。
         * 实现方应该存下来，下次当 pin 用，这样第二次连接开始就是严格校验。
         * 默认空实现，老代码不用改。
         */
        default void onFingerprintLearned(String fingerprint) {}
    }

    private static final String TAG = "AgentConn";
    private static final int TYPE_JSON = 0x01;
    private static final int TYPE_BINARY = 0x02;
    private static final int MAX_FRAME = 1 << 20;   // 下行指令不该超过 1MB

    private final String host;
    private final int port;
    private final String room;
    private final String deviceName;
    private final Listener listener;

    /**
     * 被控端的工作模式，随 hello 一起报给中继，中继再转给控制端。
     *   "video"      有录屏，控制端能看到画面
     *   "unattended" 只跑无障碍指令、没有录屏（无人值守），控制端看到的是界面文字
     * null 时按 video 处理，老控制端不受影响。
     */
    private final String mode;

    /** 是否用 TLS 连接中继。false 时行为跟以前完全一样。 */
    private final boolean tls;
    /** 服务器证书指纹（pin）。可空；空时若开了 tls 就走 TOFU。 */
    private volatile String tlsPin;
    /** TOFU 是否允许。默认允许 —— 否则自签证书第一次就永远连不上。 */
    private final boolean tlsTofu;

    private volatile boolean running;
    private volatile Socket socket;
    private volatile OutputStream out;
    private final Object writeLock = new Object();
    private Thread thread;

    public AgentConnection(String host, int port, String room, String deviceName, Listener listener) {
        this(host, port, room, deviceName, null, listener);
    }

    public AgentConnection(String host, int port, String room, String deviceName,
                           String mode, Listener listener) {
        this(host, port, room, deviceName, mode, false, null, true, listener);
    }

    public AgentConnection(String host, int port, String room, String deviceName,
                           String mode, boolean tls, String tlsPin, boolean tlsTofu,
                           Listener listener) {
        this.host = host;
        this.port = port;
        this.room = room;
        this.deviceName = deviceName;
        this.mode = mode;
        this.tls = tls;
        this.tlsPin = AgentTls.normalize(tlsPin);
        this.tlsTofu = tlsTofu;
        this.listener = listener;
    }

    /** TOFU 之后把学到的指纹补上，让后续重连都走严格校验。 */
    public void setTlsPin(String pin) {
        this.tlsPin = AgentTls.normalize(pin);
    }

    public boolean isTls() {
        return tls;
    }

    public boolean isConnected() {
        Socket s = socket;
        return s != null && s.isConnected() && !s.isClosed() && out != null;
    }

    /**
     * 建连接。TLS 和非 TLS 只差这一处 —— 上层完全感知不到。
     */
    private Socket openSocket() throws Exception {
        if (!tls) {
            Socket s = new Socket();
            s.setTcpNoDelay(true);
            s.setKeepAlive(true);
            s.connect(new InetSocketAddress(host, port), 8000);
            return s;
        }

        SSLSocketFactory factory = AgentTls.factory(tlsPin, tlsTofu, fp -> {
            // 学到就先更新内存里的 pin，同一次会话的后续重连就不用再学一遍
            tlsPin = fp;
            if (listener != null) listener.onFingerprintLearned(fp);
        });
        SSLSocket s = (SSLSocket) factory.createSocket();
        s.setTcpNoDelay(true);
        s.setKeepAlive(true);
        AgentTls.applyProtocols(s);
        s.connect(new InetSocketAddress(host, port), 8000);
        s.startHandshake();   // 显式握手，证书有问题在这里就炸，而不是读到一半才炸
        return s;
    }

    public void start() {
        if (running) return;
        running = true;
        thread = new Thread(this::loop, "agent-conn");
        thread.setDaemon(true);
        thread.start();
    }

    public void stop() {
        running = false;
        closeQuietly();
        Thread t = thread;
        if (t != null) t.interrupt();
    }

    private void loop() {
        long backoff = 1000L;
        while (running) {
            Socket s = null;
            try {
                s = openSocket();

                JSONObject hello = new JSONObject();
                hello.put("t", "hello");
                hello.put("room", room);
                hello.put("name", deviceName);
                if (mode != null) hello.put("mode", mode);

                socket = s;
                out = s.getOutputStream();

                Log.i(TAG, "已连接 " + host + ":" + port + " room=" + room
                        + (tls ? " (TLS)" : " (明文)"));
                sendJson(hello);
                backoff = 1000L;
                if (listener != null) listener.onState(true, host + ":" + port);

                readLoop(s.getInputStream());
            } catch (Exception e) {
                if (running) {
                    if (tls) {
                        // TLS 失败几乎都是证书问题，把原因说清楚，别只丢一句 SSLException
                        Log.w(TAG, "TLS 连接失败: " + e);
                    } else {
                        Log.w(TAG, "连接中断: " + e);
                    }
                }
            } finally {
                socket = null;
                out = null;
                try { if (s != null) s.close(); } catch (IOException ignored) {}
            }

            if (!running) break;
            if (listener != null) listener.onState(false, "重连中…");
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                break;
            }
            backoff = Math.min(backoff * 2, 15000L);
        }
    }

    private void readLoop(InputStream in) throws IOException {
        byte[] head = new byte[5];
        while (running) {
            readFully(in, head, 5);
            int len = ((head[0] & 0xff) << 24) | ((head[1] & 0xff) << 16)
                    | ((head[2] & 0xff) << 8) | (head[3] & 0xff);
            int type = head[4] & 0xff;
            if (len < 0 || len > MAX_FRAME) throw new IOException("帧长度异常: " + len);

            byte[] payload = new byte[len];
            readFully(in, payload, len);

            if (type == TYPE_JSON && listener != null) {
                try {
                    listener.onCommand(new JSONObject(new String(payload, StandardCharsets.UTF_8)));
                } catch (Exception e) {
                    Log.w(TAG, "指令解析失败: " + e);
                }
            } else if (type == TYPE_BINARY && listener != null) {
                listener.onBinary(payload);
            }
        }
    }

    private static void readFully(InputStream in, byte[] buf, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) throw new IOException("连接已关闭");
            off += n;
        }
    }

    public void sendJson(JSONObject o) {
        sendPacket(o.toString().getBytes(StandardCharsets.UTF_8), TYPE_JSON);
    }

    public void sendFrame(byte[] jpeg) {
        sendPacket(jpeg, TYPE_BINARY);
    }

    /** 最近一次 sendFrame 的耗时（毫秒）。码率自适应靠它判断链路是否拥堵。 */
    private volatile long lastFrameSendMs;

    public long lastFrameSendMs() {
        return lastFrameSendMs;
    }

    private void sendPacket(byte[] payload, int type) {
        OutputStream o = out;
        if (o == null || payload == null) return;
        byte[] packet = new byte[5 + payload.length];
        packet[0] = (byte) (payload.length >>> 24);
        packet[1] = (byte) (payload.length >>> 16);
        packet[2] = (byte) (payload.length >>> 8);
        packet[3] = (byte) payload.length;
        packet[4] = (byte) type;
        System.arraycopy(payload, 0, packet, 5, payload.length);
        synchronized (writeLock) {
            long t0 = android.os.SystemClock.elapsedRealtime();
            try {
                o.write(packet);
                o.flush();
            } catch (IOException e) {
                closeQuietly();
            } finally {
                if (type == TYPE_BINARY) {
                    lastFrameSendMs = android.os.SystemClock.elapsedRealtime() - t0;
                }
            }
        }
    }

    private void closeQuietly() {
        Socket s = socket;
        if (s != null) {
            try { s.close(); } catch (IOException ignored) {}
        }
    }
}
