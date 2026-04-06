适用于 ImmortalWrt, openwrt 24.10 及以上的分支.

## 插件说明

### 首页插件
首页插件只为美化一下，用AI生成。

### OpenVPN 服务端插件
openvpn服务端插件为网上收集到的插件重新用AI修改更易用。

### OpenVPN 客户端插件
openvpn客户端插件为网上收集到的插件重新用AI修改更易用，客户端优化适应ntf规则和添加推送路由.
初次使用记得重新生成修改证书和key.
## 插件截图

### 首页插件
![首页插件](doc/homepage.png)

### OpenVPN 服务端
![OpenVPN 服务端1](doc/openvpn.png)
![OpenVPN 服务端2](doc/openvpn1.png)
![OpenVPN 服务端3](doc/openvpn2.png)

## 安装方法

### 源码编译
1. 将插件目录复制到 OpenWrt 源码的 package 目录下
2. 运行 `make menuconfig`
3. 在 LuCI -> Applications 中选择相应的插件
4. 编译并安装

## 文件结构
- luci-app-homepage/ - 首页插件
- luci-app-openvpn-server/ - OpenVPN 服务端插件
- luci-app-openvpn-client/ - OpenVPN 客户端插件
- doc/ - 插件截图
  - homepage.png
  - openvpn.png
  - openvpn1.png
  - openvpn2.png

## 致谢
- 感谢 ImmortalWrt 和 OpenWrt 项目
- 感谢原插件作者
- AI 辅助优化

