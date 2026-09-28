package com.wb.remoteagent;

/**
 * AvcC 的单元测试。纯字节操作，不依赖 Android。
 *
 * 起因是一个真机上才暴露的 bug：avcC 的长度少算了 1 个字节。
 * 华为 P30 Pro（Android 10）的编码器给 17 字节 SPS + 4 字节 PPS，
 * 于是 System.arraycopy 越界，onEncoderFormatChanged 抛 ArrayIndexOutOfBounds，
 * 被 catch 吞掉只打了行 warning —— 表现是「连得上、但永远没有画面」。
 * 之前的测试全绿，是因为没有任何一条测试碰过这段代码。
 *
 * 跑法（不需要 Gradle、不需要模拟器）：
 *   cd android-agent
 *   javac -d build/test \
 *     app/src/main/java/com/wb/remoteagent/AvcC.java \
 *     app/src/test/java/com/wb/remoteagent/AvcCTest.java
 *   java -Dstdout.encoding=UTF-8 -cp build/test com.wb.remoteagent.AvcCTest
 *
 * 注意 -Dstdout.encoding=UTF-8：Windows 控制台默认 GBK，✓ 会打成 ?。
 */
public class AvcCTest {

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

    /** 造一个 SPS：首字节是 NAL 头（0x67 = SPS），后面 profile/compat/level + 填充。 */
    private static byte[] makeSps(int len) {
        byte[] s = new byte[len];
        s[0] = 0x67;          // NAL header: forbidden_zero=0, nal_ref_idc=3, type=7
        s[1] = 0x42;          // baseline profile
        s[2] = (byte) 0xC0;   // compatibility
        s[3] = 0x1F;          // level 3.1
        for (int i = 4; i < len; i++) s[i] = (byte) (0xA0 + i);
        return s;
    }

    private static byte[] makePps(int len) {
        byte[] p = new byte[len];
        p[0] = 0x68;          // NAL header: type=8
        for (int i = 1; i < len; i++) p[i] = (byte) (0xB0 + i);
        return p;
    }

    public static void main(String[] args) {
        System.out.println("AvcCTest");

        /* ---------- 1. 真机踩中的那一组尺寸 ---------- */
        System.out.println("\n[1] 真机尺寸 SPS=17 PPS=4（华为 P30 Pro 实际值）");
        byte[] sps17 = makeSps(17);
        byte[] pps4 = makePps(4);
        byte[] cfg = null;
        try {
            cfg = AvcC.build(sps17, pps4);
            check("不再抛异常", true, null);
        } catch (Throwable e) {
            check("不再抛异常", false, e.toString());
        }
        if (cfg != null) {
            eq("总长度 = 11 + 17 + 4 = 32", 32, cfg.length);
            eq("configurationVersion", 1, cfg[0] & 0xFF);
            eq("AVCProfileIndication = sps[1]", 0x42, cfg[1] & 0xFF);
            eq("profile_compatibility = sps[2]", 0xC0, cfg[2] & 0xFF);
            eq("AVCLevelIndication = sps[3]", 0x1F, cfg[3] & 0xFF);
            eq("lengthSizeMinusOne 低两位 = 3", 3, cfg[4] & 0x03);
            eq("numOfSequenceParameterSets = 1", 1, cfg[5] & 0x1F);
            eq("SPS 长度高字节", 0, cfg[6] & 0xFF);
            eq("SPS 长度低字节", 17, cfg[7] & 0xFF);
            eq("SPS 首字节落到 offset 8", 0x67, cfg[8] & 0xFF);
            eq("SPS 末字节落到 offset 24", sps17[16] & 0xFF, cfg[24] & 0xFF);
            eq("numOfPictureParameterSets = 1", 1, cfg[25] & 0xFF);
            eq("PPS 长度高字节", 0, cfg[26] & 0xFF);
            eq("PPS 长度低字节", 4, cfg[27] & 0xFF);
            eq("PPS 首字节落到 offset 28", 0x68, cfg[28] & 0xFF);
            eq("PPS 末字节就是数组末字节", pps4[3] & 0xFF, cfg[31] & 0xFF);
        }

        /* ---------- 2. 各种尺寸都不能越界 ---------- */
        System.out.println("\n[2] 遍历尺寸，长度必须精确等于 11 + sps + pps");
        boolean allOk = true;
        String bad = "";
        for (int s = 4; s <= 64; s++) {
            for (int p = 1; p <= 16; p++) {
                try {
                    byte[] c = AvcC.build(makeSps(s), makePps(p));
                    if (c.length != AvcC.FIXED_BYTES + s + p) {
                        allOk = false;
                        bad = "sps=" + s + " pps=" + p + " 得到 " + c.length;
                        break;
                    }
                    // 尾部必须正好落在最后一个字节上
                    if ((c[c.length - 1] & 0xFF) != (makePps(p)[p - 1] & 0xFF)) {
                        allOk = false;
                        bad = "sps=" + s + " pps=" + p + " 尾部字节不对";
                        break;
                    }
                } catch (Throwable e) {
                    allOk = false;
                    bad = "sps=" + s + " pps=" + p + " 抛了 " + e;
                    break;
                }
            }
            if (!allOk) break;
        }
        check("4..64 x 1..16 全部正确", allOk, bad);

        /* ---------- 3. 固定开销常量不能写错 ---------- */
        System.out.println("\n[3] FIXED_BYTES 与实际写入量一致");
        eq("FIXED_BYTES = 11", 11, AvcC.FIXED_BYTES);
        eq("空内容时总长就是固定开销", AvcC.FIXED_BYTES + 4 + 1,
                AvcC.build(makeSps(4), makePps(1)).length);

        /* ---------- 4. codec 字符串 ---------- */
        System.out.println("\n[4] codecString");
        check("baseline 3.1 -> avc1.42C01F",
                "avc1.42C01F".equals(AvcC.codecString(makeSps(17))),
                AvcC.codecString(makeSps(17)));
        byte[] high = makeSps(10);
        high[1] = 0x64; high[2] = 0x00; high[3] = 0x28;
        check("high 4.0 -> avc1.640028",
                "avc1.640028".equals(AvcC.codecString(high)),
                AvcC.codecString(high));

        /* ---------- 5. 非法输入要明确报错，而不是悄悄算错 ---------- */
        System.out.println("\n[5] 非法输入");
        check("sps 为 null 抛 IllegalArgumentException",
                throwsIAE(() -> AvcC.build(null, makePps(4))), null);
        check("pps 为 null 抛 IllegalArgumentException",
                throwsIAE(() -> AvcC.build(makeSps(17), null)), null);
        check("sps 只有 3 字节（读不到 level）要报错",
                throwsIAE(() -> AvcC.build(new byte[]{0x67, 0x42, 0x00}, makePps(4))), null);
        check("codecString 对短 SPS 也要报错",
                throwsIAE(() -> AvcC.codecString(new byte[]{0x67, 0x42})), null);

        System.out.println("\n通过 " + pass + " 项，失败 " + fail + " 项");
        if (fail > 0) System.exit(1);
    }

    /** 刻意不叫 Runnable，免得盖住 java.lang.Runnable。 */
    private interface Thunk {
        void run() throws Throwable;
    }

    private static boolean throwsIAE(Thunk r) {
        try {
            r.run();
            return false;
        } catch (IllegalArgumentException e) {
            return true;
        } catch (Throwable e) {
            return false;
        }
    }
}
