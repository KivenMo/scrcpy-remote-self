#!/usr/bin/env bash
# 生成中继服务器用的自签证书。
#
#   bash tools/make-cert.sh                    # 自动带上本机所有局域网 IP
#   bash tools/make-cert.sh relay.example.com  # 顺便带上一个域名
#
# 产出（默认在 server/certs/）：
#   cert.pem   证书 + 链
#   key.pem    私钥
#
# 最后会打印 SHA-256 指纹。这个指纹有两处用途：
#   1. 填进安卓 App 的「证书指纹」框 —— 这样第一次连接就严格校验，没有 TOFU 窗口期
#   2. 不填也行，App 会在第一次连接时把指纹记下来（TOFU），之后严格比对
#
# 注意：自签证书浏览器会报警告，这是正常的。iPhone Safari 里点「继续访问」即可；
# 想彻底没有警告就用 Let's Encrypt 签一张真证书（见 README 十一.7）。

set -euo pipefail

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/server/certs"
DAYS=3650
EXTRA_DOMAIN="${1:-}"

command -v openssl >/dev/null 2>&1 || { echo "找不到 openssl，请先安装。" >&2; exit 1; }

mkdir -p "$OUT_DIR"

# ── 收集要写进 SAN 的地址 ────────────────────────────────────────────
# SAN 很重要：现在浏览器和安卓都不看 CN 了，只认 SAN。
# 少写一个 IP，用那个 IP 访问时就会报「证书不匹配」。
SAN="DNS:localhost,IP:127.0.0.1,IP:::1"

if [ -n "$EXTRA_DOMAIN" ]; then
  SAN="$SAN,DNS:$EXTRA_DOMAIN"
  echo "加上域名：$EXTRA_DOMAIN"
fi

echo "扫描本机 IPv4 地址…"

# 优先用 node 枚举网卡。
# 不用 ip/ifconfig/ipconfig 是因为：Windows 的 ipconfig 输出是 UTF-16，
# 管道给 grep 会被当成二进制文件（实测踩过）；而 ip/ifconfig 在 Git Bash
# 里又看不到全部适配器。node 的 os.networkInterfaces() 两边都准，
# 而且跑这个服务本来就要有 node。
collect_ips() {
  if command -v node >/dev/null 2>&1; then
    node -e '
      const os = require("os");
      const out = [];
      for (const name of Object.keys(os.networkInterfaces())) {
        for (const ni of os.networkInterfaces()[name] || []) {
          if (ni.family !== "IPv4" || ni.internal) continue;
          if (ni.address === "0.0.0.0") continue;
          out.push(ni.address);
        }
      }
      console.log(out.join("\n"));
    ' 2>/dev/null
    return
  fi
  # 没有 node 时的退路
  {
    ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1
    ifconfig 2>/dev/null | awk '/inet /{print $2}'
    hostname -I 2>/dev/null | tr ' ' '\n'
  } 2>/dev/null | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
}

while read -r ip; do
  [ -z "$ip" ] && continue
  case "$ip" in 127.*) continue ;; esac
  case "$SAN" in
    *"IP:$ip"*) continue ;;
  esac
  SAN="$SAN,IP:$ip"
  echo "  $ip"
done < <(collect_ips | sort -u)

echo
echo "SAN = $SAN"
echo

# ── 生成 ────────────────────────────────────────────────────────────
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/key.pem" \
  -out "$OUT_DIR/cert.pem" \
  -days "$DAYS" \
  -subj "/CN=remote-assist-relay" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  2>/dev/null

chmod 600 "$OUT_DIR/key.pem" 2>/dev/null || true

# ── 打印指纹 ────────────────────────────────────────────────────────
# 用 -outform DER 再哈希，等价于对证书的 DER 编码做 SHA-256，
# 和 Java 里 X509Certificate.getEncoded() 的结果一致，两边能对上。
FPR_RAW=$(openssl x509 -in "$OUT_DIR/cert.pem" -outform DER \
  | openssl dgst -sha256 -hex | awk '{print $NF}' | tr 'a-f' 'A-F')
FPR_COLON=$(echo "$FPR_RAW" | sed 's/\(..\)/\1:/g; s/:$//')

echo "证书已生成："
echo "  $OUT_DIR/cert.pem"
echo "  $OUT_DIR/key.pem"
echo
echo "有效期：$DAYS 天"
echo
echo "SHA-256 指纹（填进 App 的「证书指纹」框，大小写和冒号都无所谓）："
echo "  $FPR_RAW"
echo "  $FPR_COLON"
echo
echo "启动服务器："
echo "  TLS_CERT=$OUT_DIR/cert.pem \\"
echo "  TLS_KEY=$OUT_DIR/key.pem \\"
echo "  node server/server.js"
