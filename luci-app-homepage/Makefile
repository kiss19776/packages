include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-homepage
PKG_VERSION:=1.0
PKG_RELEASE:=1

LUCI_TITLE:=Homepage Dashboard
LUCI_DEPENDS:=+luci-base +luci-lib-ip +luci-compat +ubus

# 引入 LuCI 构建规则 (luci.mk 内部会自动处理 BuildPackage 调用)
include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/luci/luci.mk

# 删除下面这一行，因为它导致了重复
# $(eval $(call BuildPackage,$(PKG_NAME))) 
