package com.wb.remoteagent;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Path;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 免 root 的“手”：把控制端发来的指令翻译成真实触摸、系统按键、文字与启动应用。
 *
 * 能力边界（Android 平台限制，无法绕过）：
 *   - 锁屏界面无法输入解锁密码
 *   - 银行/支付等 FLAG_SECURE 界面既看不到也点不了
 *   - 需要用户手动开启本服务，且部分厂商对侧载应用会额外拦截
 */
public class RemoteAccessibilityService extends AccessibilityService {

    private static final String TAG = "RemoteA11y";
    private static volatile RemoteAccessibilityService instance;

    private final Handler main = new Handler(Looper.getMainLooper());

    public static RemoteAccessibilityService get() {
        return instance;
    }

    public static boolean isReady() {
        return instance != null;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        Log.i(TAG, "无障碍服务已连接");
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // 不需要监听事件，只用注入能力
    }

    @Override
    public void onInterrupt() {
    }

    /* ---------------- 坐标换算 ---------------- */

    private Point toPx(float nx, float ny) {
        Point real = ScreenInfo.getRealSize(this);
        int x = Math.round(nx * real.x);
        int y = Math.round(ny * real.y);
        x = Math.max(0, Math.min(real.x - 1, x));
        y = Math.max(0, Math.min(real.y - 1, y));
        return new Point(x, y);
    }

    private boolean gesture(Path path, long durationMs) {
        try {
            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(path, 0, Math.max(30, durationMs));
            GestureDescription desc = new GestureDescription.Builder().addStroke(stroke).build();
            return dispatchGesture(desc, null, null);
        } catch (Throwable e) {
            Log.w(TAG, "手势注入失败: " + e);
            return false;
        }
    }

    /* ---------------- 触摸 ---------------- */

    public void tap(final float nx, final float ny) {
        main.post(() -> {
            Point p = toPx(nx, ny);
            Path path = new Path();
            path.moveTo(p.x, p.y);
            gesture(path, 50);
        });
    }

    public void longPress(final float nx, final float ny) {
        main.post(() -> {
            Point p = toPx(nx, ny);
            Path path = new Path();
            path.moveTo(p.x, p.y);
            gesture(path, 700);
        });
    }

    public void swipe(final float x1, final float y1, final float x2, final float y2, final long durMs) {
        main.post(() -> {
            Point a = toPx(x1, y1);
            Point b = toPx(x2, y2);
            Path path = new Path();
            path.moveTo(a.x, a.y);
            path.lineTo(b.x, b.y);
            gesture(path, Math.max(60, Math.min(2000, durMs)));
        });
    }

    /* ---------------- 系统按键 ---------------- */

    public boolean globalKey(String key) {
        int action;
        switch (key == null ? "" : key) {
            case "back":          action = GLOBAL_ACTION_BACK; break;
            case "home":          action = GLOBAL_ACTION_HOME; break;
            case "recents":       action = GLOBAL_ACTION_RECENTS; break;
            case "notifications": action = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "quick":         action = GLOBAL_ACTION_QUICK_SETTINGS; break;
            case "lock":          action = GLOBAL_ACTION_LOCK_SCREEN; break;
            default: return false;
        }
        try {
            return performGlobalAction(action);
        } catch (Throwable e) {
            Log.w(TAG, "系统按键失败: " + e);
            return false;
        }
    }

    /* ---------------- 文字 ---------------- */

