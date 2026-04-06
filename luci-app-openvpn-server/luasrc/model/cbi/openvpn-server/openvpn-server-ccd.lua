--[[
LuCI - OpenVPN Server CCD Configuration (Standalone)
- No UCI dependency
- Compatible with OpenWrt 23.05+ (ucode backend)
- Shows Client IP and Static Routes in file list
- "Add New User" section removed as requested
]]--

local fs = require "nixio.fs"
local http = require "luci.http"
local translate = require "luci.i18n".translate
local disp = require "luci.dispatcher"

-- Create a Map (config name is arbitrary, not used for UCI)
m = Map("openvpn", translate("CCD Configuration"),
        translate("Manage Client Config Directory (CCD) files for fixed IPs and static routes."))

local ccd_dir = "/etc/openvpn/server/ccd"

-- Ensure CCD directory exists
if not fs.stat(ccd_dir) then
    fs.mkdir(ccd_dir, 755)
end

-- Show status message if any
local status = http.formvalue("status")
if status == "deleted" then
    m.message = translate("✓ CCD file deleted successfully.")
elseif status == "error" then
    m.message = translate("⚠️ Operation failed.")
end

-- ========== Main Form (Create/Edit) ==========
s = m:section(SimpleSection)

local form_html = s:option(DummyValue, "_form")
form_html.rawhtml = true

function form_html.cfgvalue(self, section)
    local pre_user, pre_ip, pre_peer, pre_routes = "", "", "255.255.255.0", ""

    -- Pre-fill if loading existing user
    local action = http.formvalue("action")
    local user_param = http.formvalue("user")
    if action == "load" and user_param and user_param ~= "" and not user_param:match("[^%w%-%._]") then
        local path = ccd_dir .. "/" .. user_param
        if fs.access(path) then
            local f = io.open(path, "r")
            if f then
                local content = f:read("*a")
                f:close()
                local _, ip, peer = content:match("(ifconfig%-push%s+)([%d%.]+)%s+([%d%.]+)")
                if ip and peer then
                    pre_user, pre_ip, pre_peer = user_param, ip, peer
                end
                local routes = ""
                for line in content:gmatch("[^\r\n]+") do
                    if line:match("^%s*iroute%s+") then
                        routes = routes .. line:gsub("^%s*iroute%s+", "", 1) .. "\n"
                    end
                end
                if routes ~= "" then
                    pre_routes = routes
                end
            end
        end
    end

    return string.format([[
<div class="cbi-section">
    <h3>%s</h3>
    <div class="cbi-value">
        <label class="cbi-value-title">%s</label>
        <div class="cbi-value-field">
            <input type="text" name="ccd_username" value="%s" class="cbi-input-text" required />
        </div>
    </div>
    <div class="cbi-value">
        <label class="cbi-value-title">%s</label>
        <div class="cbi-value-field">
            <input type="text" name="ccd_client_ip" value="%s" class="cbi-input-text" placeholder="10.8.0.xxx" required />
        </div>
    </div>
    <div class="cbi-value">
        <label class="cbi-value-title">%s</label>
        <div class="cbi-value-field">
            <input type="text" name="ccd_peer_ip" value="%s" class="cbi-input-text" placeholder="255.255.255.0" required />
        </div>
    </div>
    <div class="cbi-value">
        <label class="cbi-value-title">%s</label>
        <div class="cbi-value-field">
            <textarea name="ccd_routes" rows="3" class="cbi-input-textarea" style="width:100%%;">%s</textarea>
            <div class="cbi-value-description">%s</div>
        </div>
    </div>
    <div class="cbi-page-actions">
        <button class="cbi-button cbi-button-apply" type="submit" name="save_ccd" value="1">%s</button>
    </div>
</div>
    ]],
    translate("Create / Edit CCD"),
    translate("Username"), pre_user,
    translate("Client IP Address"), pre_ip,
    translate("Subnet Mask"), pre_peer,
    translate("Static Routes (iroute)"), pre_routes:gsub("\n", "&#10;"),
    translate("One route per line, e.g.: 192.168.10.0 255.255.255.0"),
    translate("Save / Update")
    )
end

