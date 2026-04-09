#!/bin/sh
# /etc/openvpn/del-route.sh
# 在客户端断开连接时删除iroute对应的系统路由
# 环境变量参考: https://openvpn.net/community-resources/reference-manual-for-openvpn-2-4/

# 记录日志
LOG_TAG="openvpn-del-route"
logger -t "$LOG_TAG" "客户端断开: common_name=$common_name, trusted_ip=$trusted_ip"

# 删除iroute路由
for i in $(seq 1 20); do
    # 获取iroute_1, iroute_2, ... 等变量
    eval "iroute=\$iroute_$i"
    
    if [ -n "$iroute" ]; then
        logger -t "$LOG_TAG" "删除路由: $iroute -> dev $dev"
        
        # 删除路由（忽略不存在的路由错误）
        ip route del $iroute dev $dev 2>/dev/null
        if [ $? -eq 0 ]; then
            logger -t "$LOG_TAG" "成功删除路由: $iroute"
        else
            logger -t "$LOG_TAG" "路由不存在或删除失败: $iroute"
        fi
    fi
done

# 清理可能的内存缓存
if [ -n "$ifconfig_pool_remote_ip" ]; then
    ip neigh flush dev $dev 2>/dev/null
fi

exit 0
