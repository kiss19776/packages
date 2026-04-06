local fs = require "nixio.fs"
local sys = require "luci.sys"
local translate = require "luci.i18n".translate
local http = require "luci.http"

local conffile = "/tmp/online.log"
local update_script = "/etc/openvpn/server/active_user.sh"

f = SimpleForm("active_users_logview", translate("Active Online Users"))
f.reset = false
f.submit = false

btn = f:field(Button, "_refresh")
btn.inputtitle = translate("Refresh Online Users")
btn.inputstyle = "apply"

function btn.write(self, section)
    sys.call(update_script .. " >/dev/null 2>&1")
    http.redirect(http.getenv("REQUEST_URI"))
end

t = f:field(TextValue, "conf")
t.rmempty = true
t.rows = 20
t.readonly = "readonly"
t.template = "cbi/tvalue"

function t.cfgvalue(self, section)
    if not fs.access(update_script) then
        return translate("Error: Update script not found at: ") .. update_script
    end

    local ret = sys.call(update_script .. " >/dev/null 2>&1")
    
    if ret ~= 0 then
        sys.call("logger -t openvpn-luci 'Active user script failed with code: " .. ret .. "'")
    end

    local content = fs.readfile(conffile)
    
    if not content or content == "" then
        return translate("No online users found.\nClick 'Refresh' to update or check OpenVPN service.")
    end
    
    content = content:gsub("\r\n", "\n"):gsub("\r", "\n")
    return content
end

return f
