package com.wb.remoteagent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.view.Surface;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * 前台服务：采集屏幕 -> 编码 -> 上行；同时接收下行指令交给无障碍服务执行。
 *
 * 两种编码方式，可由控制端动态切换：
 *   MODE_JPEG  MediaProjection -> ImageReader -> 逐帧 JPEG（兼容性最好）
 *   MODE_H264  MediaProjection -> Surface -> MediaCodec 硬编 H.264（带宽约为 JPEG 的 1/5）
 *
 * 上行二进制帧格式（与控制端 h264-decoder.js 里的解析一一对应）：
 *   [0]      kind   0x01=JPEG  0x02=H.264
 *   [1]      flags  bit0=关键帧
 *   [2..9]   pts    大端 64 位微秒
 *   [10..]   payload
 */
public class CaptureService extends Service implements AgentConnection.Listener {

    private static final String TAG = "CaptureService";

    public static final String ACTION_START = "com.wb.remoteagent.START";
    public static final String ACTION_STOP = "com.wb.remoteagent.STOP";

    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";
    public static final String EXTRA_HOST = "host";
    public static final String EXTRA_PORT = "port";
    public static final String EXTRA_ROOM = "room";
    public static final String EXTRA_WIDTH = "width";
    public static final String EXTRA_FPS = "fps";
    public static final String EXTRA_QUALITY = "quality";
    public static final String EXTRA_BITRATE = "bitrate";
    public static final String EXTRA_CODEC = "codec";

    private static final String CHANNEL_ID = "remote-assist";
    private static final int NOTIF_ID = 0x51A1;

    private static final int MODE_JPEG = 0;
    private static final int MODE_H264 = 1;

    private static final byte KIND_JPEG = 0x01;
    private static final byte KIND_H264 = 0x02;

    private static final int FRAME_HEADER = 10;

    /* ---- 运行时状态 ---- */
    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private HandlerThread bgThread;
    private Handler bgHandler;

    private volatile AgentConnection conn;

    private Thread worker;
    private volatile boolean running;
    private volatile boolean needRestart;

    /* JPEG 通道 */
    private volatile ImageReader reader;

    /* H.264 通道 */
    private MediaCodec encoder;
    private Surface encoderSurface;
    private volatile byte[] avcC;
    private volatile String codecString;

    /**
     * 最近一个关键帧（avcC 格式），以及它的时间戳。
     *
     * 为什么要缓存：MediaProjection 只在「屏幕有变化」时才吐新帧。手机放在公司
     * 一直停在打卡页面不动，编码器就不再输出 —— 这时你从家里连上去，会看到一片空白，
     * 直到公司那台手机屏幕上有什么东西动了为止。缓存一个关键帧，新控制端一连上就补发，
     * 立刻能看到当前画面。
     */
    private volatile byte[] lastKeyFrame;
    private volatile long lastKeyFramePtsUs;

    /** 区分「我们自己调 projection.stop()」和「系统把录屏掐了」，见 onStop 回调。 */
    private volatile boolean stoppingByUs;

    /** 上次补发关键帧的时刻，用来给同一批控制端去重。 */
    private volatile long lastKeyFrameResendMs;

    /* 画质参数 */
    private volatile int targetWidth = 720;
    private volatile int targetFps = 12;
    private volatile int jpegQuality = 60;
    private volatile int bitrate = 1500000;
    private volatile int mode = MODE_H264;

    /** 网络自适应：按每帧发送耗时动态调码率 */
    private volatile RateController rate;
    private volatile int adaptiveJpegQuality = 60;
    private volatile long lastNetReportMs = 0;
    private volatile int lastReportedKbps = -1;

    /** 文件接收（控制端 -> 手机） */
    private FileReceiver fileReceiver;

    /** 文件发送（手机 -> 控制端） */
    private FileSender fileSender;

    private int realW = 1080, realH = 1920;
    private int capW = 720, capH = 1280;

    private DisplayManager displayManager;
    private DisplayManager.DisplayListener displayListener;

