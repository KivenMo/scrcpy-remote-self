package com.wb.remoteagent;

/**
 * RateController 的单元测试。纯逻辑，不依赖 Android。
 *
 * 跑法（不需要 Gradle、不需要模拟器）：
 *   cd android-agent
 *   javac -d build/test \
 *     app/src/main/java/com/wb/remoteagent/RateController.java \
 *     app/src/test/java/com/wb/remoteagent/RateControllerTest.java
 *   java -Dstdout.encoding=UTF-8 -cp build/test com.wb.remoteagent.RateControllerTest
 *
 * 注意 -Dstdout.encoding=UTF-8：Windows 控制台默认用 GBK 编码，
 * 打不出 ✓ 会变成 ?。这个开关只影响显示，不影响测试结果。
 */
public class RateControllerTest {

    private static int pass = 0;
    private static int fail = 0;

    private static void check(String name, boolean cond, String detail) {
        if (cond) {
            pass++;
            System.out.println("  \u2713 " + name);
        } else {
            fail++;
            System.out.println("  \u2717 " + name + (detail == null ? "" : "  -> " + detail));
        }
    }

    private static void eq(String name, long expected, long actual) {
        check(name, expected == actual, "期望 " + expected + "，实际 " + actual);
    }

    /** 喂 n 帧，每帧耗时 sendMs，帧间隔 interval，时钟每次前进 interval */
    private static void feed(RateController rc, int n, long sendMs, long interval, long[] clock) {
        for (int i = 0; i < n; i++) {
            clock[0] += interval;
            rc.onFrame(sendMs, interval, clock[0]);
        }
    }

    public static void main(String[] args) {
        System.out.println("RateController 单元测试\n");

        /* ---------- 1. 初始状态 ---------- */
        System.out.println("[1] 初始状态");
        RateController rc = new RateController(250_000, 8_000_000, 1_500_000);
        eq("初始码率等于设定上限", 1_500_000, rc.target());
        eq("初始档位为良好", RateController.LEVEL_GOOD, rc.level());
        eq("初始没发生过调整", 0, rc.changeCount());

        /* ---------- 2. 网络拥挤 -> 降码率 ---------- */
        System.out.println("\n[2] 持续拥挤时降码率");
        rc = new RateController(250_000, 8_000_000, 1_500_000);
        long[] clock = {0};
        // 帧间隔 83ms（12fps），每帧发 90ms，明显超预算
        feed(rc, 60, 90, 83, clock);
        check("码率被压下来了", rc.target() < 1_500_000, "当前 " + rc.target());
        check("档位变成较差或一般", rc.level() <= RateController.LEVEL_FAIR,
                "当前档位 " + RateController.levelName(rc.level()));
        check("发生了多次调整", rc.changeCount() >= 2, "调整 " + rc.changeCount() + " 次");

        /* ---------- 3. 一直拥挤也不会跌破下限 ---------- */
        System.out.println("\n[3] 下限保护");
        rc = new RateController(250_000, 8_000_000, 1_500_000);
        clock[0] = 0;
        feed(rc, 400, 500, 83, clock);      // 极端拥挤
        check("不会跌破最小码率", rc.target() >= 250_000, "当前 " + rc.target());
        eq("正好停在下限", 250_000, rc.target());
        eq("档位为较差", RateController.LEVEL_POOR, rc.level());

        /* ---------- 4. 网络恢复 -> 升回去 ---------- */
        System.out.println("\n[4] 网络恢复后升回来");
        rc = new RateController(250_000, 8_000_000, 1_500_000);
        clock[0] = 0;
        feed(rc, 200, 300, 83, clock);      // 先打到下限
        int lowest = rc.target();
        eq("已打到下限", 250_000, lowest);
        feed(rc, 400, 1, 83, clock);        // 网络变好
        check("码率回升了", rc.target() > lowest, "从 " + lowest + " 升到 " + rc.target());
        eq("最终回到设定上限", 1_500_000, rc.target());

        /* ---------- 5. 上限不会被突破 ---------- */
        System.out.println("\n[5] 上限保护");
        rc = new RateController(250_000, 8_000_000, 1_500_000);
        clock[0] = 0;
        feed(rc, 500, 0, 83, clock);
        eq("不会超过设定上限", 1_500_000, rc.target());

        /* ---------- 6. 单次抖动不该降档 ---------- */
        System.out.println("\n[6] 抗单次抖动");
        rc = new RateController(250_000, 8_000_000, 1_500_000);
        clock[0] = 0;
        clock[0] += 83;
        rc.onFrame(500, 83, clock[0]);      // 一次很长的卡顿
        eq("一帧抖动不降档", 1_500_000, rc.target());
        clock[0] += 83;
        rc.onFrame(500, 83, clock[0]);      // 连续第二次
        check("连续两帧才降档", rc.target() < 1_500_000, "当前 " + rc.target());

        /* ---------- 7. 降档比升档快 ---------- */
        System.out.println("\n[7] 降档快、升档慢（避免震荡）");
        RateController a = new RateController(250_000, 8_000_000, 1_500_000);
        long[] c1 = {0};
        feed(a, 10, 200, 83, c1);
        int dropped = 1_500_000 - a.target();

        RateController b = new RateController(250_000, 8_000_000, 1_500_000);
        long[] c2 = {0};
        feed(b, 200, 300, 83, c2);          // 先压到底
        int floorVal = b.target();
        feed(b, 10, 1, 83, c2);             // 再给 10 帧好网络
        int raised = b.target() - floorVal;

        check("同样帧数下，降的幅度大于升的幅度",
                dropped > raised, "降 " + dropped + "，升 " + raised);

        /* ---------- 8. 换画质档位立刻生效 ---------- */
        System.out.println("\n[8] 换画质档位");
        rc = new RateController(250_000, 8_000_000, 3_000_000);
        eq("初始 3Mbps", 3_000_000, rc.target());
        rc.setCeiling(800_000);
        eq("降到新上限", 800_000, rc.target());
        eq("上限已更新", 800_000, rc.ceiling());

        rc.setCeiling(20_000_000);
        eq("上限被夹到最大值", 8_000_000, rc.ceiling());
        eq("码率不会凭空跳到新上限", 800_000, rc.target());

        /* ---------- 9. 参数边界 ---------- */
        System.out.println("\n[9] 参数边界");
        rc = new RateController(500_000, 100_000, 300_000);   // max < min，畸形输入
        check("畸形输入不会崩", rc.target() >= 1, "当前 " + rc.target());
        check("上下限被理顺", rc.ceiling() >= rc.minBitrate(), "");

        rc = new RateController(250_000, 8_000_000, 1_500_000);
        clock[0] = 0;
        rc.onFrame(50, 0, clock[0]);        // 帧间隔为 0
        check("帧间隔为 0 不崩", true, "");

        System.out.println("\n────────────────────────");
        System.out.println("通过 " + pass + " 项，失败 " + fail + " 项");
        if (fail > 0) System.exit(1);
    }
}
