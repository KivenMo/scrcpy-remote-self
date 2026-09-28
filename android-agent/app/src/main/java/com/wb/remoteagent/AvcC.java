package com.wb.remoteagent;

/**
 * H.264 的 avcC（AVCDecoderConfigurationRecord）拼装。
 *
 * 刻意做成纯字节操作、不 import 任何 Android 类 —— 这样能脱离模拟器直接用 javac 跑单元测试。
 * 之前这段逻辑写在 CaptureService 里，没法单测，结果少算 1 个字节的 bug 一路混到了真机上：
 * 华为 P30 Pro 的编码器给 17 字节 SPS + 4 字节 PPS，就正好踩中，H.264 管线静默失败。
 */
final class AvcC {

    private AvcC() {}

    /** 固定开销字节数：见 build() 里的布局注释。 */
    static final int FIXED_BYTES = 11;

    /**
     * 按 ISO/IEC 14496-15 拼出 avcC。
     *
     * 布局：
     *   1  configurationVersion
     *   1  AVCProfileIndication      (sps[1])
     *   1  profile_compatibility     (sps[2])
     *   1  AVCLevelIndication        (sps[3])
     *   1  0xFF（reserved 111111 + lengthSizeMinusOne=3，即 4 字节长度前缀）
     *   1  numOfSequenceParameterSets | 0xE0
     *   2  SPS 长度（大端）
     *   n  SPS
     *   1  numOfPictureParameterSets
     *   2  PPS 长度（大端）
     *   m  PPS
     *
     * @param sps SPS NAL，含 1 字节 NAL 头（即 sps[0] 是 0x67 这类）
     * @param pps PPS NAL，含 1 字节 NAL 头
     */
    static byte[] build(byte[] sps, byte[] pps) {
        if (sps == null || pps == null) throw new IllegalArgumentException("sps/pps 不能为 null");
        if (sps.length < 4) throw new IllegalArgumentException("SPS 太短，读不到 profile/level: " + sps.length);
        if (pps.length < 1) throw new IllegalArgumentException("PPS 为空");

        int size = FIXED_BYTES + sps.length + pps.length;
        byte[] out = new byte[size];
        int p = 0;
        out[p++] = 1;                                   // configurationVersion
        out[p++] = sps[1];                              // AVCProfileIndication
        out[p++] = sps[2];                              // profile_compatibility
        out[p++] = sps[3];                              // AVCLevelIndication
        // bit(6) reserved = 111111 | unsigned int(2) lengthSizeMinusOne
        // 这里必须是 0xFF：低两位 = 3 表示 NAL 前面是 4 字节长度。
        // 之前写的是 0xFC（低两位 = 0 -> 1 字节长度），和 annexBToAvcc() 实际写出的
        // 4 字节长度前缀对不上，解码器会按 1 字节去切，画面必花。
        out[p++] = (byte) 0xFF;
        out[p++] = (byte) 0xE1;                         // numOfSequenceParameterSets = 1
        out[p++] = (byte) (sps.length >> 8);
        out[p++] = (byte) sps.length;
        System.arraycopy(sps, 0, out, p, sps.length);
        p += sps.length;
        out[p++] = 1;                                   // numOfPictureParameterSets
        out[p++] = (byte) (pps.length >> 8);
        out[p++] = (byte) pps.length;
        System.arraycopy(pps, 0, out, p, pps.length);
        p += pps.length;

        // 写满才算对。以后谁改了布局忘了改 FIXED_BYTES，这里立刻炸，而不是静默少一字节。
        if (p != size) throw new IllegalStateException("avcC 长度对不上: 写了 " + p + " 但分配了 " + size);
        return out;
    }

    /** 由 SPS 推出 WebCodecs 需要的 codec 字符串，如 avc1.64001F。 */
    static String codecString(byte[] sps) {
        if (sps == null || sps.length < 4) throw new IllegalArgumentException("SPS 太短，读不到 profile/level");
        return String.format("avc1.%02X%02X%02X", sps[1] & 0xFF, sps[2] & 0xFF, sps[3] & 0xFF);
    }
}
