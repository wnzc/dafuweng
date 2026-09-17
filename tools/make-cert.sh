#!/usr/bin/env bash
# 生成本地调试用的自签 HTTPS 证书（.cert/key.pem + .cert/cert.pem）
#
# 为什么需要：tools/serve-https.mjs 必须跑 HTTPS，手机上的震动反馈
# （navigator.vibrate）才可用 —— 该 API 只在安全上下文里开放。
#
# 证书不纳入 git（见 .gitignore）。换网络 / 换设备后重跑一次即可：
# 脚本会自动把本机当前所有 IPv4 写进 SAN，避免「证书与访问地址不匹配」。
#
# 用法：bash tools/make-cert.sh
#
# 装到手机上（iPhone）：
#   1. AirDrop 或隔空把 .cert/cert.pem 传过去，安装描述文件
#   2. 设置 → 通用 → 关于本机 → 证书信任设置 → 打开该证书的开关
#   换新证书后这两步要重做一次。

set -euo pipefail
cd "$(dirname "$0")/.."

CERT_DIR=".cert"
DAYS=825   # Apple 规定手动安装的 TLS 证书有效期不得超过 825 天，超了会不被信任

mkdir -p "$CERT_DIR"

# 收集本机所有活动 IPv4，全部写进 SAN
SANS="DNS:localhost,IP:127.0.0.1"
CN="localhost"
default_if="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
for iface in $(ifconfig -l); do
  ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
  [ -z "$ip" ] && continue
  case "$ip" in 127.*) continue ;; esac
  SANS="$SANS,IP:$ip"
  [ "$iface" = "$default_if" ] && CN="$ip"
done

CONF="$CERT_DIR/openssl.cnf"
cat > "$CONF" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no

[dn]
CN = $CN

[v3]
subjectAltName   = $SANS
basicConstraints = critical, CA:TRUE
keyUsage         = critical, digitalSignature, keyEncipherment, keyCertSign
extendedKeyUsage = serverAuth
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -config "$CONF" 2>/dev/null
chmod 600 "$CERT_DIR/key.pem"

echo "已生成自签证书"
echo "  CN  = $CN"
echo "  SAN = $SANS"
openssl x509 -in "$CERT_DIR/cert.pem" -noout -dates | sed 's/^/  /'
echo "  -> $CERT_DIR/key.pem, $CERT_DIR/cert.pem"
