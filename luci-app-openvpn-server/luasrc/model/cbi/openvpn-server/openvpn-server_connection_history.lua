local fs = require "nixio.fs"
local sys = require "luci.sys"
local translate = require "luci.i18n".translate
local http = require "luci.http"

local conffile = "/etc/openvpn/online_history.log"
local update_script = "/etc/openvpn/server/record_history.sh"

f = SimpleForm("logview", translate("Online Users Log"))
f.reset = false
f.submit = false

btn = f:field(Button, "_refresh")
btn.inputtitle = translate("Refresh Online Users")
btn.inputstyle = "apply"
btn.template = "cbi/button"

function btn.write(self, section)
    sys.call(update_script .. " >/dev/null 2>&1")
    http.redirect(http.getenv("REQUEST_URI"))
end

t = f:field(TextValue, "conf")
t.rmempty = true
t.rows = 25
t.readonly = "readonly"
t.template = "cbi/tvalue"

function t.cfgvalue(self, section)
    if not fs.access(update_script) then
        return translate("错误：更新脚本不存在！\n路径: ") .. update_script
    end

    local ret = sys.call(update_script .. " >/dev/null 2>&1")
    
    if ret ~= 0 then
        sys.call("logger -t openvpn-luci 'Script execution failed with code: " .. ret .. "'")
    end

    if not fs.access(conffile) then
        return translate("历史记录文件未找到。\n脚本已尝试运行，但未能生成文件。\n请检查 OpenVPN 服务状态及脚本权限。")
    end
    
    local content = fs.readfile(conffile)
    
    if not content or content == "" then
        return translate("暂无用户连接记录。\n请连接客户端后点击刷新。")
    end
    
    content = content:gsub("\r\n", "\n"):gsub("\r", "\n")
    
    return content
end

return f
