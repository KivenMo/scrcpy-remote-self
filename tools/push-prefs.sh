#!/usr/bin/env bash
# 直接改被控端 App 的 SharedPreferences。
#
# 为什么需要这个：调试时每次都要「装 APK → 开界面 → 滚到按钮 → 点」太慢，
# 而且改一个配置项就得重来一遍。走 run-as 直接写 prefs 可以精确控制每一项，
# 适合验证「指纹配错会怎样」这类只在特定配置下才出现的分支。
#
# 前提：App 必须是 debug 版（debuggable=true），否则 run-as 不可用。
#
# 用法：
#   bash tools/push-prefs.sh server/prefs-tls-goodpin.xml
#   bash tools/push-prefs.sh --dump                  # 只看当前值
#
# 注意：写之前必须 force-stop 应用。不然它内存里那份旧 prefs 会在下次
# 落盘时把你的修改覆盖掉 —— 这个坑很容易踩，而且现象很迷惑（改了像没改）。

set -u

PKG=com.wb.remoteagent
PREFS=shared_prefs/ra.xml
ADB="${ADB:-adb}"
command -v "$ADB" >/dev/null 2>&1 || ADB="/e/Sdk/platform-tools/adb"

if [ "${1:-}" = "--dump" ]; then
  "$ADB" shell run-as "$PKG" cat "$PREFS"
  exit 0
fi

SRC="${1:-}"
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "用法: bash tools/push-prefs.sh <prefs.xml> | --dump" >&2
  exit 1
fi

echo "1/3 停掉应用（不停的话内存里的旧值会把改动覆盖回去）…"
"$ADB" shell am force-stop "$PKG"
sleep 1

echo "2/3 写入 $SRC …"
# 必须走 base64：直接 cat 重定向会碰到引号和换行，经 adb shell 传过去就烂了。
# 而且重定向要放在 run-as 里面 —— 放外面是以 shell 用户身份写 /data/data，权限不够。
B64=$(base64 -w0 "$SRC")
"$ADB" shell "run-as $PKG sh -c 'echo $B64 | base64 -d > $PREFS'" || {
  echo "写入失败。App 是 debug 版吗？" >&2
  exit 1
}

echo "3/3 回读确认…"
"$ADB" shell run-as "$PKG" cat "$PREFS"
