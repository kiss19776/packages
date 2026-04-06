#!/bin/sh
###########################################################
# checkpsw.sh (C) 2004 Mathias Sundman 
# Modified: Log output translated to Chinese
#
# 此脚本用于针对纯文本文件验证 OpenVPN 用户。
# 密码文件应仅包含每行一个用户，格式为：用户名 [空格/Tab] 密码。

PASSFILE="/etc/openvpn/server/psw-file"
LOG_FILE="/tmp/openvpn-password.log"
TIME_STAMP=`date "+%Y-%m-%d %T"`

###########################################################


if [ ! -r "${PASSFILE}" ]; then
  echo "${TIME_STAMP}: 错误：无法打开密码文件 \"${PASSFILE}\" 进行读取。" >> ${LOG_FILE}
  exit 1
fi

CORRECT_PASSWORD=`awk '!/^;/&&!/^#/&&$1=="'${username}'"{print $2;exit}' ${PASSFILE}`

if [ "${CORRECT_PASSWORD}" = "" ]; then
  echo "${TIME_STAMP}: 用户不存在：用户名=\"${username}\", 输入密码=\"${password}\"。" >> ${LOG_FILE}
  exit 1
fi

if [ "${password}" = "${CORRECT_PASSWORD}" ]; then
  echo "${TIME_STAMP}: 认证成功：用户名=\"${username}\"。" >> ${LOG_FILE}
  exit 0
fi

echo "${TIME_STAMP}: 密码错误：用户名=\"${username}\", 输入密码=\"${password}\"。" >> ${LOG_FILE}
exit 1
