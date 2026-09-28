package com.wb.remoteagent;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * 被控端连接加密中继时的证书校验。
 *
 * 这里只有一条规则：**证书必须被验证过才放行**。两条通过路径：
 *
 *   1. pin（指纹）命中 —— 用户在 App 里填了 tools/make-cert.sh 打印的指纹。
 *      最严格：配了 pin 就只认 pin，系统信任库说什么都不管。
 *   2. 系统信任库认可 —— 中继用 Let's Encrypt 之类正式证书时走这条，pin 可填可不填。
 *
 * 自签证书 + 没填 pin 的情况，默认走 TOFU（首次信任）：第一次连接把指纹记下来，
 * 之后每次都严格比对。TOFU 的第一次连接挡不住主动中间人 —— 这是它的固有代价，
 * 所以界面上会把学到的指纹显示出来，让人有机会跟服务器上打印的核对一下。
 *
 * 顺带说明为什么不用 `rejectUnauthorized=false` 那种「信任所有证书」的写法：
 * 那样加密还在，但任何人都能用自签证书冒充服务器，等于没加密。
 */
final class AgentTls {

    private static final String TAG = "AgentTls";

    /** TOFU 学到指纹后往哪送。 */
    interface PinSink {
        void onFingerprintLearned(String fingerprint);
    }

    private AgentTls() {}

    /* ---------------- 配置读写（和 MainActivity 共用同一份 SharedPreferences） ---------------- */

    private static final String PREF = "ra";
    static final String K_TLS = "tls";
    static final String K_TLS_PIN = "tlsPin";
    static final String K_TLS_TOFU = "tlsTofu";

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    static boolean isEnabled(Context ctx) {
        return prefs(ctx).getBoolean(K_TLS, false);
    }

    static String pinOf(Context ctx) {
        return prefs(ctx).getString(K_TLS_PIN, null);
    }

    /** TOFU 默认开：不然自签证书第一次永远连不上。 */
    static boolean tofuOf(Context ctx) {
        return prefs(ctx).getBoolean(K_TLS_TOFU, true);
    }

    /** TOFU 学到指纹后存下来，下次连接就是严格校验。 */
    static void saveLearnedPin(Context ctx, String fingerprint) {
        if (fingerprint == null) return;
        prefs(ctx).edit().putString(K_TLS_PIN, fingerprint).apply();
        Log.i(TAG, "已记住服务器证书指纹，后续连接将严格校验：" + fingerprint);
    }

    /**
     * 把用户填的指纹规范化：去掉冒号、空格，统一大写。
     * 这样 "62:24:F2:..." / "6224f2..." / "6224 F2 ..." 都能用。
     */
    static String normalize(String pin) {
        if (pin == null) return null;
        String s = pin.replace(":", "").replace(" ", "").replace("-", "").trim().toUpperCase();
        return s.isEmpty() ? null : s;
    }

    /** 证书指纹：对 DER 编码做 SHA-256，大写十六进制。和中继、make-cert.sh 一致。 */
    static String fingerprint(X509Certificate cert) {
        try {
            byte[] der = cert.getEncoded();
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] dig = md.digest(der);
            StringBuilder sb = new StringBuilder(dig.length * 2);
            for (byte b : dig) sb.append(String.format("%02X", b));
            return sb.toString();
        } catch (Exception e) {
            Log.w(TAG, "算指纹失败: " + e);
            return null;
        }
    }

    /**
     * @param pin   用户配置的指纹，可为 null
     * @param tofu  pin 为空且系统信任库不认时，是否学习并信任（首次信任）
     * @param sink  TOFU 学到指纹后的回调，可为 null
     */
    static SSLSocketFactory factory(String pin, boolean tofu, PinSink sink) throws Exception {
        final String normalized = normalize(pin);
        final X509TrustManager def = defaultTrustManager();

        X509TrustManager wrapper = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType)
                    throws CertificateException {
                def.checkClientTrusted(chain, authType);
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType)
                    throws CertificateException {
                String leaf = (chain != null && chain.length > 0) ? fingerprint(chain[0]) : null;

                // 路径 1：指纹命中。配了 pin 就只认 pin，不再看系统信任库。
                if (normalized != null && normalized.equals(leaf)) {
                    Log.i(TAG, "证书指纹命中 pin，放行");
                    return;
                }

                // 路径 2：系统信任库认可（正式证书）
                try {
                    def.checkServerTrusted(chain, authType);
                } catch (CertificateException e) {
                    // 系统不认。pin 没配的话，走 TOFU 学一次。
                    if (normalized == null && tofu && leaf != null) {
                        Log.w(TAG, "首次连接（TOFU），记下服务器证书指纹：" + leaf);
                        if (sink != null) sink.onFingerprintLearned(leaf);
                        return;
                    }
                    if (normalized != null) {
                        throw new CertificateException(
                                "服务器证书没通过校验，而且指纹也对不上 App 里配的那个。"
                                        + "服务器指纹=" + leaf + "，App 里配的=" + normalized
                                        + "。换了证书就重新跑 tools/make-cert.sh 更新指纹。");
                    }
                    throw e;
                }

                // 系统认了，但用户明确配了另一个指纹 —— 说明服务器被换了，不能放行
                if (normalized != null) {
                    throw new CertificateException(
                            "服务器证书是有效的，但指纹和 App 里配的不一致（可能是中间人）。"
                                    + "服务器指纹=" + leaf + "，App 里配的=" + normalized);
                }
                Log.i(TAG, "证书通过系统信任库校验，指纹=" + leaf);
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return def.getAcceptedIssuers();
            }
        };

        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{wrapper}, new SecureRandom());
        return ctx.getSocketFactory();
    }

    private static X509TrustManager defaultTrustManager() throws Exception {
        TrustManagerFactory tmf =
                TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init((KeyStore) null);   // null = 用系统信任库
        for (TrustManager tm : tmf.getTrustManagers()) {
            if (tm instanceof X509TrustManager) return (X509TrustManager) tm;
        }
        throw new IllegalStateException("系统里找不到 X509TrustManager");
    }

    /**
     * 只开启这个系统真正支持的协议。
     * 直接 setEnabledProtocols(new String[]{"TLSv1.3"}) 在 API 26/27 上会抛
     * IllegalArgumentException（不是所有设备都带 1.3），所以要先跟 supported 求交集。
     */
    static void applyProtocols(SSLSocket s) {
        try {
            java.util.List<String> supported =
                    java.util.Arrays.asList(s.getSupportedProtocols());
            java.util.List<String> want = new java.util.ArrayList<>();
            for (String p : new String[]{"TLSv1.3", "TLSv1.2"}) {
                if (supported.contains(p)) want.add(p);
            }
            if (!want.isEmpty()) {
                s.setEnabledProtocols(want.toArray(new String[0]));
            }
        } catch (Exception e) {
            Log.w(TAG, "设置 TLS 版本失败，用系统默认: " + e);
        }
    }
}
