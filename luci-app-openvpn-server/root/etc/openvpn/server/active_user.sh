#!/bin/sh

STATUS_FILE="/var/log/openvpn_status.log"
OUTPUT_FILE="/tmp/online.log"
MAPPING_TMP="/tmp/.openvpn_mapping.$$"

cleanup() {
    rm -f "$MAPPING_TMP"
}
trap cleanup EXIT INT TERM

{
    echo "用户名 虚拟IP 真实IP 流量数据"
} > "$OUTPUT_FILE"

if [ ! -f "$STATUS_FILE" ]; then
    echo "状态文件 $STATUS_FILE 不存在" >> "$OUTPUT_FILE"
    exit 0
fi

# 创建临时文件存储映射关系
> "$MAPPING_TMP"

# 先处理ROUTING TABLE部分，建立Common Name到虚拟IP的映射
# 只记录单点IP，忽略子网IP
in_routing=false
while IFS= read -r line; do
    case "$line" in
        "ROUTING TABLE")
            in_routing=true
            continue
            ;;
        "GLOBAL STATS"*|"END"|"Common Name,Real Address,Bytes Received,Bytes Sent,Connected Since")
            in_routing=false
            continue
            ;;
    esac

    if [ "$in_routing" = true ]; then
        # 跳过表头
        case "$line" in
            Virtual\ Address,*)
                continue
                ;;
        esac

        # 使用逗号分割
        IFS=',' read -r virtual_address username real_address last_ref <<EOF
$line
EOF
        
        if [ -n "$virtual_address" ] && [ -n "$username" ] && [ -n "$real_address" ]; then
            # 提取真实IP（去掉端口）
            real_ip="${real_address%:*}"
            
            # 只记录单点IP，忽略子网IP
            # 检查是否是子网地址（包含/）
            if echo "$virtual_address" | grep -q '/'; then
                # 是子网地址，跳过
                continue
            else
                # 是单点地址，如10.9.0.2
                virtual_ip="$virtual_address"
                
                # 存储映射：使用用户名+真实IP作为key
                printf '%s-%s %s\n' "$username" "$real_ip" "$virtual_ip" >> "$MAPPING_TMP"
            fi
        fi
    fi
done < "$STATUS_FILE"

# 处理CLIENT LIST部分
in_client=false
found_users=0

while IFS= read -r line; do
    case "$line" in
        "Common Name,Real Address,Bytes Received,Bytes Sent,Connected Since")
            in_client=true
            continue
            ;;
        "ROUTING TABLE"*)
            in_client=false
            continue
            ;;
    esac

    if [ "$in_client" = true ]; then
        # 跳过空行和可能的表头
        case "$line" in
            ""|"Common Name"*)
                continue
                ;;
        esac

        # 使用逗号分割
        IFS=',' read -r username real_address bytes_received bytes_sent connected_since <<EOF
$line
EOF
        
        if [ -z "$username" ] || [ -z "$real_address" ]; then
            continue
        fi

        # 提取真实IP
        real_ip="${real_address%:*}"

        # 查找对应的虚拟IP
        virtual_ip=$(awk -v key="$username-$real_ip" '
            $1 == key { print $2; exit }
        ' "$MAPPING_TMP")
        
        if [ -z "$virtual_ip" ]; then
            # 如果在映射表中没找到，尝试只通过用户名查找
            # 可能有多个连接，取第一个
            virtual_ip=$(awk -v name="$username" '
                index($1, name "-") == 1 { print $2; exit }
            ' "$MAPPING_TMP")
        fi
        
        virtual_ip=${virtual_ip:-N/A}

        # 计算流量
        total_bytes=0
        case "$bytes_received" in
            ''|*[!0-9]*) bytes_received=0 ;;
        esac
        case "$bytes_sent" in
            ''|*[!0-9]*) bytes_sent=0 ;;
        esac
        total_bytes=$((bytes_received + bytes_sent))

        # 格式化流量显示
        if [ "$total_bytes" -lt 1024 ]; then
            flow_data="${total_bytes} B"
        elif [ "$total_bytes" -lt 1048576 ]; then
            flow_data="$((total_bytes / 1024)) KB"
        elif [ "$total_bytes" -lt 1073741824 ]; then
            flow_data="$((total_bytes / 1048576)) MB"
        else
            flow_data="$((total_bytes / 1073741824)) GB"
        fi

        printf '%s %s %s %s\n' "$username" "$virtual_ip" "$real_ip" "$flow_data" >> "$OUTPUT_FILE"
        found_users=$((found_users + 1))
    fi
done < "$STATUS_FILE"

if [ "$found_users" -eq 0 ]; then
    echo "当前没有在线用户" >> "$OUTPUT_FILE"
fi

exit 0
