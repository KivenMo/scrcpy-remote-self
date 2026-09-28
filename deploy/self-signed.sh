#!/bin/bash
# 在 VPS 上生成自签证书（无域名时用这个）
# 用法：bash deploy/self-signed.sh
# 输出：deploy/certs/cert.pem + deploy/certs/key.pem
# 同时打印 SHA-256 指纹（大写十六进制，和 App 端一致）

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="$DIR/certs"
mkdir -p "$CERT_DIR"

# 收集 VPS 上的所有公网 IPv4（也放进 SAN，方便浏览器验证）
IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -8)
SAN="DNS:localhost"
for ip in $IPS; do
  SAN="$SAN,IP:$ip"
done
SAN="$SAN,IP:127.0.0.1"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -days 365 \
  -subj "/CN=remote-assist" \
  -addext "subjectAltName=$SAN"

# 和 App 端、server.js 用同一种算法：对证书 DER 做 SHA-256
FPR=$(openssl x509 -in "$CERT_DIR/cert.pem" -outform DER | openssl dgst -sha256 -binary | xxd -p -u | tr -d '\n')
echo ""
echo "========================================"
echo "自签证书已生成：$CERT_DIR/"
echo ""
echo "指纹（大写十六进制，和 App 端一致）："
echo "$FPR"
echo ""
echo "App 端可选操作："
echo "  · 留空指纹框 → 第一次连接自动 TOFU（推荐，最省事）"
echo "  · 把上面指纹填进「加密连接」框 → 严格 pin（更保险）"
echo "========================================"