-- ========== Save Logic ==========
function m.on_after_save(map)
    if http.formvalue("save_ccd") then
        local user = http.formvalue("ccd_username")
        local ip   = http.formvalue("ccd_client_ip")
        local peer = http.formvalue("ccd_peer_ip")
        local rt   = http.formvalue("ccd_routes")

        local err = false
        if not user or user:match("^%s*$") then
            m.message = translate("Error: Username cannot be empty!")
            err = true
        elseif user:match("[^%w%-%._]") then
            m.message = translate("Error: Username contains invalid characters!")
            err = true
        elseif not ip or ip:match("^%s*$") then
            m.message = translate("Error: Client IP address cannot be empty!")
            err = true
        elseif not peer or peer:match("^%s*$") then
            m.message = translate("Error: Subnet Mask cannot be empty!")
            err = true
        end

        if not err then
            local content = "# CCD for " .. user .. "\n"
            content = content .. "ifconfig-push " .. ip .. " " .. peer .. "\n"
            if rt and not rt:match("^%s*$") then
                for line in rt:gmatch("[^\r\n]+") do
                    line = line:gsub("^%s+", ""):gsub("%s+$", "")
                    if line ~= "" and not line:match("^#") then
                        content = content .. "iroute " .. line .. "\n"
                    end
                end
            end
            if fs.writefile(ccd_dir .. "/" .. user, content) then
                m.message = translate("Success: CCD file saved for ") .. user
            else
                m.message = translate("Error: Failed to write file.")
            end
        end
    end
end

-- ========== Existing Files List (with IP + Routes) ==========
s_list = m:section(SimpleSection, nil, translate("Existing CCD Files"))
list_html = s_list:option(DummyValue, "_list")
list_html.rawhtml = true

function list_html.cfgvalue()
    local files = {}
    if fs.stat(ccd_dir) then
        for filename in fs.dir(ccd_dir) do
            if filename ~= "." and filename ~= ".." and not filename:match("^%..*") then
                table.insert(files, filename)
            end
        end
    end

    if #files == 0 then
        return translate("No CCD files found.")
    end

    table.sort(files)

    local edit_base = disp.build_url("admin", "vpn", "openvpn-server", "ccd-config")
    local del_base = disp.build_url("admin", "vpn", "openvpn-server", "ccd-delete")

    local html = [[
    <table class="table" style="width:100%; border-collapse:collapse; margin-top:10px;">
    <thead>
    <tr style="background:#f5f5f5;">
        <th style="padding:8px; border:1px solid #ddd; text-align:left;">]]..translate("Username")..[[</th>
        <th style="padding:8px; border:1px solid #ddd; text-align:left;">]]..translate("Client IP")..[[</th>
        <th style="padding:8px; border:1px solid #ddd; text-align:left; min-width:180px;">]]..translate("Static Routes (iroute)")..[[</th>
        <th style="padding:8px; border:1px solid #ddd; text-align:left;">]]..translate("Actions")..[[</th>
    </tr>
    </thead>
    <tbody>
    ]]

    for _, filename in ipairs(files) do
        local filepath = ccd_dir .. "/" .. filename
        local client_ip = ""
        local routes = {}

        if fs.access(filepath) then
            local f = io.open(filepath, "r")
            if f then
                for line in f:lines() do
                    if line:match("^%s*ifconfig%-push%s+") then
                        local ip1 = line:match("ifconfig%-push%s+([%d%.]+)")
                        if ip1 then client_ip = ip1 end
                    end
                    if line:match("^%s*iroute%s+") then
                        local route = line:gsub("^%s*iroute%s+", "", 1):gsub("%s+$", "")
                        if route ~= "" then
                            table.insert(routes, route)
                        end
                    end
                end
                f:close()
            end
        end

        local routes_display = #routes > 0 and table.concat(routes, "<br>") or "<em>" .. translate("None") .. "</em>"
        local edit_url = edit_base .. "?action=load&user=" .. http.urlencode(filename)
        local del_url = del_base .. "?user=" .. http.urlencode(filename)

        html = html .. string.format([[
        <tr>
            <td style="padding:8px; border:1px solid #ddd; font-weight:bold;">%s</td>
            <td style="padding:8px; border:1px solid #ddd;">%s</td>
            <td style="padding:8px; border:1px solid #ddd; font-family:monospace; font-size:13px;">%s</td>
            <td style="padding:8px; border:1px solid #ddd;">
                <a href="%s" style="color:#2f80ed; margin-right:8px;">%s</a>
                <a href="%s" onclick="return confirm('%s')" style="color:red;">%s</a>
            </td>
        </tr>
        ]],
        filename,
        client_ip or "<em>" .. translate("Not set") .. "</em>",
        routes_display,
        edit_url, translate("Edit"),
        del_url, translate("Delete %s?"):format(filename), translate("Delete")
        )
    end

    html = html .. "</tbody></table>"
    return html
end

return m