    /* ================= 生命周期 ================= */

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        bgThread = new HandlerThread("ra-bg");
        bgThread.start();
        bgHandler = new Handler(bgThread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopEverything();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
        String host = intent.getStringExtra(EXTRA_HOST);
        int port = intent.getIntExtra(EXTRA_PORT, 8081);
        String room = intent.getStringExtra(EXTRA_ROOM);
        targetWidth = intent.getIntExtra(EXTRA_WIDTH, 720);
        targetFps = intent.getIntExtra(EXTRA_FPS, 12);
        jpegQuality = intent.getIntExtra(EXTRA_QUALITY, 60);
        bitrate = intent.getIntExtra(EXTRA_BITRATE, 1500000);
        mode = "jpeg".equals(intent.getStringExtra(EXTRA_CODEC)) ? MODE_JPEG : MODE_H264;

        if (resultData == null || host == null || room == null) {
            Log.w(TAG, "启动参数不完整");
            stopSelf();
            return START_NOT_STICKY;
        }

        startForegroundCompat();

        if (running) {
            requestRebuild();   // 已经在跑，按新参数重建
            return START_STICKY;
        }

        startSession(resultCode, resultData, host, port, room);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopEverything();
        if (bgThread != null) bgThread.quitSafely();
        super.onDestroy();
    }

