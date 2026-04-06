#!/bin/sh

STATUS_FILE="/var/log/openvpn_status.log"
HISTORY_FILE="/etc/openvpn/online_history.log"
LAST_ONLINE_FILE="/tmp/.ovpn_last_status"
TMP_NEW_HISTORY="/tmp/ovpn_history_new.tmp"
TMP_CURRENT_ONLINE="/tmp/ovpn_current_online.tmp"

CURRENT_TIME=$(date '+%Y-%m-%d %H:%M:%S')
CURRENT_DATE=$(date '+%Y-%m-%d')
RETENTION_DAYS=30
CUTOFF_DATE=$(date -d "${RETENTION_DAYS} days ago" '+%Y-%m-%d' 2>/dev/null || date -v-${RETENTION_DAYS}d '+%Y-%m-%d' 2>/dev/null || echo "2020-01-01")

cleanup() { rm -f "$TMP_NEW_HISTORY" "$TMP_CURRENT_ONLINE"; }
trap cleanup EXIT INT TERM

touch "$HISTORY_FILE"
: > "$TMP_NEW_HISTORY"
: > "$TMP_CURRENT_ONLINE"

if [ -f "$STATUS_FILE" ]; then
    awk -F',' '
        { gsub(/\r/, "") }
        /CLIENT LIST/ { in_client = 1; next }
        /ROUTING TABLE/ { exit }
        in_client {
            if ($1 == "Common Name" || $1 == "Updated" || $1 ~ /^Max /) next
            if (NF > 0 && $1 != "" && $1 !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) print $1
        }
    ' "$STATUS_FILE" | sort -u > "$TMP_CURRENT_ONLINE"
fi

awk -v current_time="$CURRENT_TIME" -v current_date="$CURRENT_DATE" -v cutoff="$CUTOFF_DATE" -v current_file="$TMP_CURRENT_ONLINE" '
BEGIN {
    while ((getline user < current_file) > 0) {
        gsub(/\r/, "", user)
        if (user != "") {
            current_users[user] = 1
            needs_add[user] = 1
        }
    }
    close(current_file)
}
{
    line = $0
    gsub(/\r/, "", line)
    if (line ~ /^[[:space:]]*$/) next

    match(line, /^[^ \t]+/)
    user = substr(line, RSTART, RLENGTH)
    if (user == "") next

    is_finished = (line ~ /下线时间：.*[0-9]{4}/)
    is_online = (user in current_users)

    if (is_online) {
        if (!is_finished) {
            needs_add[user] = 0
            print line
        } else {
            print line
        }
    } else {
        if (!is_finished) {
            sub(/下线时间：.*$/, "下线时间：" current_time, line)
            print line
        } else {
            if (match(line, /[0-9]{4}-[0-9]{2}-[0-9]{2}/)) {
                record_date = substr(line, RSTART, RLENGTH)
                if (record_date >= cutoff) {
                    print line
                }
            } else {
                print line
            }
        }
    }
}
END {
    for (user in needs_add) {
        if (needs_add[user] == 1) {
            printf "%s 上线时间：%s 下线时间：\n", user, current_time
        }
    }
}
' "$HISTORY_FILE" > "$TMP_NEW_HISTORY"

if [ -s "$TMP_NEW_HISTORY" ]; then
    if ! cmp -s "$TMP_NEW_HISTORY" "$HISTORY_FILE"; then
        mv "$TMP_NEW_HISTORY" "$HISTORY_FILE"
    fi
fi

if [ -s "$TMP_CURRENT_ONLINE" ]; then
    cp "$TMP_CURRENT_ONLINE" "$LAST_ONLINE_FILE"
else
    : > "$LAST_ONLINE_FILE"
fi
