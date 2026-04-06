#!/bin/sh

# 配置文件路径
UCI_CONF="/etc/config/openvpn"
CONFIG_NAME="myvpn"
TA_KEY_PATH="/etc/openvpn/ta.key"
OUTPUT_FILE="/tmp/my.ovpn"

# 1. 获取基础配置
ddns=`uci get openvpn.${CONFIG_NAME}.ddns`
port=`uci get openvpn.${CONFIG_NAME}.port`
proto=`uci get openvpn.${CONFIG_NAME}.proto`
comp_lzo_val=`uci get openvpn.${CONFIG_NAME}.comp_lzo 2>/dev/null`

# 2. 判断是否启用 ta.key
if grep -A 50 "config openvpn '${CONFIG_NAME}'" "$UCI_CONF" | grep -q "^[\t ]*option tls_auth"; then
    ENABLE_TA=1
fi

# 3. 生成基础配置
cat > "$OUTPUT_FILE" <<EOF
client
dev tun
proto $proto
remote $ddns $port
resolv-retry infinite
nobind
persist-key
persist-tun
verb 3
EOF

# 4. 判断并添加 comp-lzo 配置
if [ "$comp_lzo_val" = "yes" ] || [ "$comp_lzo_val" = "1" ]; then
    echo "comp-lzo yes" >> "$OUTPUT_FILE"
fi

# 5. 嵌入 CA 证书
echo '<ca>' >> "$OUTPUT_FILE"
cat /etc/openvpn/ca.crt >> "$OUTPUT_FILE"
echo '</ca>' >> "$OUTPUT_FILE"

# 6. 嵌入客户端证书
if [ -f /etc/openvpn/client1.crt ]; then
    echo '<cert>' >> "$OUTPUT_FILE"
    cat /etc/openvpn/client1.crt >> "$OUTPUT_FILE"
    echo '</cert>' >> "$OUTPUT_FILE"
fi

# 7. 嵌入客户端私钥
if [ -f /etc/openvpn/client1.key ]; then
    echo '<key>' >> "$OUTPUT_FILE"
    cat /etc/openvpn/client1.key >> "$OUTPUT_FILE"
    echo '</key>' >> "$OUTPUT_FILE"
fi

# 8. 处理 ta.key (TLS Auth)
if [ "$ENABLE_TA" = "1" ]; then
    if [ -f "$TA_KEY_PATH" ]; then
        echo 'tls-auth' >> "$OUTPUT_FILE"
        echo 'key-direction 1' >> "$OUTPUT_FILE"
        echo '<tls-auth>' >> "$OUTPUT_FILE"
        cat "$TA_KEY_PATH" >> "$OUTPUT_FILE"
        echo '</tls-auth>' >> "$OUTPUT_FILE"
    fi
fi

# 9. 追加额外配置
[ -f /etc/ovpnadd.conf ] && cat /etc/ovpnadd.conf >> "$OUTPUT_FILE"

echo "配置文件已生成: $OUTPUT_FILE"