    private AccessibilityNodeInfo findEditable() {
        AccessibilityNodeInfo root;
        try {
            root = getRootInActiveWindow();
        } catch (Throwable e) {
            return null;
        }
        if (root == null) return null;
        AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focused == null) focused = root.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY);
        if (focused != null && focused.isEditable()) return focused;
        if (focused != null) return focused;
        return findFirstEditable(root, 0);
    }

    private AccessibilityNodeInfo findFirstEditable(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 20) return null;
        if (node.isEditable() && node.isEnabled()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = findFirstEditable(node.getChild(i), depth + 1);
            if (found != null) return found;
        }
        return null;
    }

    /** 追加写入（保留输入框里已有的内容）。 */
    public boolean inputText(String text) {
        if (text == null) return false;
        AccessibilityNodeInfo node = findEditable();
        if (node == null) return false;

        CharSequence existing = node.getText();
        String base = existing == null ? "" : existing.toString();
        String merged = base + text;

        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, merged);
        try {
            if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return true;
        } catch (Throwable e) {
            Log.w(TAG, "写入文字失败: " + e);
        }
        // 退路：写入剪贴板后让该节点自己执行粘贴
        try {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(android.content.ClipData.newPlainText("ra", text));
                return node.performAction(AccessibilityNodeInfo.ACTION_PASTE);
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    /** 触发输入法的“回车/完成”。 */
    public boolean imeEnter() {
        AccessibilityNodeInfo node = findEditable();
        if (node == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
            }
        } catch (Throwable e) {
            Log.w(TAG, "回车失败: " + e);
        }
        return false;
    }

    /* ---------------- 剪贴板 ---------------- */

    /** 写入被控手机的剪贴板。写入不受限，任何应用都能写。 */
    public boolean setClipboard(String text) {
        if (text == null) return false;
        try {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm == null) return false;
            cm.setPrimaryClip(android.content.ClipData.newPlainText("remote-assist", text));
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "写剪贴板失败: " + e);
            return false;
        }
    }

    /** 把剪贴板内容粘贴到当前输入框。 */
    public boolean pasteIntoFocus() {
        AccessibilityNodeInfo node = findEditable();
        if (node == null) return false;
        try {
            return node.performAction(AccessibilityNodeInfo.ACTION_PASTE);
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 读取被控手机的剪贴板。
     *
     * Android 10 起只有拥有输入焦点的应用才能读剪贴板，无障碍服务在多数机型上
     * 可以读到，但不是所有 ROM 都放行。读不到时退一步取当前输入框里的文字 ——
     * 「把手机上输入框里的验证码发过来」这个最常见的诉求依然能满足。
     *
     * @return 内容；两条路都拿不到时返回 null
     */
    public String readClipboard() {
        try {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm != null && cm.hasPrimaryClip()) {
                android.content.ClipData clip = cm.getPrimaryClip();
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence t = clip.getItemAt(0).coerceToText(this);
                    if (t != null && t.length() > 0) return t.toString();
                }
            }
        } catch (Throwable e) {
            Log.w(TAG, "读剪贴板失败: " + e);
        }
        return null;
    }

    /** 退路：当前聚焦输入框里的文字。 */
    public String readFocusedText() {
        try {
            AccessibilityNodeInfo node = findEditable();
            if (node != null && node.getText() != null) {
                String s = node.getText().toString();
                if (!s.isEmpty()) return s;
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    /* ---------------- 启动应用 ---------------- */

    public boolean launchApp(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
            if (i == null) return false;
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            startActivity(i);
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "启动应用失败 " + pkg + ": " + e);
            return false;
        }
    }

    /** 按名字（应用显示名或包名）启动应用，无人值守模式下比记包名友好。 */
    public boolean launchAppByLabel(String label) {
        if (label == null || label.trim().isEmpty()) return false;
        String q = label.trim().toLowerCase(Locale.ROOT);
        JSONArray list = AppCatalog.listLaunchable(this);
        String byName = null, byPkg = null, partialPkg = null;
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            if (o == null) continue;
            String n = o.optString("n", "").toLowerCase(Locale.ROOT);
            String p = o.optString("p", "");
            String pl = p.toLowerCase(Locale.ROOT);
            if (byName == null && n.equals(q)) byName = p;
            if (byPkg == null && pl.equals(q)) byPkg = p;
            if (partialPkg == null && (n.contains(q) || pl.contains(q))) partialPkg = p;
        }
        String pick = byName != null ? byName : (byPkg != null ? byPkg : partialPkg);
        if (pick == null) return false;
        return launchApp(pick);
    }

    /* ================= 无人值守：把屏幕「读」成文字 ================= */

    /*
     * 为什么要有这一套：
     *   录屏（MediaProjection）的授权弹窗是系统强制的，而且 Android 14 起每次开始投屏
     *   都要重新授权 —— 手机放在公司没人，就永远点不了那一下。
     *   而「打卡」这个需求其实不需要看见画面：知道现在停在哪个界面、按钮叫什么，就够了。
     *   无障碍服务能读到界面上所有文字和可点节点，而且它**完全不需要录屏授权**，
     *   所以可以开机自启、无人值守。
     */

    private static final int UI_MAX_ITEMS = 300;
    private static final int UI_MAX_DEPTH = 25;

    /** 屏幕外的元素最多自动滚动几次去找（每次一屏的 ~60%）。 */
    private static final int SCROLL_TRIES = 6;
    /**
     * 「这一遍没找到」之后重读界面树的次数。
     *
     * 为什么需要：`getRootInActiveWindow()` 偶尔会返回不完整或过期的树（刚执行完
     * 上一个动作时最容易撞上）。实测出现过一次 —— 控制端前一刻 dump 里明明有
     * 「远程协助 · 被控端」这个文字，紧接着带 scroll 的 taptext 就报「当前界面上
     * 找不到」。所以「这一遍没匹配到」不能直接当成「界面上没有」，得先重读几次。
     */
    private static final int BLANK_RETRIES = 3;
    /** 重读之间的间隔。够短，不影响体感；够长，让界面稳定下来。 */
    private static final long BLANK_RETRY_MS = 120;

    private Point screenSize() {
        return ScreenInfo.getRealSize(this);
    }

    /** 元素是否真的落在屏幕里。滚动过的列表里，屏幕外的节点坐标会是负的或超出屏幕。 */
    private boolean isVisible(Rect r, Point screen) {
        return r.width() > 0 && r.height() > 0
                && r.bottom > 0 && r.top < screen.y
                && r.right > 0 && r.left < screen.x;
    }

    /** 把当前界面上的文字 / 可点元素读出来，返回 JSON 字符串。 */
    public String readUi() {
        AccessibilityNodeInfo root;
        try {
            root = getRootInActiveWindow();
        } catch (Throwable e) {
            return null;
        }
        if (root == null) return null;

        JSONArray arr = new JSONArray();
        try {
            Point screen = screenSize();
            collectUi(root, arr, 0, screen);
            JSONObject out = new JSONObject();
            out.put("pkg", String.valueOf(root.getPackageName()));
            out.put("sw", screen.x);
            out.put("sh", screen.y);
            out.put("items", arr);
            return out.toString();
        } catch (Throwable e) {
            Log.w(TAG, "读屏失败: " + e);
            return null;
        }
    }

    private void collectUi(AccessibilityNodeInfo n, JSONArray arr, int depth, Point screen) {
        if (n == null || depth > UI_MAX_DEPTH || arr.length() >= UI_MAX_ITEMS) return;
        try {
            String text = n.getText() == null ? "" : n.getText().toString().trim();
            String desc = n.getContentDescription() == null
                    ? "" : n.getContentDescription().toString().trim();
            if (!text.isEmpty() || !desc.isEmpty()) {
                Rect r = new Rect();
                n.getBoundsInScreen(r);
                JSONObject o = new JSONObject();
                if (!text.isEmpty()) o.put("t", text);
                if (!desc.isEmpty()) o.put("d", desc);
                o.put("x", r.centerX());
                o.put("y", r.centerY());
                // 能不能点：节点自己可点，或者往上找得到可点的祖先。
                // 很多按钮的文字挂在不带 clickable 的子节点上，直接看 isClickable() 会误报。
                o.put("c", n.isClickable() || nearestClickable(n) != null);
                // 在不在屏幕里。滚动过的列表里，屏幕外的节点坐标是负的或超出屏幕，
                // 照那个坐标点下去会点到屏幕边缘 —— 必须区分出来。
                o.put("v", isVisible(r, screen));
                o.put("cls", String.valueOf(n.getClassName()));
                arr.put(o);
            }
        } catch (Throwable ignored) {
        }
        for (int i = 0; i < n.getChildCount(); i++) {
            collectUi(n.getChild(i), arr, depth + 1, screen);
        }
    }

    /** 从某个节点往上找最近的可点祖先（按钮文字常常挂在子节点上）。 */
    private AccessibilityNodeInfo nearestClickable(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo cur = node;
        for (int i = 0; i < 12 && cur != null; i++) {
            try {
                if (cur.isClickable() && cur.isEnabled()) return cur;
            } catch (Throwable ignored) {
            }
            try {
                cur = cur.getParent();
            } catch (Throwable e) {
                return null;
            }
        }
        return null;
    }

    /**
     * 按文字点。先精确匹配（text 或 contentDescription），再退到「包含」。
     * 优先用 ACTION_CLICK（比按坐标点可靠，不受动画/遮挡影响），不行再按坐标点中心。
     *
     * <b>只点屏幕上看得见的元素。</b>滚动过的列表里，屏幕外的节点也能匹配到文字，
     * 但它的坐标是负的 —— 照那个坐标点下去会落到屏幕边缘，点到什么全凭运气。
     * 这种情况宁可如实说「它在屏幕外」，让调用方决定要不要滚动过去。
     *
     * @return 成功返回 null；失败返回一句能直接给用户看的原因
     */
    public String tapByText(String query) {
        return tapByText(query, false);
    }

    /**
     * @param allowScroll 找不到可见的匹配时，是否自动往上滚几屏再找
     *                    （打卡按钮常在列表底部，需要这个）
     */
    public String tapByText(String query, boolean allowScroll) {
        if (query == null || query.trim().isEmpty()) return "没说要点哪个文字";
        String q = query.trim().toLowerCase(Locale.ROOT);

        final int maxScrolls = allowScroll ? SCROLL_TRIES : 0;
        int scrolls = 0;
        int blanks = 0;

        while (true) {
            Pick pick = findForTap(q);
            if (pick.visible != null) return clickNode(pick.visible, query);

            if (pick.offScreen == null) {
                // 这一遍两边都没有。先别下结论 —— 可能是读到的树是半截的（见
                // BLANK_RETRIES 的注释）。重读几次，真的没有才放弃。
                if (++blanks <= BLANK_RETRIES) {
                    sleepQuiet(BLANK_RETRY_MS);
                    continue;
                }
                break;
            }

            if (!allowScroll) {
                Rect r = boundsOf(pick.offScreen);
                return "找到了「" + query + "」，但它在屏幕外（y=" + r.centerY()
                        + "），没有点击。需要的话让控制端带 scroll 再试，我会先滚动过去。";
            }
            if (scrolls >= maxScrolls) break;

            // 方向要看目标在哪边：在上方就往上翻，在下方就往下翻。
            // 只朝一个方向翻的话，「目标在当前视口上方」这种情况永远找不到 —— 实测踩过。
            boolean targetAbove = boundsOf(pick.offScreen).centerY() < 0;
            if (!scrollStep(targetAbove)) {
                return "找到了「" + query + "」但它在屏幕外，而且这个界面滚不动";
            }
            scrolls++;
            blanks = 0;
        }
        Log.i(TAG, "界面上找不到「" + query + "」");
        return "当前界面上找不到「" + query + "」";
    }

    private static void sleepQuiet(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) {}
    }

    /** 一次查找的结果：可见的匹配 / 只在屏幕外的匹配 */
    private static final class Pick {
        AccessibilityNodeInfo visible;
        AccessibilityNodeInfo offScreen;
    }

    /**
     * 在界面里找目标。优先级：精确且在屏幕内 > 包含且在屏幕内 > 精确但在屏幕外 > 包含但在屏幕外。
     * 「在屏幕内」是硬条件优先，否则一个屏幕外的精确匹配会抢掉一个可见的模糊匹配。
     */
    private Pick findForTap(String q) {
        Pick pick = new Pick();
        AccessibilityNodeInfo root;
        try {
            root = getRootInActiveWindow();
        } catch (Throwable e) {
            return pick;
        }
        if (root == null) return pick;

        Point screen = screenSize();
        List<AccessibilityNodeInfo> exact = new ArrayList<>();
        List<AccessibilityNodeInfo> partial = new ArrayList<>();
        matchByText(root, q, 0, exact, partial);

        AccessibilityNodeInfo[] order = {
                firstVisible(exact, screen), firstVisible(partial, screen),
                firstOffScreen(exact, screen), firstOffScreen(partial, screen),
        };
        pick.visible = order[0] != null ? order[0] : order[1];
        pick.offScreen = order[2] != null ? order[2] : order[3];
        return pick;
    }

    private AccessibilityNodeInfo firstVisible(List<AccessibilityNodeInfo> list, Point screen) {
        for (AccessibilityNodeInfo n : list) {
            if (isVisible(boundsOf(n), screen)) return n;
        }
        return null;
    }

    private AccessibilityNodeInfo firstOffScreen(List<AccessibilityNodeInfo> list, Point screen) {
        for (AccessibilityNodeInfo n : list) {
            if (!isVisible(boundsOf(n), screen)) return n;
        }
        return null;
    }

    private Rect boundsOf(AccessibilityNodeInfo n) {
        Rect r = new Rect();
        try {
            n.getBoundsInScreen(r);
        } catch (Throwable ignored) {
        }
        return r;
    }

    /** 真正把点击发出去。优先 ACTION_CLICK，退到坐标。 */
    private String clickNode(AccessibilityNodeInfo hit, String query) {
        AccessibilityNodeInfo clickable = nearestClickable(hit);
        AccessibilityNodeInfo use = clickable != null ? clickable : hit;

        try {
            if (use.isClickable() && use.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                Log.i(TAG, "按文字点击成功: " + query);
                return null;
            }
        } catch (Throwable e) {
            Log.d(TAG, "ACTION_CLICK 失败，退到坐标点: " + e);
        }

        Rect r = boundsOf(use);
        if (r.width() <= 0 || r.height() <= 0) return "「" + query + "」这块区域是空的，点不了";
        tapAtPx(r.centerX(), r.centerY());
        Log.i(TAG, "按文字坐标点击: " + query + " @ " + r.centerX() + "," + r.centerY());
        return null;
    }

    /**
     * 滚动一屏的 60%。返回 false 表示这个界面滚不动（已经到底了）。
     *
     * @param towardTop true = 目标是当前视口**上方**的元素，要往上翻（手指往下划）
     */
    private boolean scrollStep(boolean towardTop) {
        Point screen = screenSize();
        int x = screen.x / 2;
        int hi = (int) (screen.y * 0.15);
        int lo = (int) (screen.y * 0.75);
        // 手指从 lo 划到 hi：内容向上走，看到的是更靠下的东西。
        // 反过来（hi -> lo）：内容向下走，看到更靠上的东西。
        int from = towardTop ? hi : lo;
        int to = towardTop ? lo : hi;
        try {
            Path path = new Path();
            path.moveTo(x, from);
            path.lineTo(x, to);
            boolean sent = gesture(path, 320);
            if (sent) {
                // 等惯性滚动停下来再读界面，否则读到的还是旧位置
                sleepQuiet(450);
            }
            return sent;
        } catch (Throwable e) {
            Log.w(TAG, "滚动失败: " + e);
            return false;
        }
    }

    private void matchByText(AccessibilityNodeInfo n, String q, int depth,
                             List<AccessibilityNodeInfo> exact,
                             List<AccessibilityNodeInfo> partial) {
        if (n == null || depth > UI_MAX_DEPTH) return;
        try {
            String t = n.getText() == null ? ""
                    : n.getText().toString().trim().toLowerCase(Locale.ROOT);
            String d = n.getContentDescription() == null ? ""
                    : n.getContentDescription().toString().trim().toLowerCase(Locale.ROOT);
            if ((!t.isEmpty() && t.equals(q)) || (!d.isEmpty() && d.equals(q))) {
                exact.add(n);
            } else if ((!t.isEmpty() && t.contains(q)) || (!d.isEmpty() && d.contains(q))) {
                partial.add(n);
            }
        } catch (Throwable ignored) {
        }
        for (int i = 0; i < n.getChildCount(); i++) {
            matchByText(n.getChild(i), q, depth + 1, exact, partial);
        }
    }

    /** 按绝对像素坐标点一下（tapByText 的退路）。坐标会被夹进屏幕范围，防止点到边界外。 */
    private void tapAtPx(final float px, final float py) {
        main.post(() -> {
            Point screen = ScreenInfo.getRealSize(this);
            float x = Math.max(0f, Math.min(screen.x - 1f, px));
            float y = Math.max(0f, Math.min(screen.y - 1f, py));
            Path path = new Path();
            path.moveTo(x, y);
            gesture(path, 50);
        });
    }
}
