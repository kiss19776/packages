module("luci.controller.homepage", package.seeall)

function index()
    -- 注册你的首页
    entry({"admin", "homepage"}, view("homepage/index"), _("首页"), 1).dependent = false
end