    /* ================= 通知 ================= */

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "远程协助进行中", NotificationManager.IMPORTANCE_LOW);
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
        b.setContentTitle("远程协助已开启")
                .setContentText("屏幕正在被共享，点此返回应用")
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setOngoing(true)
                .setContentIntent(pi);

        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
                return;
            } catch (Throwable e) {
                // 个别厂商 ROM 校验更严，退一步用无类型方式启动
                Log.w(TAG, "带类型启动前台服务失败，降级重试: " + e);
            }
        }
        startForeground(NOTIF_ID, n);
    }

    /* ================= 会话 ================= */

    private void startSession(int resultCode, Intent resultData, String host, int port, String room) {
        stoppingByUs = false;      // 新一轮会话，把上一次的收尾标记清掉
        MediaProjectionManager mpm =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) { stopSelf(); return; }

        try {
            projection = mpm.getMediaProjection(resultCode, resultData);
        } catch (Throwable e) {
            Log.w(TAG, "获取 MediaProjection 失败: " + e);
        }
        if (projection == null) {
            Log.w(TAG, "用户未授权录屏");
            stopSelf();
            return;
        }

        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                // 这个回调有两个来源，必须分清，否则日志会骗人：
                //   1) 我们自己 stopEverything() 里调 projection.stop() —— 正常收尾
                //   2) 系统主动掐掉（别的应用开始录屏、系统回收、用户撤销）—— 才是真意外
                // 之前两种情况都打「已被系统停止」，排查时被带偏过一次。
                if (stoppingByUs) {
                    Log.i(TAG, "MediaProjection 已按请求停止（我们自己收的尾）");
                    return;
                }
                Log.w(TAG, "MediaProjection 被系统停止 —— 可能别的应用开始录屏，或系统回收了它");
                stopEverything();
                stopSelf();
            }
        }, bgHandler);

        conn = new AgentConnection(host, port, room, Build.MANUFACTURER + " " + Build.MODEL,
                null,
                AgentTls.isEnabled(this), AgentTls.pinOf(this), AgentTls.tofuOf(this),
                this);
        conn.start();

        // 横竖屏切换会改变真实分辨率，必须重建，否则画面被拉伸
        try {
            displayManager = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
            if (displayManager != null) {
                displayListener = new DisplayManager.DisplayListener() {
                    @Override public void onDisplayAdded(int displayId) {}
                    @Override public void onDisplayRemoved(int displayId) {}
                    @Override public void onDisplayChanged(int displayId) {
                        if (displayId != android.view.Display.DEFAULT_DISPLAY) return;
                        Point p = ScreenInfo.getRealSize(CaptureService.this);
                        if (p.x != realW || p.y != realH) {
                            Log.i(TAG, "屏幕方向变化 -> 重建 " + p.x + "x" + p.y);
                            requestRebuild();
                        }
                    }
                };
                displayManager.registerDisplayListener(displayListener, bgHandler);
            }
        } catch (Throwable e) {
            Log.w(TAG, "注册显示监听失败: " + e);
        }

        running = true;
        rate = new RateController(250_000, 8_000_000, bitrate);
        adaptiveJpegQuality = jpegQuality;
        fileReceiver = new FileReceiver(this);
        fileSender = new FileSender();
        worker = new Thread(this::workerLoop, "ra-worker");
        worker.setDaemon(true);
        worker.start();
    }

    private long frameIntervalMs() {
        return Math.max(30L, 1000L / Math.max(1, targetFps));
    }

    /**
     * 按发送耗时调整码率。H.264 可以直接改编码器参数，不用重建管线；
     * JPEG 没有码率概念，就把目标码率的比例映射到压缩质量上。
     */
    private void adaptRate(long sendMs, long nowMs) {
        RateController rc = rate;
        if (rc == null) return;

        int changed = rc.onFrame(sendMs, frameIntervalMs(), nowMs);

        if (changed > 0 && mode == MODE_H264) {
            MediaCodec enc = encoder;
            if (enc != null) {
                try {
                    Bundle b = new Bundle();
                    b.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, changed);
                    enc.setParameters(b);
                    Log.i(TAG, "自适应码率 -> " + (changed / 1000) + " kbps");
                } catch (Throwable e) {
                    Log.d(TAG, "改码率失败: " + e);
                }
            }
        }

        // JPEG：把 target/ceiling 的比例映射到 30..用户设定值
        if (mode == MODE_JPEG && rc.ceiling() > 0) {
            double ratio = (double) rc.target() / rc.ceiling();
            int q = (int) Math.round(30 + ratio * Math.max(0, jpegQuality - 30));
            adaptiveJpegQuality = Math.max(25, Math.min(95, q));
        }

        // 每 2 秒或档位变化时同步给控制端
        if (nowMs - lastNetReportMs > 2000 || changed > 0) {
            int kbps = rc.target() / 1000;
            if (kbps != lastReportedKbps) {
                lastReportedKbps = kbps;
                lastNetReportMs = nowMs;
                try {
                    JSONObject o = new JSONObject();
                    o.put("t", "net");
                    o.put("kbps", kbps);
                    o.put("level", rc.level());
                    o.put("codec", mode == MODE_H264 ? "h264" : "jpeg");
                    AgentConnection c = conn;
                    if (c != null) c.sendJson(o);
                } catch (Throwable ignored) {}
            }
        }
    }

    private void requestRebuild() {
        needRestart = true;
        // 关掉采集端，让阻塞中的循环立刻醒来
        ImageReader r = reader;
        if (r != null) { try { r.close(); } catch (Throwable ignored) {} }
    }

    /* ================= 管线总管 ================= */

    private void workerLoop() {
        while (running) {
            needRestart = false;
            try {
                buildPipeline();
                if (mode == MODE_H264) drainH264(); else pumpJpeg();
            } catch (Throwable e) {
                Log.w(TAG, "管线异常: " + e);
            }
            releasePipeline();
            if (!running) break;
            SystemClock.sleep(needRestart ? 60 : 250);
        }
    }

    /** 按当前 mode / 画质参数建立一条管线。抛出的异常由 workerLoop 统一兜住。 */
    private void buildPipeline() throws Exception {
        Point real = ScreenInfo.getRealSize(this);
        realW = real.x;
        realH = real.y;

        int w = Math.min(Math.max(240, targetWidth), realW);
        int h = Math.round(w * realH / (float) realW);
        w &= ~15;                       // H.264 宏块对齐，顺手也避免了奇数宽高
        h &= ~15;
        if (w < 16 || h < 16) { w = 240; h = 426; }
        capW = w;
        capH = h;

        int dpi = getResources().getDisplayMetrics().densityDpi;

        if (mode == MODE_H264) {
            MediaFormat fmt = MediaFormat.createVideoFormat("video/avc", capW, capH);
            fmt.setInteger(MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            fmt.setInteger(MediaFormat.KEY_BIT_RATE, Math.max(200000, bitrate));
            fmt.setInteger(MediaFormat.KEY_FRAME_RATE, Math.max(1, targetFps));
            fmt.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);

            MediaCodec enc = null;
            try {
                fmt.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline);
                fmt.setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel41);
                enc = MediaCodec.createEncoderByType("video/avc");
                enc.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            } catch (Throwable e) {
                // 有些编码器不接受指定 profile/level，去掉再试一次
                Log.w(TAG, "指定 baseline profile 失败，改用默认: " + e);
                try { if (enc != null) { enc.release(); enc = null; } } catch (Throwable ignored) {}
                fmt = MediaFormat.createVideoFormat("video/avc", capW, capH);
                fmt.setInteger(MediaFormat.KEY_COLOR_FORMAT,
                        MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
                fmt.setInteger(MediaFormat.KEY_BIT_RATE, Math.max(200000, bitrate));
                fmt.setInteger(MediaFormat.KEY_FRAME_RATE, Math.max(1, targetFps));
                fmt.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
                enc = MediaCodec.createEncoderByType("video/avc");
                enc.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            }

            encoder = enc;
            encoderSurface = encoder.createInputSurface();
            encoder.start();

            virtualDisplay = projection.createVirtualDisplay(
                    "remote-assist", capW, capH, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    encoderSurface, null, bgHandler);

            Log.i(TAG, "H.264 管线 " + capW + "x" + capH + " @" + targetFps + "fps "
                    + (bitrate / 1000) + "kbps");
        } else {
            ImageReader r = ImageReader.newInstance(capW, capH, PixelFormat.RGBA_8888, 3);
            reader = r;
            virtualDisplay = projection.createVirtualDisplay(
                    "remote-assist", capW, capH, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    r.getSurface(), null, bgHandler);
            Log.i(TAG, "JPEG 管线 " + capW + "x" + capH + " @" + targetFps + "fps q" + jpegQuality);
        }

        sendMeta();
    }

    private void releasePipeline() {
        VirtualDisplay vd = virtualDisplay;
        virtualDisplay = null;
        if (vd != null) { try { vd.release(); } catch (Throwable ignored) {} }

        ImageReader r = reader;
        reader = null;
        if (r != null) { try { r.close(); } catch (Throwable ignored) {} }

        MediaCodec enc = encoder;
        encoder = null;
        if (enc != null) {
            try { enc.stop(); } catch (Throwable ignored) {}
            try { enc.release(); } catch (Throwable ignored) {}
        }
        Surface s = encoderSurface;
        encoderSurface = null;
        if (s != null) { try { s.release(); } catch (Throwable ignored) {} }

        // 管线没了，缓存的画面也就不代表「当前屏幕」了，必须清掉。
        // 否则重建后（旋转/改画质/换编码）会拿旧尺寸的关键帧去喂新解码器。
        lastKeyFrame = null;
        lastKeyFramePtsUs = 0;
        lastKeyFrameResendMs = 0;
        avcC = null;
        codecString = null;
    }

    /* ================= H.264 采集 ================= */

    private void drainH264() {
        MediaCodec enc = encoder;
        if (enc == null) return;

        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long lastSyncReq = 0;

        while (running && !needRestart) {
            int idx;
            try {
                idx = enc.dequeueOutputBuffer(info, 100000);   // 100ms
            } catch (Throwable e) {
                Log.d(TAG, "dequeue 异常: " + e);
                return;
            }

            if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                onEncoderFormatChanged(enc.getOutputFormat());
                continue;
            }
            if (idx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                // 画面静止时编码器可能长时间没输出，定期要一个关键帧，
                // 保证中途加入的控制端能立刻看到画面
                long now = SystemClock.elapsedRealtime();
                if (now - lastSyncReq > 2000) {
                    requestSyncFrame(enc);
                    lastSyncReq = now;
                }
                continue;
            }
            if (idx < 0) continue;

            try {
                ByteBuffer bb = enc.getOutputBuffer(idx);
                if (bb != null && info.size > 0
                        && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                    bb.position(info.offset);
                    bb.limit(info.offset + info.size);
                    byte[] annexB = new byte[info.size];
                    bb.get(annexB);

                    byte[] avcc = annexBToAvcc(annexB, 0, annexB.length);
                    if (avcc.length > 0) {
                        boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                        if (key) {
                            // 留着，给后面才连上来的控制端补发
                            lastKeyFrame = avcc;
                            lastKeyFramePtsUs = info.presentationTimeUs;
                        }
                        sendFrame(KIND_H264, key, info.presentationTimeUs, avcc);
                        AgentConnection c = conn;
                        if (c != null) adaptRate(c.lastFrameSendMs(), SystemClock.elapsedRealtime());
                    }
                }
            } catch (Throwable e) {
                Log.d(TAG, "取编码结果失败: " + e);
            } finally {
                try { enc.releaseOutputBuffer(idx, false); } catch (Throwable ignored) {}
            }

            long now = SystemClock.elapsedRealtime();
            if (now - lastSyncReq > 2000) {
                requestSyncFrame(enc);
                lastSyncReq = now;
            }
        }
    }

    private void requestSyncFrame(MediaCodec enc) {
        try {
            Bundle b = new Bundle();
            b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            enc.setParameters(b);
        } catch (Throwable ignored) {}
    }

    private void onEncoderFormatChanged(MediaFormat fmt) {
        try {
            byte[] sps = findNal(fmt.getByteBuffer("csd-0"), 7);
            byte[] pps = findNal(fmt.getByteBuffer("csd-1"), 8);
            if (sps == null || pps == null || sps.length < 4) {
                Log.w(TAG, "拿不到 SPS/PPS，无法生成 avcC");
                return;
            }
            byte[] cfg = buildAvcC(sps, pps);
            avcC = cfg;
            codecString = AvcC.codecString(sps);
            // 换了编码参数，旧的关键帧跟新的 vcfg 不匹配，丢掉重来
            lastKeyFrame = null;
            Log.i(TAG, "编码参数 " + codecString + "  avcC " + cfg.length + " 字节");
            sendVideoConfig();
        } catch (Throwable e) {
            Log.w(TAG, "解析编码参数失败: " + e);
        }
    }

    private void sendVideoConfig() {
        byte[] cfg = avcC;
        String cs = codecString;
        if (cfg == null || cs == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("t", "vcfg");
            o.put("codec", cs);
            o.put("desc", Base64.encodeToString(cfg, Base64.NO_WRAP));
            o.put("w", capW);
            o.put("h", capH);
            AgentConnection c = conn;
            if (c != null) c.sendJson(o);
        } catch (Throwable ignored) {}
    }

    /**
     * 把缓存的关键帧补发给刚连上来的控制端。
     *
     * 必须排在 vcfg 之后发，解码器要先拿到 description 才能解关键帧。
     * 屏幕静止时这是唯一能让新控制端看到画面的手段。
     */
    private void resendKeyFrame() {
        byte[] kf = lastKeyFrame;
        if (kf == null || mode != MODE_H264) return;

        // 控制端连上来会触发两次：中继的 controller-joined，以及它自己发的 codec 请求。
        // 一个 65KB 的关键帧没必要在流量卡上发两遍，短时间内只认第一次。
        long now = SystemClock.elapsedRealtime();
        if (now - lastKeyFrameResendMs < 1500) return;
        lastKeyFrameResendMs = now;

        try {
            sendFrame(KIND_H264, true, lastKeyFramePtsUs, kf);
            Log.i(TAG, "补发关键帧 " + kf.length + " 字节给新控制端");
        } catch (Throwable e) {
            Log.d(TAG, "补发关键帧失败: " + e);
        }
    }

    /** 新控制端进来时，把「我是谁 / 什么尺寸 / 怎么解码 / 当前画面」一次性给它。 */
    private void syncNewController() {
        sendMeta();
        if (mode == MODE_H264 && avcC != null) sendVideoConfig();
        resendKeyFrame();
    }

    /* ================= JPEG 采集 ================= */

    private void pumpJpeg() {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(128 * 1024);
        Bitmap padded = null;
        Bitmap cropped = null;
        Canvas cropCanvas = null;
        int paddedW = 0;

        while (running && !needRestart) {
            ImageReader r = reader;
            if (r == null) { SystemClock.sleep(100); continue; }

            long t0 = SystemClock.elapsedRealtime();
            Image img = null;
            try {
                img = r.acquireLatestImage();
                if (img == null) continue;

                Image.Plane[] planes = img.getPlanes();
                if (planes == null || planes.length == 0) continue;
                Image.Plane plane = planes[0];
                int pixelStride = plane.getPixelStride();
                int rowStride = plane.getRowStride();
                if (pixelStride <= 0) continue;

                int rowPadding = rowStride - pixelStride * capW;
                int bw = capW + rowPadding / pixelStride;

                ByteBuffer buf = plane.getBuffer();
                buf.rewind();                       // 必须回绕，否则第二帧开始读到的是空

                if (padded == null || paddedW != bw) {
                    if (padded != null) padded.recycle();
                    padded = Bitmap.createBitmap(bw, capH, Bitmap.Config.ARGB_8888);
                    paddedW = bw;
                }
                padded.copyPixelsFromBuffer(buf);

                Bitmap frame;
                if (rowPadding == 0) {
                    frame = padded;
                } else {
                    if (cropped == null) {
                        cropped = Bitmap.createBitmap(capW, capH, Bitmap.Config.ARGB_8888);
                        cropCanvas = new Canvas(cropped);
                    }
                    cropCanvas.drawBitmap(padded, 0f, 0f, null);
                    frame = cropped;
                }

                bos.reset();
                frame.compress(Bitmap.CompressFormat.JPEG, adaptiveJpegQuality, bos);
                sendFrame(KIND_JPEG, false, SystemClock.elapsedRealtime() * 1000, bos.toByteArray());
                AgentConnection c = conn;
                if (c != null) adaptRate(c.lastFrameSendMs(), SystemClock.elapsedRealtime());
            } catch (Throwable e) {
                Log.d(TAG, "采集重试: " + e);
                SystemClock.sleep(60);
            } finally {
                if (img != null) { try { img.close(); } catch (Throwable ignored) {} }
            }

            long wait = frameIntervalMs() - (SystemClock.elapsedRealtime() - t0);
            if (wait > 0) SystemClock.sleep(wait);
        }

        if (padded != null) padded.recycle();
        if (cropped != null) cropped.recycle();
    }

    /* ================= 帧封装与 NAL 处理 ================= */

    private void sendFrame(byte kind, boolean key, long ptsUs, byte[] payload) {
        AgentConnection c = conn;
        if (c == null || payload == null || payload.length == 0) return;

        byte[] out = new byte[FRAME_HEADER + payload.length];
        out[0] = kind;
        out[1] = (byte) (key ? 1 : 0);
        out[2] = (byte) (ptsUs >>> 56);
        out[3] = (byte) (ptsUs >>> 48);
        out[4] = (byte) (ptsUs >>> 40);
        out[5] = (byte) (ptsUs >>> 32);
        out[6] = (byte) (ptsUs >>> 24);
        out[7] = (byte) (ptsUs >>> 16);
        out[8] = (byte) (ptsUs >>> 8);
        out[9] = (byte) ptsUs;
        System.arraycopy(payload, 0, out, FRAME_HEADER, payload.length);
        c.sendFrame(out);
    }

    /** 从 CSD 里取出指定类型的第一个 NAL（自动剥掉起始码）。 */
    private static byte[] findNal(ByteBuffer csd, int wantType) {
        if (csd == null) return null;
        ByteBuffer b = csd.duplicate();
        b.rewind();
        byte[] raw = new byte[b.remaining()];
        b.get(raw);
        List<byte[]> nals = splitAnnexB(raw, 0, raw.length);
        for (byte[] nal : nals) {
            if (nal.length > 0 && (nal[0] & 0x1F) == wantType) return nal;
        }
        if (!nals.isEmpty()) return nals.get(0);        // 有起始码但类型对不上，退而求其次
        if (raw.length > 0) return raw;                 // 没有起始码：整个 buffer 就是一个 NAL
        return null;
    }

    /** 按 Annex-B 起始码切出 NAL 单元（去掉起始码和尾部的零填充）。 */
    private static List<byte[]> splitAnnexB(byte[] d, int off, int len) {
        List<byte[]> out = new ArrayList<>();
        int end = off + len;
        int i = off;
        int nalStart = -1;

        while (i < end) {
            boolean sc3 = (i + 3 <= end) && d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1;
            boolean sc4 = (i + 4 <= end) && d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 0 && d[i + 3] == 1;
            if (sc3 || sc4) {
                if (nalStart >= 0) addNal(out, d, nalStart, i);
                i += sc3 ? 3 : 4;
                nalStart = i;
            } else {
                i++;
            }
        }
        if (nalStart >= 0) addNal(out, d, nalStart, end);
        return out;
    }

    private static void addNal(List<byte[]> out, byte[] d, int start, int end) {
        while (end > start && d[end - 1] == 0) end--;   // 去掉 trailing_zero_8bits
        if (end > start) {
            byte[] nal = new byte[end - start];
            System.arraycopy(d, start, nal, 0, nal.length);
            out.add(nal);
        }
    }

    /**
     * MediaCodec 输出的是 Annex-B（00 00 00 01 起始码），
     * 而 WebCodecs 在带 avcC description 时要求 4 字节长度前缀，这里做转换。
     */
    private static byte[] annexBToAvcc(byte[] d, int off, int len) {
        List<byte[]> nals = splitAnnexB(d, off, len);
        if (nals.isEmpty()) {
            // 没有起始码，可能本来就已经是长度前缀格式，原样透传
            return java.util.Arrays.copyOfRange(d, off, off + len);
        }
        int total = 0;
        for (byte[] n : nals) total += 4 + n.length;
        byte[] out = new byte[total];
        int p = 0;
        for (byte[] n : nals) {
            out[p] = (byte) (n.length >>> 24);
            out[p + 1] = (byte) (n.length >>> 16);
            out[p + 2] = (byte) (n.length >>> 8);
            out[p + 3] = (byte) n.length;
            System.arraycopy(n, 0, out, p + 4, n.length);
            p += 4 + n.length;
        }
        return out;
    }

    /** avcC 的拼装挪到了 AvcC.java —— 纯逻辑、可单测，见 AvcCTest。 */
    private static byte[] buildAvcC(byte[] sps, byte[] pps) {
        return AvcC.build(sps, pps);
    }

    /* ================= 下行指令 ================= */

    @Override
    public void onCommand(JSONObject cmd) {
        String t = cmd.optString("t");
        RemoteAccessibilityService a11y = RemoteAccessibilityService.get();

        if ("controller-joined".equals(t)) {
            // 中继告诉我们有新控制端进来了。屏幕静止时它自己不会等到任何帧，
            // 所以这里主动把 meta / 解码配置 / 当前画面补过去。
            syncNewController();

        } else if ("tap".equals(t)) {
            if (a11y != null) a11y.tap((float) cmd.optDouble("x", 0), (float) cmd.optDouble("y", 0));

        } else if ("long".equals(t)) {
            if (a11y != null) a11y.longPress((float) cmd.optDouble("x", 0), (float) cmd.optDouble("y", 0));

        } else if ("swipe".equals(t)) {
            if (a11y != null) {
                a11y.swipe((float) cmd.optDouble("x1", 0), (float) cmd.optDouble("y1", 0),
                        (float) cmd.optDouble("x2", 0), (float) cmd.optDouble("y2", 0),
                        (long) cmd.optDouble("d", 300));
            }

        } else if ("key".equals(t)) {
            String k = cmd.optString("k");
            if (a11y == null) return;
            if ("enter".equals(k)) a11y.imeEnter();
            else a11y.globalKey(k);

        } else if ("text".equals(t)) {
            boolean ok = a11y != null && a11y.inputText(cmd.optString("s"));
            if (!ok) sendStatus("写不进文字：先在被控手机上点一下输入框，并确认无障碍服务已开启");

        } else if ("launch".equals(t)) {
            String pkg = cmd.optString("pkg");
            boolean ok = a11y != null && a11y.launchApp(pkg);
            if (!ok) sendStatus("打开失败：" + pkg);

        } else if ("apps".equals(t)) {
            try {
                JSONObject out = new JSONObject();
                out.put("t", "apps");
                out.put("list", AppCatalog.listLaunchable(this));
                AgentConnection c = conn;
                if (c != null) c.sendJson(out);
            } catch (Throwable e) {
                Log.w(TAG, "取应用列表失败: " + e);
            }

        } else if ("codec".equals(t)) {
            int want = "h264".equalsIgnoreCase(cmd.optString("v")) ? MODE_H264 : MODE_JPEG;
            if (want != mode) {
                mode = want;
                RateController rc = rate;
                if (rc != null) rc.setCeiling(bitrate);   // 换编码后重新开始观察
                requestRebuild();
            } else if (want == MODE_H264 && avcC != null) {
                // 已在 H.264 模式，新来的控制端要一份配置 + 当前画面
                sendVideoConfig();
                resendKeyFrame();
            }

        } else if ("quality".equals(t)) {
            targetWidth = cmd.optInt("w", targetWidth);
            targetFps = cmd.optInt("fps", targetFps);
            jpegQuality = cmd.optInt("q", jpegQuality);
            bitrate = cmd.optInt("br", bitrate);
            adaptiveJpegQuality = jpegQuality;
            RateController rc = rate;
            if (rc != null) rc.setCeiling(bitrate);
            requestRebuild();

        } else if ("clip".equals(t)) {
            String v = cmd.optString("v", "");
            boolean ok = a11y != null && a11y.setClipboard(v);
            if (ok && cmd.optBoolean("paste", false)) {
                if (a11y != null) a11y.pasteIntoFocus();
            }
            if (!ok) sendStatus("写入剪贴板失败");

        } else if ("clipget".equals(t)) {
            String text = null;
            String src = "none";
            if (a11y != null) {
                text = a11y.readClipboard();
                if (text != null) {
                    src = "clipboard";
                } else {
                    text = a11y.readFocusedText();
                    if (text != null) src = "focused";
                }
            }
            try {
                JSONObject o = new JSONObject();
                o.put("t", "clip");
                o.put("src", src);
                o.put("v", text == null ? "" : text);
                AgentConnection c = conn;
                if (c != null) c.sendJson(o);
            } catch (Throwable ignored) {}

        } else if ("fstart".equals(t)) {
            try {
                String where = fileReceiver.start(
                        cmd.optString("name"), cmd.optLong("size", -1), cmd.optString("mime"));
                sendStatus("开始接收 " + cmd.optString("name") + " -> " + where);
            } catch (Throwable e) {
                Log.w(TAG, "开始接收文件失败: " + e);
                sendStatus("接收文件失败：" + e.getMessage());
            }

        } else if ("fend".equals(t)) {
            try {
                String where = fileReceiver.finish();
                sendStatus("已保存到 " + where + "（" + fileReceiver.written() + " 字节）");
            } catch (Throwable e) {
                sendStatus("保存失败：" + e.getMessage());
            }

        } else if ("fcancel".equals(t)) {
            fileReceiver.abort();
            sendStatus("已取消接收");

        } else if ("flist".equals(t)) {
            // 查媒体库是读盘，别堵住指令线程
            new Thread(() -> {
                try {
                    java.util.List<MediaFileLister.Item> items = MediaFileLister.list(this);
                    org.json.JSONArray arr = new org.json.JSONArray();
                    for (MediaFileLister.Item it : items) {
                        org.json.JSONObject o = new org.json.JSONObject();
                        o.put("id", it.id);
                        o.put("name", it.name);
                        o.put("size", it.size);
                        o.put("kind", it.kind);
                        o.put("mime", it.mime);
                        o.put("date", it.date);
                        arr.put(o);
                    }
                    org.json.JSONObject o = new org.json.JSONObject();
                    o.put("t", "flist");
                    o.put("items", arr);
                    if (items.isEmpty()) o.put("note", MediaFileLister.emptyNote(this));
                    AgentConnection c = conn;
                    if (c != null) c.sendJson(o);
                } catch (Throwable e) {
                    Log.w(TAG, "列文件失败: " + e);
                    sendFdone(false, "列文件失败：" + e.getMessage());
                }
            }, "ra-flist").start();

        } else if ("fget".equals(t)) {
            final String id = cmd.optString("id");
            new Thread(() -> {
                MediaFileLister.Item it = MediaFileLister.find(this, id);
                if (it == null) {
                    sendFdone(false, "找不到这个文件，或被控端没有读取媒体库的权限");
                    return;
                }
                FileSender fs = fileSender;
                if (fs == null) return;
                fs.start(this, it, new FileSender.Emitter() {
                    @Override
                    public void emitChunk(byte[] framed) {
                        AgentConnection c = conn;
                        if (c != null) c.sendFrame(framed);
                    }
                    @Override
                    public void emitJson(org.json.JSONObject o) {
                        AgentConnection c = conn;
                        if (c != null) c.sendJson(o);
                    }
                });
            }, "ra-fget").start();
        }
    }

    private void sendFdone(boolean ok, String msg) {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("t", "fdone");
            o.put("ok", ok);
            if (msg != null) o.put("msg", msg);
            AgentConnection c = conn;
            if (c != null) c.sendJson(o);
        } catch (Throwable ignored) {}
    }

    /** 控制端发来的二进制：只有文件分片一种，交给 FileReceiver 落盘。 */
    @Override
    public void onBinary(byte[] data) {
        FileReceiver fr = fileReceiver;
        if (fr == null || data == null || data.length == 0) return;
        if (!fr.isActive()) return;
        try {
            fr.chunk(data);
        } catch (Throwable e) {
            Log.w(TAG, "写文件分片失败: " + e);
            fr.abort();
            sendStatus("接收中断：" + e.getMessage());
        }
    }

    private void sendStatus(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("t", "status");
            o.put("msg", msg);
            AgentConnection c = conn;
            if (c != null) c.sendJson(o);
        } catch (Throwable ignored) {}
    }

    private void sendMeta() {
        try {
            JSONObject o = new JSONObject();
            o.put("t", "meta");
            o.put("w", capW);
            o.put("h", capH);
            o.put("sw", realW);
            o.put("sh", realH);
            o.put("codec", mode == MODE_H264 ? "h264" : "jpeg");
            o.put("name", Build.MANUFACTURER + " " + Build.MODEL);
            AgentConnection c = conn;
            if (c != null) c.sendJson(o);
        } catch (Throwable ignored) {}
    }

    @Override
    public void onState(boolean connected, String info) {
        if (!connected) return;
        // 刚连上（或重连）时把尺寸和编码参数推过去
        sendMeta();
        if (mode == MODE_H264 && avcC != null) sendVideoConfig();
    }

    @Override
    public void onFingerprintLearned(String fingerprint) {
        // 自签证书第一次连接（TOFU）。存下来，之后每次连接都会严格比对。
        AgentTls.saveLearnedPin(this, fingerprint);
        if (conn != null) conn.setTlsPin(fingerprint);
    }

    /* ================= 收尾 ================= */

    private void stopEverything() {
        running = false;
        needRestart = true;

        try {
            if (displayManager != null && displayListener != null) {
                displayManager.unregisterDisplayListener(displayListener);
            }
        } catch (Throwable ignored) {}
        displayListener = null;

        requestRebuild();          // 唤醒阻塞中的循环

        Thread w = worker;
        worker = null;
        if (w != null) {
            try { w.join(1200); } catch (InterruptedException ignored) {}
        }

        AgentConnection c = conn;
        conn = null;
        if (c != null) c.stop();

        if (fileReceiver != null) fileReceiver.abort();
        if (fileSender != null) fileSender.cancel();

        releasePipeline();
        // 先立旗子再 stop()：stop() 会同步回调 onStop()，不立旗子就会被当成「系统停的」，
        // 而且会再进一次 stopEverything()（projection 此时还没置 null）。
        stoppingByUs = true;
        try { if (projection != null) projection.stop(); } catch (Throwable ignored) {}
        projection = null;
    }
}
