local d = require "luci.dispatcher"
local sys = require "luci.sys"

m = Map("luci-app-openvpn-client", translate("OpenVPN Client"))
m.apply_on_parse = true

s = m:section(TypedSection, "clients", translate("Client List"))
s.addremove = true
s.anonymous = true
s.template = "cbi/tblsection"
s.extedit = d.build_url("admin", "vpn", "openvpn-client", "client", "%s")
function s.create(e, t)
    t = TypedSection.create(e, t)
    luci.http.redirect(e.extedit:format(t))
end

o = s:option(Flag, "enabled", translate("Enabled"))
o.default = 1
o.rmempty = false

-- 获取指定客户端实例的PID
function s.getPID(section) -- 返回有效pid号或nil的通用函数
    local pid = sys.exec("top -bn1 | grep -v 'grep' | grep '/var/etc/openvpn-client/" .. section .. "'")
    if pid and #pid > 0 then
        return tonumber(pid:match("^%s*(%d+)"))
    else
        return nil
    end
end

-- 新增：获取虚拟IP（从 /var/etc/openvpn-client/{section}/ip）
function s.getVirtualIP(section)
    local path = "/var/etc/openvpn-client/" .. section .. "/ip"
    local ip = sys.exec("cat " .. path .. " 2>/dev/null")
    if ip and #ip > 0 then
        return ip:gsub("\n", ""):gsub("%s+", "") -- 去除换行和空格
    else
        return translate("N/A")
    end
end

-- 状态显示列
local active = s:option(DummyValue, "_active", translate("Status"))
function active.cfgvalue(self, section)
    local pid = s.getPID(section)
    if pid ~= nil then
        if sys.process.signal(pid, 0) then
            active.rawhtml = true
            local onclick = string.format("window.open('%s', '_blank')", d.build_url("admin", "vpn", "openvpn-client", "log") .. "?id=" .. section)
            return translate("RUNNING") .. " (" .. pid .. ")" .. '&nbsp&nbsp<a href="#" onclick="' .. onclick .. '">' .. translate("Log") .. '</a>'
        end
    end
    return translate("NOT RUNNING")
end

-- 新增：Virtual IP 列（中文显示）
local vip = s:option(DummyValue, "_virtual_ip", translate("虚拟IP"))
function vip.cfgvalue(self, section)
    return s.getVirtualIP(section)
end

-- 启动/停止按钮
local updown = s:option(Button, "_updown", translate("Start/Stop"))
updown._state = false
updown.redirect = d.build_url(
    "admin", "vpn", "openvpn-client"
)
function updown.cbid(self, section)
    local pid = s.getPID(section)
    self._state = pid ~= nil and sys.process.signal(pid, 0)
    self.option = self._state and "stop" or "start"
    return AbstractValue.cbid(self, section)
end
function updown.cfgvalue(self, section)
    self.title = self._state and translate("stop") or translate("start")
    self.inputstyle = self._state and "reset" or "reload"
end
function updown.write(self, section, value)
    if self.option == "stop" then
        -- RUNNING
        sys.call("/etc/init.d/luci-app-openvpn-client stop " .. section)
    else
        -- NOT RUNNING
        sys.call("/etc/init.d/luci-app-openvpn-client start " .. section)
    end
    luci.http.redirect( self.redirect )
end

o = s:option(DummyValue, "server", translate("Server IP/Host"))
o = s:option(DummyValue, "port", translate("Port"))
o = s:option(DummyValue, "proto", translate("Protocol"))

function s.remove(self, section)
    sys.call("/etc/init.d/luci-app-openvpn-client stop " .. section)
    return TypedSection.remove(self, section)
end

return m
