package com.wb.remoteagent;

/**
 * 根据「每帧发送耗时」自适应调整目标码率。
 *
 * 背景：画面写入 socket 是阻塞的。网络变差时 write 会一直卡住，
 * 采集线程跟着停摆，结果就是画面彻底冻住且永远降不下来。
 * 这个类负责在卡住之前就把码率压下去，网络恢复后再慢慢升回来。
 *
 * 刻意不依赖任何 Android API —— 纯逻辑，可以用普通 javac + java 直接单测。
 * 见 test/java/com/wb/remoteagent/RateControllerTest.java
 */
public class RateController {

    public static final int LEVEL_POOR = 0;
    public static final int LEVEL_FAIR = 1;
    public static final int LEVEL_GOOD = 2;

    /** 连续多少次「拥挤」采样才降档 —— 抗单次抖动 */
    private static final int BAD_STREAK_TO_DROP = 2;
    /** 连续多少次「空闲」采样才升档 —— 升档比降档慢，避免来回震荡 */
    private static final int GOOD_STREAK_TO_RAISE = 8;
    /** 两次降档之间的最小间隔 */
    private static final long DROP_COOLDOWN_MS = 400L;
    /** 两次升档之间的最小间隔 */
    private static final long RAISE_COOLDOWN_MS = 1200L;

    private static final double EMA_ALPHA = 0.25;
    private static final double BUSY_RATIO = 0.85;   // 耗时超过帧间隔的 85% 算拥挤
    private static final double IDLE_RATIO = 0.35;   // 低于 35% 算空闲

    private final int minBitrate;
    private final int maxBitrate;

    private int ceiling;        // 用户选的画质上限
    private int target;         // 当前目标码率
    private double ema = -1;
    private int badStreak = 0;
    private int goodStreak = 0;
    private long lastChangeMs = Long.MIN_VALUE;
    private int changes = 0;

    public RateController(int minBitrate, int maxBitrate, int initialBitrate) {
        if (minBitrate < 1) minBitrate = 1;
        if (maxBitrate < minBitrate) maxBitrate = minBitrate;
        this.minBitrate = minBitrate;
        this.maxBitrate = maxBitrate;
        this.ceiling = clamp(initialBitrate);
        this.target = this.ceiling;
    }

    private int clamp(int bps) {
        if (bps < minBitrate) return minBitrate;
        if (bps > maxBitrate) return maxBitrate;
        return bps;
    }

    public int target() {
        return target;
    }

    public int ceiling() {
        return ceiling;
    }

    public int minBitrate() {
        return minBitrate;
    }

    public int changeCount() {
        return changes;
    }

    /** 控制端换了画质档位时调用。 */
    public void setCeiling(int bps) {
        ceiling = clamp(bps);
        if (target > ceiling) {
            target = ceiling;
            changes++;
        }
        if (target < minBitrate) target = minBitrate;
        badStreak = 0;
        goodStreak = 0;
        ema = -1;
    }

    /**
     * 喂一帧的发送耗时。
     *
     * @param sendMs          这一帧 write 花了多少毫秒
     * @param frameIntervalMs 当前目标帧间隔
     * @param nowMs           单调时钟（毫秒）
     * @return 码率发生变化时返回新的目标码率，否则返回 -1
     */
    public int onFrame(long sendMs, long frameIntervalMs, long nowMs) {
        if (frameIntervalMs < 1) frameIntervalMs = 1;

        double s = sendMs < 0 ? 0 : sendMs;
        ema = (ema < 0) ? s : (EMA_ALPHA * s + (1 - EMA_ALPHA) * ema);

        double busy = frameIntervalMs * BUSY_RATIO;
        double idle = frameIntervalMs * IDLE_RATIO;

        if (ema > busy) {
            badStreak++;
            goodStreak = 0;
        } else if (ema < idle) {
            goodStreak++;
            badStreak = 0;
        } else {
            badStreak = 0;
            goodStreak = 0;
        }

        int next = target;
        boolean neverChanged = (lastChangeMs == Long.MIN_VALUE);
        long since = neverChanged ? Long.MAX_VALUE : (nowMs - lastChangeMs);

        if (badStreak >= BAD_STREAK_TO_DROP && since >= DROP_COOLDOWN_MS) {
            next = (int) Math.max(minBitrate, Math.round(target * 0.75));
            badStreak = 0;
        } else if (goodStreak >= GOOD_STREAK_TO_RAISE && since >= RAISE_COOLDOWN_MS) {
            next = (int) Math.min(ceiling, Math.round(target * 1.15));
            goodStreak = 0;
        }

        if (next != target) {
            target = next;
            lastChangeMs = nowMs;
            changes++;
            return target;
        }
        return -1;
    }

    /** 给控制端显示用：当前码率相对用户设定上限的档位。 */
    public int level() {
        if (ceiling <= 0) return LEVEL_GOOD;
        double ratio = (double) target / ceiling;
        if (ratio >= 0.9) return LEVEL_GOOD;
        if (ratio >= 0.5) return LEVEL_FAIR;
        return LEVEL_POOR;
    }

    public static String levelName(int level) {
        switch (level) {
            case LEVEL_POOR: return "较差";
            case LEVEL_FAIR: return "一般";
            default: return "良好";
        }
    }
}
