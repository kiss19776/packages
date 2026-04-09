#!/bin/sh
# 自动添加iroute到系统路由表
for i in $(seq 1 10); do
    eval "iroute=\$iroute_$i"
    [ -n "$iroute" ] && ip route add $iroute dev $dev
done
exit 0
