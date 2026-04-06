module("luci.controller.openvpn-server", package.seeall)

local fs = require "nixio.fs"

function index()
    if not fs.access("/etc/config/openvpn") then
        return
    end
    
    entry({"admin", "vpn", "openvpn-server"}, firstchild(), _("OpenVPN Server"), 1).dependent = true

    entry({"admin", "vpn", "openvpn-server", "general"}, cbi("openvpn-server/openvpn-server"), _("OpenVPN Server"), 1).leaf = true
    entry({"admin", "vpn", "openvpn-server", "log"}, form("openvpn-server/openvpn-server_run_log"), _("Running log"), 2).leaf = true
    entry({"admin", "vpn", "openvpn-server", "passlog"}, form("openvpn-server/openvpn-server_pass_log"), _("Login log"), 3).leaf = true
    entry({"admin", "vpn", "openvpn-server", "onlinelog"}, form("openvpn-server/openvpn-server_online_log"), _("online log"), 4).leaf = true
    
    entry({"admin", "vpn", "openvpn-server", "ccd-config"}, 
          cbi("openvpn-server/openvpn-server-ccd"), 
          _("CCD Configuration"), 5).leaf = true

    entry({"admin", "vpn", "openvpn-server", "ccd-delete"}, call("act_ccd_delete")).leaf = true

    entry({"admin", "vpn", "openvpn-server", "connection_history_log"}, form("openvpn-server/openvpn-server_connection_history"), _("connection_history"), 6).leaf = true
    entry({"admin", "vpn", "openvpn-server", "status"}, call("act_status")).leaf = true
end

function act_status()
    local e = {}
    e.running = luci.sys.call("pgrep openvpn >/dev/null") == 0
    luci.http.prepare_content("application/json")
    luci.http.write_json(e)
end

function act_ccd_delete()
    local user = luci.http.formvalue("user")
    local ccd_dir = "/etc/openvpn/server/ccd"
    
    if user and user ~= "" then
        if not user:match("[^%w_%-.]") then
            local filepath = ccd_dir .. "/" .. user
            if fs.access(filepath) then
                if fs.remove(filepath) then
                    luci.http.redirect(luci.dispatcher.build_url("admin", "vpn", "openvpn-server", "ccd-config") .. "?status=deleted")
                    return
                end
            end
        end
    end
    luci.http.redirect(luci.dispatcher.build_url("admin", "vpn", "openvpn-server", "ccd-config") .. "?status=error")
end
