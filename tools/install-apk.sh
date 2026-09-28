#!/usr/bin/env bash
# 把 APK 装到通过 USB 连着的安卓手机上。
#
# 为什么要这么绕：
#   华为（以及部分国产 ROM）上 `adb install` 会走 packageinstaller 的
#   「风险提示 → 应用市场安全提醒 → 验证码」三道弹窗，无人值守时必然卡死；
#   而 `pm install <路径>` 会进 InstallStaging 这个 Activity，也实测会挂住不动
#   （dumpsys window 里能看到 mCurrentFocus=.../InstallStaging）。
#
#   能稳定跑通的是「会话式安装」：install-create → install-write（直接给文件路径，
#   不走 stdin）→ install-commit。全程不碰任何 UI。
#
#   但还有第二个前提：**屏幕必须是亮的、且已解锁**。
#   install-write 会让 framework 起一个 InstallStaging Activity 来显示「正在准备」，
#   灭屏时这个 Activity 画不出来，整个安装就永远卡在那里（实测挂 3 分半没动静，
#   dumpsys window 里能看到 mCurrentFocus=.../InstallStaging）。
#   所以下面第一步先把屏幕叫醒、把锁屏划掉。
#
# 用法：
#   bash tools/install-apk.sh [apk路径] [设备序列号]
#   默认装 dist/remote-assist-agent.apk 到唯一那台设备。

set -u

APK="${1:-dist/remote-assist-agent.apk}"
SERIAL="${2:-}"

if [ ! -f "$APK" ]; then
  echo "找不到 APK: $APK" >&2
  exit 1
fi

ADB="${ADB:-adb}"
if ! command -v "$ADB" >/dev/null 2>&1; then
  ADB="/e/Sdk/platform-tools/adb"
fi

# 注意：adb 命令必须串行执行。并行跑两个 adb 会互相抢着启 daemon，
# 结果是 "could not read ok from ADB Server"，连隧道一起断掉。
if [ -n "$SERIAL" ]; then
  ADB="$ADB -s $SERIAL"
fi

SIZE=$(stat -c %s "$APK")
REMOTE="/data/local/tmp/ra-install.apk"

echo "0/4 叫醒屏幕（灭屏时 InstallStaging 会卡死）…"
$ADB shell am force-stop com.android.packageinstaller >/dev/null 2>&1
$ADB shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
$ADB shell wm dismiss-keyguard >/dev/null 2>&1
sleep 1
WAKE=$($ADB shell dumpsys power 2>/dev/null | grep -m1 "mWakefulness=" | tr -d '\r')
case "$WAKE" in
  *Awake*) echo "    屏幕已亮" ;;
  *) echo "    警告：屏幕可能还是黑的（$WAKE），安装有可能会卡住" ;;
esac

echo "1/4 推送 APK（$SIZE 字节）…"
$ADB push "$APK" "$REMOTE" >/dev/null || { echo "推送失败" >&2; exit 1; }

echo "2/4 创建安装会话…"
OUT=$($ADB shell pm install-create -r -d -S "$SIZE") || { echo "$OUT" >&2; exit 1; }
SESSION=$(echo "$OUT" | sed -n 's/.*\[\([0-9]*\)\].*/\1/p')
if [ -z "$SESSION" ]; then
  echo "拿不到会话号：$OUT" >&2
  exit 1
fi
echo "    会话 $SESSION"

echo "3/4 写入…"
# 这里必须给「文件路径」而不是 `-`（stdin）。实测经 adb shell 走 stdin 会被截断，
# 报 "failed to write; Unexpected EOF"。
$ADB shell pm install-write -S "$SIZE" "$SESSION" base.apk "$REMOTE" || {
  $ADB shell pm install-abandon "$SESSION" >/dev/null 2>&1
  exit 1
}

echo "4/4 提交…"
$ADB shell pm install-commit "$SESSION" || {
  $ADB shell pm install-abandon "$SESSION" >/dev/null 2>&1
  exit 1
}

$ADB shell rm -f "$REMOTE" >/dev/null 2>&1
echo
echo "已安装。确认一下："
$ADB shell dumpsys package com.wb.remoteagent | grep -E "lastUpdateTime|versionName" | head -3
