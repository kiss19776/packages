'use strict';
'require view';
'require fs';
'require dom';

function execCmd(cmd, args) {
    return L.resolveDefault(fs.exec(cmd, args), null);
}

function fmtBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KiB';
    else if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MiB';
    else return (bytes / 1073741824).toFixed(2) + ' GiB';
}

function unquote(str) {
    if (typeof str === 'string' && str.startsWith('"') && str.endsWith('"')) {
        return str.slice(1, -1);
    }
    return str;
}

// ===========================
// 流量监控相关函数
// ===========================

var trafficHistory = {}; 
var globalTrafficRate = { rx: 0, tx: 0, unit: 'KB/s' };

function fmtRate(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 0) return '0 B/s';
    if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
    else if (bytesPerSec < 1048576) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    else if (bytesPerSec < 1073741824) return (bytesPerSec / 1048576).toFixed(2) + ' MB/s';
    else return (bytesPerSec / 1073741824).toFixed(2) + ' GB/s';
}

function getAllInterfaceTraffic() {
    return new Promise((resolve) => {
        fs.exec('cat', ['/proc/net/dev']).then(procOut => {
            if (!procOut || procOut.code !== 0) {
                resolve({ interfaces: {}, totalRx: 0, totalTx: 0, unit: 'KB/s' });
                return;
            }

            const lines = procOut.stdout.split('\n');
            const now = Date.now();
            const interfaceRates = {};
            let totalRxRate = 0;
            let totalTxRate = 0;

            for (let i = 2; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                const parts = line.split(/:\s+/);
                if (parts.length !== 2) continue;
                const ifaceName = parts[0].trim();
                if (ifaceName === 'lo') continue;

                const stats = parts[1].trim().split(/\s+/);
                if (stats.length < 9) continue;

                const currentRx = parseInt(stats[0], 10);
                const currentTx = parseInt(stats[8], 10);

                if (!trafficHistory[ifaceName]) {
                    trafficHistory[ifaceName] = { time: now, rx: currentRx, tx: currentTx };
                    interfaceRates[ifaceName] = { rx: 0, tx: 0 };
                    continue;
                }

                const history = trafficHistory[ifaceName];
                const timeDiff = (now - history.time) / 1000;
                let rxRate = 0, txRate = 0;

                if (timeDiff > 0.5) {
                    rxRate = (currentRx - history.rx) / timeDiff;
                    txRate = (currentTx - history.tx) / timeDiff;
                    rxRate = Math.max(0, rxRate);
                    txRate = Math.max(0, txRate);
                }

                trafficHistory[ifaceName] = { time: now, rx: currentRx, tx: currentTx };
                interfaceRates[ifaceName] = { rx: rxRate, tx: txRate };
                totalRxRate += rxRate;
                totalTxRate += txRate;
            }

            let unit = 'KB/s';
            let displayRx = totalRxRate / 1024;
            let displayTx = totalTxRate / 1024;
            
            if (totalRxRate >= 1048576 || totalTxRate >= 1048576) {
                unit = 'MB/s';
                displayRx = totalRxRate / 1048576;
                displayTx = totalTxRate / 1048576;
            } else if (totalRxRate >= 1073741824 || totalTxRate >= 1073741824) {
                unit = 'GB/s';
                displayRx = totalRxRate / 1073741824;
                displayTx = totalTxRate / 1073741824;
            }
            
            globalTrafficRate = { 
                rx: displayRx, 
                tx: displayTx, 
                unit: unit 
            };

            resolve({ 
                interfaces: interfaceRates, 
                totalRx: displayRx, 
                totalTx: displayTx, 
                unit: unit 
            });
        }).catch(() => {
            resolve({ interfaces: {}, totalRx: 0, totalTx: 0, unit: 'KB/s' });
        });
    });
}

// ===========================
// 改进的WAN信息获取函数 - 修复PPPoE检测
// ===========================

function getWanInfo() {
    return new Promise((resolve) => {
        // 方法1: 首先尝试从 network.interface.wan 状态获取
        execCmd('ubus', ['call', 'network.interface.wan', 'status']).then(wanResult => {
            if (wanResult && wanResult.code === 0) {
                try {
                    const wanStatus = JSON.parse(wanResult.stdout);
                    let wan_ip = 'N/A';
                    let wan_gateway = 'N/A';
                    let wan_protocol = 'Unknown';  // 默认值
                    let wan_uptime = wanStatus.uptime || 0;
                    let wan_interface = wanStatus.l3_device || wanStatus.device || '';

                    // 获取IPv4地址
                    if (wanStatus['ipv4-address'] && wanStatus['ipv4-address'].length > 0) {
                        wan_ip = wanStatus['ipv4-address'][0].address;
                    }
                    
                    // 获取IPv6地址
                    let wan_ip6 = 'N/A';
                    if (wanStatus['ipv6-address'] && wanStatus['ipv6-address'].length > 0) {
                        wan_ip6 = wanStatus['ipv6-address'][0].address;
                    }

                    // 获取网关
                    if (wanStatus.route && wanStatus.route.length > 0) {
                        for (let i = 0; i < wanStatus.route.length; i++) {
                            const route = wanStatus.route[i];
                            if (route.target === '0.0.0.0' && route.mask === 0) {
                                wan_gateway = route.nexthop || 'N/A';
                                break;
                            }
                        }
                    }

                    // 首先尝试从配置文件获取协议
                    return execCmd('uci', ['-q', 'get', 'network.wan.proto']).then(protoResult => {
                        if (protoResult && protoResult.code === 0 && protoResult.stdout) {
                            const proto = protoResult.stdout.trim().toUpperCase();
                            
                            if (proto === 'DHCP') {
                                wan_protocol = 'DHCP';
                            } else if (proto === 'PPPOE' || proto === 'PPP') {
                                wan_protocol = 'PPPoE';
                            } else if (proto === 'STATIC' || proto === 'STATICIP') {
                                wan_protocol = '静态';
                            } else {
                                wan_protocol = proto;
                            }
                        } else {
                            // 如果配置文件读取失败，回退到ubus数据解析
                            if (wanStatus.proto === 'pppoe' || wanStatus.proto === 'ppp') {
                                wan_protocol = 'PPPoE';
                            } else if (wanStatus.data) {
                                if (wanStatus.data.ppp) {
                                    wan_protocol = 'PPPoE';
                                } else if (wanStatus.data.dhcp) {
                                    wan_protocol = 'DHCP';
                                } else if (wan_ip !== 'N/A') {
                                    // 有IP但没有DHCP或PPPoE信息，假设是静态IP
                                    wan_protocol = '静态';
                                }
                            } else if (wanStatus.proto) {
                                wan_protocol = wanStatus.proto.toUpperCase();
                            }
                        }

                        // 格式化运行时间
                        let uptime_str = '-';
                        if (wan_uptime > 0) {
                            const up_d = Math.floor(wan_uptime / 86400);
                            const up_h = Math.floor((wan_uptime % 86400) / 3600);
                            const up_m = Math.floor((wan_uptime % 3600) / 60);
                            uptime_str = (up_d > 0 ? up_d + '天 ' : '') + up_h + '小时 ' + up_m + '分';
                        }

                        // 额外检查：如果是DHCP协议，但网关显示为N/A，尝试从DHCP服务器获取
                        if (wan_protocol === 'DHCP' && wan_gateway === 'N/A' && wanStatus.data && wanStatus.data.dhcp) {
                            const dhcp = wanStatus.data.dhcp;
                            if (dhcp.server) {
                                wan_gateway = dhcp.server;
                            }
                        }

                        // 如果是PPPoE，检查是否有PPP信息
                        if (wan_protocol === 'PPPoE' && wanStatus.data && wanStatus.data.ppp) {
                            const ppp = wanStatus.data.ppp;
                            if (ppp.local_ip && wan_ip === 'N/A') {
                                wan_ip = ppp.local_ip;
                            }
                            if (ppp.peer_ip && wan_gateway === 'N/A') {
                                wan_gateway = ppp.peer_ip;
                            }
                        }

                        resolve({
                            wan_ip,
                            wan_ip6,
                            wan_gateway,
                            wan_protocol,
                            wan_uptime: uptime_str,
                            wan_interface,
                            source: 'ubus'
                        });
                    }).catch(() => {
                        // 如果读取配置失败，使用默认值
                        let uptime_str = '-';
                        if (wan_uptime > 0) {
                            const up_d = Math.floor(wan_uptime / 86400);
                            const up_h = Math.floor((wan_uptime % 86400) / 3600);
                            const up_m = Math.floor((wan_uptime % 3600) / 60);
                            uptime_str = (up_d > 0 ? up_d + '天 ' : '') + up_h + '小时 ' + up_m + '分';
                        }
                        
                        resolve({
                            wan_ip,
                            wan_ip6,
                            wan_gateway,
                            wan_protocol,
                            wan_uptime: uptime_str,
                            wan_interface,
                            source: 'fallback'
                        });
                    });
                    return;
                } catch (e) {
                    console.warn('解析WAN状态失败:', e);
                }
            }

            // 方法2: 回退到直接检查配置文件
            execCmd('uci', ['-q', 'get', 'network.wan.proto']).then(protoResult => {
                let wan_protocol = 'Unknown';
                if (protoResult && protoResult.code === 0 && protoResult.stdout) {
                    const proto = protoResult.stdout.trim().toUpperCase();
                    
                    if (proto === 'DHCP') {
                        wan_protocol = 'DHCP';
                    } else if (proto === 'PPPOE' || proto === 'PPP') {
                        wan_protocol = 'PPPoE';
                    } else if (proto === 'STATIC' || proto === 'STATICIP') {
                        wan_protocol = '静态';
                    } else {
                        wan_protocol = proto;
                    }
                }
                
                // 回退到路由表解析获取IP和网关
                execCmd('ip', ['route', 'show']).then(routeResult => {
                    if (!routeResult || routeResult.code !== 0) {
                        resolve({
                            wan_ip: 'N/A',
                            wan_ip6: 'N/A',
                            wan_gateway: 'N/A',
                            wan_protocol,
                            wan_uptime: '-',
                            wan_interface: '',
                            source: 'fallback'
                        });
                        return;
                    }

                    const lines = routeResult.stdout.split('\n');
                    let wan_ip = 'N/A';
                    let wan_gateway = 'N/A';
                    let wan_interface = '';

                    // 查找默认路由
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if (line.startsWith('default')) {
                            const devMatch = line.match(/dev\s+(\S+)/i);
                            wan_interface = devMatch ? devMatch[1] : '';
                            
                            const viaMatch = line.match(/via\s+([0-9a-f.:]+)/i);
                            if (viaMatch) wan_gateway = viaMatch[1];
                            
                            const srcMatch = line.match(/src\s+([0-9a-f.:]+)/i);
                            if (srcMatch) wan_ip = srcMatch[1];
                            break;
                        }
                    }

                    // 如果从路由表没有获取到IP，尝试从接口获取
                    if (wan_ip === 'N/A' && wan_interface) {
                        return execCmd('ip', ['addr', 'show', 'dev', wan_interface]).then(addrResult => {
                            if (addrResult && addrResult.code === 0) {
                                const addrLines = addrResult.stdout.split('\n');
                                for (let j = 0; j < addrLines.length; j++) {
                                    const addrLine = addrLines[j].trim();
                                    if (addrLine.startsWith('inet ')) {
                                        const match = addrLine.match(/inet\s+([0-9.]+)/);
                                        if (match) wan_ip = match[1];
                                        break;
                                    }
                                }
                            }
                            
                            resolve({
                                wan_ip,
                                wan_ip6: 'N/A',
                                wan_gateway,
                                wan_protocol,
                                wan_uptime: '-',
                                wan_interface,
                                source: 'uci+route'
                            });
                        }).catch(() => ({
                            wan_ip,
                            wan_ip6: 'N/A',
                            wan_gateway,
                            wan_protocol,
                            wan_uptime: '-',
                            wan_interface,
                            source: 'uci+route'
                        }));
                    }

                    resolve({
                        wan_ip,
                        wan_ip6: 'N/A',
                        wan_gateway,
                        wan_protocol,
                        wan_uptime: '-',
                        wan_interface,
                        source: 'uci+route'
                    });
                }).catch(() => {
                    resolve({
                        wan_ip: 'N/A',
                        wan_ip6: 'N/A',
                        wan_gateway: 'N/A',
                        wan_protocol: 'Unknown',
                        wan_uptime: '-',
                        wan_interface: '',
                        source: 'error'
                    });
                });
            }).catch(() => {
                // 所有方法都失败
                resolve({
                    wan_ip: 'N/A',
                    wan_ip6: 'N/A',
                    wan_gateway: 'N/A',
                    wan_protocol: 'Unknown',
                    wan_uptime: '-',
                    wan_interface: '',
                    source: 'error'
                });
            });
        }).catch(() => {
            resolve({
                wan_ip: 'N/A',
                wan_ip6: 'N/A',
                wan_gateway: 'N/A',
                wan_protocol: 'Unknown',
                wan_uptime: '-',
                wan_interface: '',
                source: 'error'
            });
        });
    });
}

// ===========================
// 改进的USB接口状态检测函数
// ===========================

function getUsbInterfaceStatus() {
    return new Promise((resolve) => {
        // 先检查所有网络接口，查找USB相关接口
        execCmd('ip', ['link', 'show']).then(linkResult => {
            if (!linkResult || linkResult.code !== 0) {
                resolve(null); // 返回null表示没有USB接口
                return;
            }

            const lines = linkResult.stdout.split('\n');
            let usbInterface = null;
            let usbState = 'down';
            
            // 查找USB相关接口
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || !line.includes(':')) continue;
                
                const ifaceMatch = line.match(/^\d+:\s+([^:@]+)(?:@[^:]+)?:/);
                if (ifaceMatch) {
                    const ifaceName = ifaceMatch[1];
                    
                    // 检查是否是USB接口
                    if (ifaceName.startsWith('usb') || 
                        ifaceName.startsWith('enx') || 
                        ifaceName.includes('usb') ||
                        ifaceName === 'eth1' ||  // 可能也是USB
                        ifaceName === 'eth2') {
                        
                        const stateMatch = line.match(/state\s+(\w+)/i);
                        const operstate = stateMatch ? stateMatch[1].toLowerCase() : 'unknown';
                        
                        usbInterface = ifaceName;
                        usbState = (operstate === 'up' || operstate === 'unknown') ? 'up' : 'down';
                        break;
                    }
                }
            }
            
            if (!usbInterface) {
                resolve(null); // 没有找到USB接口
                return;
            }
            
            // 获取USB接口的IP地址
            execCmd('ip', ['addr', 'show', 'dev', usbInterface]).then(addrResult => {
                let usb_ip = 'N/A';
                let usb_gateway = 'N/A';
                
                if (addrResult && addrResult.code === 0) {
                    const addrLines = addrResult.stdout.split('\n');
                    for (let i = 0; i < addrLines.length; i++) {
                        const line = addrLines[i].trim();
                        if (line.startsWith('inet ')) {
                            const match = line.match(/inet\s+([0-9.]+)/);
                            if (match) usb_ip = match[1];
                            break;
                        }
                    }
                }
                
                // 获取USB接口的网关
                execCmd('ip', ['route', 'show', 'dev', usbInterface]).then(routeResult => {
                    if (routeResult && routeResult.code === 0) {
                        const lines = routeResult.stdout.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (line.startsWith('default')) {
                                const viaMatch = line.match(/via\s+([0-9.]+)/);
                                if (viaMatch) usb_gateway = viaMatch[1];
                                break;
                            }
                        }
                    }
                    
                    // 获取连接速度
                    let linkSpeed = 'N/A';
                    execCmd('cat', ['/sys/class/net/' + usbInterface + '/speed']).then(speedResult => {
                        if (speedResult && speedResult.code === 0 && speedResult.stdout.trim() !== '-1') {
                            linkSpeed = speedResult.stdout.trim() + ' Mbps';
                        }
                        
                        resolve({
                            enabled: true,
                            state: usbState,
                            interface_name: usbInterface,
                            ip_address: usb_ip,
                            gateway: usb_gateway,
                            link_speed: linkSpeed
                        });
                    }).catch(() => {
                        resolve({
                            enabled: true,
                            state: usbState,
                            interface_name: usbInterface,
                            ip_address: usb_ip,
                            gateway: usb_gateway,
                            link_speed: 'N/A'
                        });
                    });
                }).catch(() => {
                    resolve({
                        enabled: true,
                        state: usbState,
                        interface_name: usbInterface,
                        ip_address: usb_ip,
                        gateway: usb_gateway,
                        link_speed: 'N/A'
                    });
                });
            }).catch(() => {
                resolve({
                    enabled: true,
                    state: usbState,
                    interface_name: usbInterface,
                    ip_address: 'N/A',
                    gateway: 'N/A',
                    link_speed: 'N/A'
                });
            });
        }).catch(() => {
            resolve(null); // 出错时也返回null
        });
    });
}

// ===========================
// 外网连通性检测 & 客户端统计
// ===========================

function checkInternetConnectivity() {
    return Promise.all([
        execCmd('ping', ['-c', '1', '-W', '2', '223.5.5.5']),
        execCmd('ping', ['-c', '1', '-W', '2', '1.1.1.1'])
    ]).then(results => {
        return results.some(r => r && r.code === 0);
    }).catch(() => {
        return false;
    });
}

function getClientCount(gatewayIp, lanInterfaces) {
    return execCmd('cat', ['/proc/net/arp']).then(result => {
        if (!result || result.code !== 0) return 0;
        const lines = result.stdout.split('\n');
        let count = 0;
        
        const safeGateway = gatewayIp ? gatewayIp.trim() : '';
        const validLanIfaces = new Set(lanInterfaces || []);
        ['br-lan', 'lan', 'eth0', 'eth1', 'usb0', 'usb1', 'enx', 'eth2'].forEach(i => validLanIfaces.add(i));

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const parts = line.split(/\s+/);
            if (parts.length < 6) continue;
            
            const ip = parts[0];
            const flags = parts[2];
            const mac = parts[3];
            const iface = parts[5];

            if (!mac || mac === '00:00:00:00:00:00') continue;
            if (iface.toLowerCase().includes('wan')) continue;
            
            if (validLanIfaces.size > 0 && !validLanIfaces.has(iface)) {
                if (!/^(wlan|ap|ath|ra|wl)/.test(iface)) {
                    continue;
                }
            }

            if (safeGateway && ip === safeGateway) continue;

            const flagVal = parseInt(flags, 16);
            if (flagVal !== 0x02 && flagVal !== 0x06) {
                continue; 
            }

            count++;
        }
        return count;
    }).catch(() => {
        return 0;
    });
}

var trafficData = { labels: [], rx: [], tx: [] };
var trafficChart = null;
var isRefreshing = false;
var currentChartUnit = 'KB/s';

function initTrafficChart() {
    var ctx = document.getElementById('traffic-chart');
    if (!ctx || !window.Chart) return;
    if (trafficChart) trafficChart.destroy();

    trafficChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { 
                    label: '上传', 
                    data: [], 
                    borderColor: '#8b5cf6', 
                    backgroundColor: 'rgba(139, 92, 246, 0.15)', 
                    fill: true, 
                    tension: 0.4, 
                    pointRadius: 0, 
                    borderWidth: 3,
                    borderDash: [5, 3]
                },
                { 
                    label: '下载', 
                    data: [], 
                    borderColor: '#10b981', 
                    backgroundColor: 'rgba(16, 185, 129, 0.15)', 
                    fill: true, 
                    tension: 0.4, 
                    pointRadius: 0, 
                    borderWidth: 3 
                }
            ]
        },
        options: {
            responsive: true, 
            maintainAspectRatio: false, 
            animation: { duration: 0 },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { 
                    position: 'top', 
                    align: 'end', 
                    labels: { 
                        font: { 
                            size: 13, 
                            weight: 'bold',
                            family: "'Inter', sans-serif" 
                        }, 
                        color: '#1f2937', 
                        usePointStyle: true, 
                        boxWidth: 8,
                        padding: 20
                    } 
                },
                tooltip: {
                    backgroundColor: 'rgba(17, 24, 39, 0.95)', 
                    padding: 12, 
                    cornerRadius: 8,
                    titleFont: { size: 12, weight: 'bold' },
                    bodyFont: { size: 12, weight: 'bold' },
                    callbacks: {
                        label: function(context) {
                            var label = context.dataset.label || '';
                            if (label) label += ': ';
                            label += context.parsed.y.toFixed(2) + ' ' + currentChartUnit;
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: { 
                    display: true, 
                    grid: { 
                        display: true,
                        color: 'rgba(229, 231, 235, 0.5)',
                        drawBorder: false
                    },
                    ticks: {
                        font: { 
                            size: 11, 
                            weight: '600',
                            family: "'Inter', sans-serif" 
                        },
                        color: '#6b7280',
                        maxRotation: 0
                    },
                    border: { display: false }
                },
                y: {
                    beginAtZero: true, 
                    grid: { 
                        color: 'rgba(229, 231, 235, 0.5)', 
                        drawBorder: false
                    },
                    ticks: { 
                        font: { 
                            size: 12, 
                            weight: 'bold',
                            family: "'Inter', sans-serif" 
                        }, 
                        color: '#1f2937', 
                        callback: function(value) { 
                            return value.toFixed(1) + ' ' + currentChartUnit; 
                        } 
                    },
                    border: { display: false },
                    title: {
                        display: true,
                        text: '速率 (' + currentChartUnit + ')',
                        font: { size: 12, weight: 'bold' },
                        color: '#4b5563',
                        padding: { top: 10, bottom: 10 }
                    }
                }
            }
        }
    });

    setInterval(() => {
        getAllInterfaceTraffic().then(data => {
            currentChartUnit = data.unit;
            var now = new Date();
            var timeStr = now.getHours() + ':' + 
                         String(now.getMinutes()).padStart(2, '0') + ':' + 
                         String(now.getSeconds()).padStart(2, '0');
            
            if (trafficData.labels.length >= 30) {
                trafficData.labels.shift(); 
                trafficData.rx.shift(); 
                trafficData.tx.shift();
            }
            
            trafficData.labels.push(timeStr);
            trafficData.rx.push(data.totalRx);
            trafficData.tx.push(data.totalTx);
            
            if (trafficChart) {
                trafficChart.options.scales.y.ticks.callback = function(value) { 
                    return value.toFixed(1) + ' ' + currentChartUnit; 
                };
                trafficChart.options.scales.y.title.text = '速率 (' + currentChartUnit + ')';
                trafficChart.data.labels = trafficData.labels;
                trafficChart.data.datasets[0].data = trafficData.tx;
                trafficChart.data.datasets[1].data = trafficData.rx;
                trafficChart.update('none');
            }
            
            if(window.updatePortRates) {
                window.updatePortRates(data.interfaces);
            }
        });
    }, 2000);
}

function updateAllData() {
    if (isRefreshing) return;
    isRefreshing = true;
    
    var refreshIndicator = document.getElementById('refresh-indicator');
    if (refreshIndicator) {
        refreshIndicator.innerHTML = '<svg class="icon-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> <span>同步中...</span>';
        refreshIndicator.classList.add('refreshing');
    }
    
    fetchDataForUpdate().then(systemData => {
        var parsed = null;
        var gatewayIp = '';
        var lanIfaces = [];
        
        if (systemData && globalParseData) {
            parsed = globalParseData(systemData);
            // 从WAN信息中获取网关
            gatewayIp = parsed.wan_gateway;
            parsed.portItems.forEach(item => {
                if (item.label.toLowerCase().indexOf('wan') === -1 && !item.label.startsWith('usb')) {
                    lanIfaces.push(item.label);
                }
            });
        }

        Promise.all([
            Promise.resolve(systemData), 
            getAllInterfaceTraffic(),
            checkInternetConnectivity(),
            getClientCount(gatewayIp, lanIfaces),
            getWanInfo(),
            getUsbInterfaceStatus()  // 新增：获取USB接口状态
        ]).then(results => {
            var [sysData, trafficDataResult, hasInternet, clientCount, wanInfo, usbInfo] = results;
            
            // 只在有USB接口时才显示USB网络部分
            if (!usbInfo) {
                var usbRow = document.querySelector('.usb-network-row');
                if (usbRow) {
                    usbRow.style.display = 'none';
                }
            } else {
                var usbRow = document.querySelector('.usb-network-row');
                if (usbRow) {
                    usbRow.style.display = 'block';
                }
            }
            
            if (sysData && globalParseData) {
                // 合并WAN信息到系统数据
                if (wanInfo) {
                    sysData.wanInfo = wanInfo;
                }
                if (usbInfo) {
                    sysData.usbInfo = usbInfo;
                }
                updateSystemUI(sysData, hasInternet, clientCount, wanInfo, usbInfo);
            }
            if (trafficDataResult && window.updatePortRates) {
                window.updatePortRates(trafficDataResult.interfaces);
            }
        }).catch(err => {
            console.warn('数据更新失败:', err);
            if(refreshIndicator) refreshIndicator.innerHTML = '<span style="color:#ef4444; font-weight: 600;">同步失败</span>';
        }).finally(() => {
            isRefreshing = false;
            var refreshIndicator = document.getElementById('refresh-indicator');
            if (refreshIndicator) {
                refreshIndicator.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> <span style="color:#10b981; font-weight: 600;">已更新</span>';
                refreshIndicator.classList.remove('refreshing');
                setTimeout(() => { 
                    if (refreshIndicator) refreshIndicator.innerHTML = ''; 
                }, 3000);
            }
        });
    });
}

function fetchDataForUpdate() {
    return Promise.all([
        execCmd('ubus', ['call', 'system', 'board']),
        execCmd('/bin/uname', ['-r']),
        execCmd('/bin/cat', ['/proc/uptime']),
        execCmd('/bin/cat', ['/proc/loadavg']),
        execCmd('/bin/cat', ['/proc/meminfo']),
        execCmd('ip', ['route', 'show']),
        execCmd('/bin/cat', ['/proc/net/tcp']),
        execCmd('/bin/cat', ['/proc/net/udp']),
        execCmd('ip', ['link', 'show']),
        execCmd('/bin/date', ['+%Y-%m-%d %H:%M'])
    ]);
}

function updateSystemUI(data, hasInternet, clientCount, wanInfo, usbInfo) {
    if (!globalParseData) return;
    var parsed = globalParseData(data);
    var el = id => document.getElementById(id);
    
    if (el('model')) el('model').textContent = parsed.model;
    if (el('firmware_ver')) el('firmware_ver').textContent = parsed.firmware_ver;
    if (el('kernel_ver')) el('kernel_ver').textContent = parsed.kernel_ver;
    if (el('uptime_str')) el('uptime_str').textContent = parsed.uptime_str;
    if (el('system_time')) el('system_time').textContent = parsed.system_time;
    if (el('total_mem')) el('total_mem').textContent = fmtBytes(parsed.total_mem);
    
    var used = parsed.total_mem - parsed.free_mem;
    if (el('used_mem')) {
        var percent = parsed.total_mem > 0 ? Math.round(used / parsed.total_mem * 100) : 0;
        el('used_mem').innerHTML = `<div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${percent}%"></div></div><span class="mem-text">${fmtBytes(used)} (${percent}%)</span>`;
    }
    
    if (el('free_mem')) el('free_mem').textContent = fmtBytes(parsed.free_mem);
    if (el('cpu_percent')) {
        var cpuVal = parsed.cpu_percent;
        var cpuColor = cpuVal > 80 ? '#ef4444' : (cpuVal > 50 ? '#f59e0b' : '#10b981');
        el('cpu_percent').innerHTML = `<span style="color:${cpuColor}; font-weight:700; font-size:1.1em;">${cpuVal}%</span>`;
    }
    
    if (el('conn_count')) el('conn_count').textContent = parsed.conn_count.toString();
    
    // 使用新的WAN信息
    var wan_ip = 'N/A';
    var wan_gateway = 'N/A';
    var wan_protocol = 'Unknown';
    var wan_uptime = '-';
    
    if (wanInfo) {
        wan_ip = wanInfo.wan_ip;
        wan_gateway = wanInfo.wan_gateway;
        wan_protocol = wanInfo.wan_protocol;
        wan_uptime = wanInfo.wan_uptime;
    } else {
        // 回退到旧数据
        wan_ip = parsed.wan_ip;
        wan_gateway = parsed.wan_gateway;
    }
    
    if (el('wan_ip')) el('wan_ip').textContent = wan_ip;
    if (el('wan_gateway')) el('wan_gateway').textContent = wan_gateway;
    if (el('wan_protocol')) el('wan_protocol').textContent = wan_protocol;
    
    // 更新USB接口信息
    if (el('usb_status_badge')) {
        if (usbInfo) {
            if (usbInfo.state === 'up') {
                // 检查USB接口是否真正联网
                var usbHasInternet = false;
                if (usbInfo.ip_address !== 'N/A' && usbInfo.gateway !== 'N/A') {
                    usbHasInternet = true;
                }
                
                if (usbHasInternet) {
                    el('usb_status_badge').innerHTML = `<span class="status-badge status-ok" style="font-size:0.85rem; font-weight: 700;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg> 已联网
                    </span>`;
                } else {
                    el('usb_status_badge').innerHTML = `<span class="status-badge" style="background-color: #fef3c7; color: #92400e; font-size:0.85rem; font-weight: 700;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="12" y1="8" x2="12" y2="12"></line>
                            <line x1="12" y1="16" x2="12.01" y2="16"></line>
                        </svg> 接口就绪
                    </span>`;
                }
                
                // 显示USB接口详情
                if (el('usb_details')) {
                    var speedInfo = usbInfo.link_speed !== 'N/A' ? ` | ${usbInfo.link_speed}` : '';
                    var ipInfo = usbInfo.ip_address !== 'N/A' ? 
                        `<div>IP地址: <span style="color: #10b981; font-weight: 700; font-family: 'JetBrains Mono', monospace;">${usbInfo.ip_address}</span></div>` :
                        `<div>IP地址: <span style="color: #ef4444; font-weight: 700;">未获取</span></div>`;
                    
                    var gatewayInfo = usbInfo.gateway !== 'N/A' ? 
                        `<div>网关: <span style="color: #10b981; font-weight: 700; font-family: 'JetBrains Mono', monospace;">${usbInfo.gateway}</span></div>` :
                        `<div>网关: <span style="color: #ef4444; font-weight: 700;">未获取</span></div>`;
                    
                    el('usb_details').innerHTML = `
                        <div style="font-size: 0.85rem; margin-top: 4px; color: #6b7280;">
                            <div>接口: <span style="color: #6366f1; font-weight: 700;">${usbInfo.interface_name}</span>${speedInfo}</div>
                            ${ipInfo}
                            ${gatewayInfo}
                        </div>
                    `;
                }
            } else {
                el('usb_status_badge').innerHTML = `<span class="status-badge" style="background-color: #fef3c7; color: #92400e; font-size:0.85rem; font-weight: 700;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg> 接口就绪
                </span>`;
                
                if (el('usb_details')) {
                    el('usb_details').innerHTML = `<div style="font-size: 0.85rem; margin-top: 4px; color: #6b7280;">
                        接口: <span style="color: #6366f1; font-weight: 700;">${usbInfo.interface_name}</span> (物理层就绪)
                    </div>`;
                }
            }
        } else {
            // 没有USB接口，隐藏整个USB网络部分
            var usbRow = document.querySelector('.usb-network-row');
            if (usbRow) {
                usbRow.style.display = 'none';
            }
        }
    }
    
    var wanStatusEl = el('wan_status_badge');
    var wanUptimeEl = el('uptime_str_net');
    
    if (wanStatusEl && wanUptimeEl) {
        var wanPhysicallyUp = false;
        for (var i = 0; i < parsed.portItems.length; i++) {
            if (parsed.portItems[i].label.toLowerCase().indexOf('wan') !== -1) {
                if (parsed.portItems[i].value === '已连接') {
                    wanPhysicallyUp = true;
                }
                break;
            }
        }

        if (wanPhysicallyUp && hasInternet) {
            wanStatusEl.innerHTML = '<span class="status-badge status-ok" style="font-size:0.85rem; font-weight: 700;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg> 已联网</span>';
            wanUptimeEl.textContent = wan_uptime;
            wanUptimeEl.style.color = '#1f2937';
            wanUptimeEl.style.fontWeight = '600';
        } else {
            wanStatusEl.innerHTML = '<span class="status-badge status-err" style="font-size:0.85rem; font-weight: 700;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> 未联网</span>';
            wanUptimeEl.textContent = '-';
            wanUptimeEl.style.color = '#9ca3af';
            wanUptimeEl.style.fontWeight = '600';
        }
    }

    if (el('client_count')) {
        el('client_count').textContent = clientCount.toString();
        el('client_count').style.fontWeight = '700';
        el('client_count').style.fontSize = '1.1em';
    }
    
    // 更新端口状态，特别是USB端口
    parsed.portItems.forEach(item => {
        var span = el('port-' + item.label);
        if (span) {
            var statusHtml = item.value === '已连接' 
                ? '<span class="status-badge status-ok" style="font-weight: 700;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg> 在线</span>'
                : '<span class="status-badge status-err" style="font-weight: 700;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> 离线</span>';
            
            span.innerHTML = `${statusHtml}<div id="rate-${item.label}" class="port-rates"></div>`;
        }
    });
}

var globalParseData = null;

return view.extend({
    load: function() { return this.fetchData(); },
    fetchData: function() {
        return Promise.all([
            execCmd('ubus', ['call', 'system', 'board']),
            execCmd('/bin/uname', ['-r']),
            execCmd('/bin/cat', ['/proc/uptime']),
            execCmd('/bin/cat', ['/proc/loadavg']),
            execCmd('/bin/cat', ['/proc/meminfo']),
            execCmd('ip', ['route', 'show']),
            execCmd('/bin/cat', ['/proc/net/tcp']),
            execCmd('/bin/cat', ['/proc/net/udp']),
            execCmd('ip', ['link', 'show']),
            execCmd('/bin/date', ['+%Y-%m-%d %H:%M'])
        ]);
    },
    parseData: function(data) {
        var model = 'Unknown', firmware_ver = 'Unknown';
        if (data[0] && data[0].code === 0) {
            try {
                var board = JSON.parse(data[0].stdout.trim());
                if (board.model) model = unquote(board.model);
                if (board.release && board.release.description) firmware_ver = unquote(board.release.description);
            } catch (e) {}
        }
        var kernel_ver = data[1] && data[1].code === 0 ? data[1].stdout.trim() : 'Unknown';
        var uptime_sec = data[2] && data[2].code === 0 ? parseFloat(data[2].stdout.split(' ')[0]) : 0;
        var up_d = Math.floor(uptime_sec / 86400);
        var up_h = Math.floor((uptime_sec % 86400) / 3600);
        var up_m = Math.floor((uptime_sec % 3600) / 60);
        var uptime_str = (up_d > 0 ? up_d + '天 ' : '') + up_h + '小时 ' + up_m + '分';
        var loadavg = data[3] && data[3].code === 0 ? data[3].stdout.split(' ')[0] : '0.00';
        var cpu_percent = Math.min(Math.round(parseFloat(loadavg) * 10), 100);
        var total_mem = 0, free_mem = 0;
        var meminfo = data[4] && data[4].code === 0 ? data[4].stdout : '';
        var lines = meminfo.split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('MemTotal:')) {
                var match = lines[i].match(/(\d+)/);
                total_mem = match ? parseInt(match[1]) * 1024 : 0;
            } else if (lines[i].startsWith('MemFree:')) {
                var match = lines[i].match(/(\d+)/);
                free_mem = match ? parseInt(match[1]) * 1024 : 0;
            }
        }
        
        // 旧的WAN解析（作为备用）
        var old_wan_ip = 'N/A', old_wan_gateway = 'N/A';
        if (data[5] && data[5].code === 0) {
            var lines = data[5].stdout.split('\n');
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (line.startsWith('default')) {
                    var viaMatch = line.match(/via\s+([0-9a-f.:]+)/i);
                    if (viaMatch) old_wan_gateway = viaMatch[1];
                    var srcMatch = line.match(/src\s+([0-9a-f.:]+)/i);
                    if (srcMatch) old_wan_ip = srcMatch[1];
                    break;
                }
            }
        }
        
        var conn_count = 0;
        if (data[6] && data[6].code === 0) {
            var tcp_lines = data[6].stdout.split('\n');
            for (var i = 1; i < tcp_lines.length; i++) {
                var fields = tcp_lines[i].trim().split(/\s+/);
                if (fields.length >= 4 && (fields[3] === '01' || fields[3] === '03')) conn_count++;
            }
        }
        if (data[7] && data[7].code === 0) {
            var udp_lines = data[7].stdout.split('\n');
            for (var i = 1; i < udp_lines.length; i++) {
                var fields = udp_lines[i].trim().split(/\s+/);
                if (fields.length >= 4) conn_count++;
            }
        }
        
        var portItems = [];
        var ipLinkOutput = data[8] && data[8].code === 0 ? data[8].stdout : '';
        if (ipLinkOutput) {
            var lines = ipLinkOutput.split('\n');
            var ethPorts = [];
            var namedPorts = [];
            var usbPorts = [];
            
            // 第一轮扫描：收集所有接口
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line) continue;
                
                var ifaceMatch = line.match(/^\d+:\s+([^:@]+)(?:@[^:]+)?:/);
                if (ifaceMatch) {
                    var ifaceName = ifaceMatch[1];
                    var stateMatch = line.match(/state\s+(\w+)/);
                    
                    // 改进的状态检测：检查接口是否启用
                    var status = '未连接';
                    if (stateMatch) {
                        var operstate = stateMatch[1].toLowerCase();
                        if (operstate === 'up' || operstate === 'unknown') {
                            status = '已连接';
                        }
                    }
                    
                    // 检查USB接口
                    if (ifaceName.startsWith('usb') || 
                        ifaceName.startsWith('enx') || 
                        ifaceName.includes('usb') ||
                        ifaceName === 'eth1' ||  // 可能也是USB
                        ifaceName === 'eth2') {
                        usbPorts.push({
                            name: ifaceName,
                            status: status
                        });
                    }
                    // 检查交换机端口
                    else if (/^(eth\d+|lan\d*|wan\d*)$/i.test(ifaceName)) {
                        var isEth = ifaceName.toLowerCase().startsWith('eth');
                        
                        if (isEth) {
                            ethPorts.push({
                                name: ifaceName,
                                status: status
                            });
                        } else {
                            namedPorts.push({
                                name: ifaceName,
                                status: status
                            });
                        }
                    }
                }
            }
            
            // 构建端口映射：eth0 -> wan, eth1 -> lan, eth2 -> lan1, eth3 -> lan2 ...
            var ethToStandard = ['wan', 'lan', 'lan1', 'lan2', 'lan3', 'lan4'];
            
            // 检查是否有命名端口
            var hasNamedPorts = namedPorts.length > 0;
            
            if (hasNamedPorts) {
                // 情况1：已有命名端口，直接使用
                for (var j = 0; j < namedPorts.length; j++) {
                    portItems.push({ 
                        label: namedPorts[j].name, 
                        value: namedPorts[j].status 
                    });
                }
            } else {
                // 情况2：只有 eth 端口，转换为标准名称
                for (var k = 0; k < ethPorts.length; k++) {
                    var standardName = ethToStandard[k] || ethPorts[k].name;
                    portItems.push({ 
                        label: standardName, 
                        value: ethPorts[k].status 
                    });
                }
            }
            
            // 添加USB端口
            for (var l = 0; l < usbPorts.length; l++) {
                portItems.push({ 
                    label: usbPorts[l].name, 
                    value: usbPorts[l].status 
                });
            }
        }
        
        var system_time = data[9] && data[9].code === 0 ? data[9].stdout.trim() : 'Unknown';
        
        return { 
            model, 
            firmware_ver, 
            kernel_ver, 
            uptime_str, 
            system_time, 
            cpu_percent, 
            total_mem, 
            free_mem, 
            wan_ip: old_wan_ip,  // 旧数据
            wan_gateway: old_wan_gateway,  // 旧数据
            conn_count, 
            portItems 
        };
    },
    render: function(data) {
        var parsed = this.parseData(data);
        globalParseData = this.parseData.bind(this);
        
        var topBar = E('div', { class: 'dashboard-header', style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding: 0 5px;' }, [
            E('div', { style: 'font-size: 1.5rem; font-weight: 800; color: #1f2937; letter-spacing: -0.5px;' }, '系统概览'),
            E('div', { id: 'refresh-indicator', class: 'refresh-indicator', style: 'font-size: 13px; color: #6b7280; display: flex; align-items: center; gap: 6px; background: #f3f4f6; padding: 6px 12px; border-radius: 20px; font-weight: 600;' }, '')
        ]);

        var createCard = function(title, contentItems, borderClass) {
            return E('div', { class: `card ${borderClass}` }, [
                E('div', { class: 'card-header' }, [ 
                    E('h3', { class: 'card-title' }, [
                        E('span', { style: 'font-weight: 800; font-size: 1.1rem;' }, title)
                    ]) 
                ]),
                E('div', { class: 'card-content' }, contentItems)
            ]);
        };

        var systemCard = createCard('系统信息', [
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, '设备型号'), 
                E('span', { class: 'card-value', id: 'model', style: 'font-weight: 700; font-size: 1.05em;' }, parsed.model)
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, '固件版本'), 
                E('span', { class: 'card-value', id: 'firmware_ver', style: 'font-weight: 700; font-size: 1.05em;' }, parsed.firmware_ver)
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, '内核版本'), 
                E('span', { class: 'card-value', id: 'kernel_ver', style: 'font-weight: 700; font-size: 1.05em;' }, parsed.kernel_ver)
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, '运行时间'), 
                E('span', { class: 'card-value', id: 'uptime_str', style: 'font-weight: 700; font-size: 1.05em;' }, parsed.uptime_str)
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, '当前时间'), 
                E('span', { class: 'card-value', id: 'system_time', style: 'font-weight: 700; font-size: 1.05em;' }, parsed.system_time)
            ]),
            E('div', { class: 'card-item', style: 'margin-top: 12px; padding-top: 12px; border-top: 1px dashed #e5e7eb; justify-content: center;' }, [
                E('button', {
                    'type': 'button',
                    'class': 'btn-details',
                    'style': 'background: linear-gradient(135deg, #14b8a6, #0d9488); color: white; border: none; padding: 10px 24px; border-radius: 8px; font-size: 0.95rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: all 0.3s ease; box-shadow: 0 4px 6px rgba(20, 184, 166, 0.2);',
                    'click': function(e) {
                        if(e) e.preventDefault();
                        window.location.href = '/cgi-bin/luci/admin/status/overview';
                    },
                    'onmouseover': function(e) { 
                        e.target.style.background = 'linear-gradient(135deg, #2dd4bf, #14b8a6)'; 
                        e.target.style.transform = 'translateY(-2px)'; 
                        e.target.style.boxShadow = '0 6px 12px rgba(20, 184, 166, 0.3)';
                    },
                    'onmouseout': function(e) { 
                        e.target.style.background = 'linear-gradient(135deg, #14b8a6, #0d9488)'; 
                        e.target.style.transform = 'translateY(0)'; 
                        e.target.style.boxShadow = '0 4px 6px rgba(20, 184, 166, 0.2)';
                    }
                }, [
                    E('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' }, [
                        E('circle', { cx: '12', cy: '12', r: '10' }),
                        E('line', { x1: '12', y1: '16', x2: '12', y2: '12' }),
                        E('line', { x1: '12', y1: '8', x2: '12.01', y2: '8' })
                    ]),
                    E('span', { style: 'font-weight: 700;' }, '详细信息')
                ])
            ])
        ], 'card-system');

        var memoryCard = createCard('运行状态', [
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, '总内存'), 
                E('span', { class: 'card-value', id: 'total_mem', style: 'font-weight: 700; font-size: 1.05em;' }, fmtBytes(parsed.total_mem))
            ]),
            E('div', { class: 'card-item-row', style: 'flex-direction: column; align-items: flex-start; gap: 4px;' }, [
                E('span', { class: 'card-label' }, '内存使用'), 
                E('span', { class: 'card-value', id: 'used_mem', style: 'width: 100%; text-align: left; font-weight: 700; font-size: 1.05em;' }, '')
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, 'CPU 负载'), 
                E('span', { class: 'card-value', id: 'cpu_percent', style: 'font-size: 1.05em;' }, parsed.cpu_percent + '%')
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, '活动连接'), 
                E('span', { class: 'card-value', id: 'conn_count', style: 'font-weight: 700; font-size: 1.05em;' }, parsed.conn_count.toString())
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, '客户端总数'), 
                E('span', { class: 'card-value', id: 'client_count', style: 'color: #3b82f6; font-weight: 800; font-size: 1.1em;' }, '0')
            ])
        ], 'card-memory');

        var gotoNetworkConfig = function(e) {
            if(e) e.preventDefault();
            window.location.href = '/cgi-bin/luci/admin/network/network';
        };

        var configButtonsRow = E('div', { class: 'card-item', style: 'margin-top: 10px; padding-top: 10px; border-top: 1px dashed #e5e7eb; justify-content: center;' }, [
            E('button', {
                'type': 'button',
                'class': 'btn-config-network',
                'style': 'background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; border: none; padding: 10px 24px; border-radius: 8px; font-size: 0.95rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: all 0.3s ease; box-shadow: 0 4px 6px rgba(139, 92, 246, 0.2);',
                'click': gotoNetworkConfig,
                'onmouseover': function(e) { 
                    e.target.style.background = 'linear-gradient(135deg, #a78bfa, #8b5cf6)';
                    e.target.style.transform = 'translateY(-2px)';
                    e.target.style.boxShadow = '0 6px 12px rgba(139, 92, 246, 0.3)';
                },
                'onmouseout': function(e) { 
                    e.target.style.background = 'linear-gradient(135deg, #8b5cf6, #7c3aed)';
                    e.target.style.transform = 'translateY(0)';
                    e.target.style.boxShadow = '0 4px 6px rgba(139, 92, 246, 0.2)';
                }
            }, [
                E('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' }, [
                    E('circle', { cx: '12', cy: '12', r: '10' }),
                    E('line', { x1: '2', y1: '12', x2: '22', y2: '12' }),
                    E('path', { d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' })
                ]),
                E('span', { style: 'font-weight: 700;' }, '网络配置')
            ])
        ]);

        // 创建USB接口状态显示（只在有USB接口时才显示）
        var usbStatusRow = null;
        var hasUSBInterface = parsed.portItems.some(item => 
            item.label.startsWith('usb') || 
            item.label.startsWith('enx') || 
            item.label.includes('usb')
        );
        
        if (hasUSBInterface) {
            usbStatusRow = E('div', { 
                class: 'card-item usb-network-row', 
                style: 'flex-direction: column; align-items: flex-start; gap: 4px; border-top: 2px solid #e5e7eb; margin-top: 8px; padding-top: 12px; display: block;' 
            }, [
                E('div', { style: 'display: flex; justify-content: space-between; width: 100%; align-items: center; margin-bottom: 4px;' }, [
                    E('span', { class: 'card-label', style: 'font-weight: 700; color: #6366f1; display: flex; align-items: center; gap: 6px;' }, [
                        E('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' }, [
                            E('rect', { x: '2', y: '6', width: '20', height: '12', rx: '2' }),
                            E('path', { d: 'M9 8h6' })
                        ]),
                        'USB 网络'
                    ]),
                    E('span', { class: 'card-value', id: 'usb_status_badge', style: 'max-width: none; font-size: 0.85rem; font-weight: 700;' }, '检测中...')
                ]),
                E('div', { id: 'usb_details', style: 'width: 100%; font-size: 0.85rem; color: #6b7280;' }, '正在检测USB接口...')
            ]);
        }

        var networkCardContent = [
            E('div', { class: 'card-item', style: 'align-items: center;' }, [
                E('span', { class: 'card-label' }, '外网状态'), 
                E('span', { class: 'card-value', id: 'wan_status_badge', style: 'max-width: none; text-align: left;' }, 
                    '<span class="status-badge status-err" style="font-weight: 700;">检测中...</span>')
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, 'WAN 协议'), 
                E('span', { class: 'card-value', id: 'wan_protocol', style: 'font-weight: 700; font-size: 1.05em;' }, '检测中...')
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, 'IP 地址'), 
                E('span', { class: 'card-value', id: 'wan_ip', style: 'font-family: "JetBrains Mono", "Cascadia Code", "SF Mono", monospace; font-weight: 700; font-size: 1.05em;' }, parsed.wan_ip)
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, '网关'), 
                E('span', { class: 'card-value', id: 'wan_gateway', style: 'font-family: "JetBrains Mono", "Cascadia Code", "SF Mono", monospace; font-weight: 700; font-size: 1.05em;' }, parsed.wan_gateway)
            ]),
            E('div', { class: 'card-item' }, [
                E('span', { class: 'card-label' }, '联网时长'), 
                E('span', { class: 'card-value', id: 'uptime_str_net', style: 'font-family: "JetBrains Mono", "Cascadia Code", "SF Mono", monospace; font-weight: 600; font-size: 1.05em;' }, '-')
            ])
        ];

        // 如果有USB接口，添加USB行
        if (usbStatusRow) {
            networkCardContent.push(usbStatusRow);
        }
        
        // 添加配置按钮
        networkCardContent.push(configButtonsRow);

        var networkCard = createCard('网络状态', networkCardContent, 'card-network');

        var portsCard = createCard('端口状态', parsed.portItems.map(item => {
            var isUSB = item.label.startsWith('usb') || item.label.startsWith('enx') || item.label.includes('usb');
            return E('div', { class: 'card-item', style: 'flex-direction: column; align-items: flex-start; padding: 10px 0;' }, [
                E('div', { style: 'display: flex; justify-content: space-between; width: 100%; align-items: center;' }, [
                    E('span', { 
                        class: 'card-label', 
                        style: 'text-transform: uppercase; font-weight: 800; font-size: 1.05em; letter-spacing: 0.5px;' + 
                               (isUSB ? ' color: #6366f1;' : '') 
                    }, item.label + (isUSB ? ' (USB)' : '')),
                    E('span', { class: 'card-value', id: 'port-' + item.label, style: 'max-width: none; font-size: 1.05em;' })
                ])
            ]);
        }), 'card-ports');

        var refreshBtn = E('button', {
            id: 'manual-refresh-btn',
            class: 'fab-button',
            click: function() { updateAllData(); },
            title: '立即刷新数据'
        }, [
            E('div', { style: 'display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.2;' }, [
                E('svg', { width: '28', height: '28', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' }, [
                    E('polyline', { points: '23 4 23 10 17 10' }),
                    E('path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' })
                ]),
                E('span', { style: 'font-size: 13px; font-weight: 800; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px;' }, '刷新')
            ])
        ]);

        window.updateSystemUI = function(data, hasInternet, clientCount, wanInfo, usbInfo) { 
            updateSystemUI(data, hasInternet, clientCount, wanInfo, usbInfo); 
        };

        window.updatePortRates = function(rates) {
            for (var iface in rates) {
                var rateDiv = document.getElementById('rate-' + iface);
                if (rateDiv) {
                    var isWan = iface.toLowerCase().indexOf('wan') !== -1;
                    var isUSB = iface.startsWith('usb') || iface.startsWith('enx') || iface.includes('usb');
                    if (isWan || isUSB) {
                        var r = rates[iface];
                        var rxStr = fmtRate(r.rx);
                        var txStr = fmtRate(r.tx);
                        rateDiv.style.display = 'flex';
                        var portColor = isWan ? '#8b5cf6' : '#6366f1';
                        rateDiv.innerHTML = `
                            <div style="margin-top: 6px; font-size: 0.8rem; color: #6b7280; display: flex; gap: 12px; width: 100%; background: #f9fafb; padding: 6px 10px; border-radius: 6px;">
                                <span style="display:flex; align-items:center; gap:4px; color: ${portColor}; font-weight: 700;">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                                    <span style="font-weight:800">${txStr}</span>
                                </span>
                                <span style="display:flex; align-items:center; gap:4px; color: #10b981; font-weight: 700;">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                                    <span style="font-weight:800">${rxStr}</span>
                                </span>
                            </div>
                        `;
                    } else {
                        rateDiv.style.display = 'none';
                    }
                }
            }
        };

        if (!window._globalRefreshInterval) {
            window._globalRefreshInterval = setInterval(updateAllData, 10000);
        }

        setTimeout(() => {
            if (window.Chart) {
                initTrafficChart();
            } else {
                var script = document.createElement('script');
                script.src = '/luci-static/resources/js/chart.min.js';
                script.onload = initTrafficChart;
                script.onerror = () => console.warn('Chart.js not found');
                document.head.appendChild(script);
            }
            // 初始加载时获取WAN和USB信息
            setTimeout(() => { 
                getWanInfo().then(wanInfo => {
                    // 使用获取到的WAN信息更新界面
                    if (wanInfo) {
                        var wanIpEl = document.getElementById('wan_ip');
                        var wanGatewayEl = document.getElementById('wan_gateway');
                        var wanProtocolEl = document.getElementById('wan_protocol');
                        if (wanIpEl && wanInfo.wan_ip !== 'N/A') wanIpEl.textContent = wanInfo.wan_ip;
                        if (wanGatewayEl && wanInfo.wan_gateway !== 'N/A') wanGatewayEl.textContent = wanInfo.wan_gateway;
                        if (wanProtocolEl) wanProtocolEl.textContent = wanInfo.wan_protocol;
                    }
                });
                updateAllData(); 
            }, 1000);
        }, 500);

        return E('div', { class: 'dashboard-wrapper' }, [
            E('style', {}, [`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
                @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
                
                .dashboard-wrapper { 
                    font-family: 'Inter', sans-serif; 
                    padding: 20px; 
                    background-color: #f9fafb; 
                    min-height: 100vh; 
                    color: #1f2937; 
                }
                .dashboard-header { padding: 10px 5px 20px; }
                .status-dashboard { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
                    gap: 24px; 
                    margin-bottom: 24px; 
                }
                .card { 
                    background: #ffffff; 
                    border-radius: 16px; 
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); 
                    padding: 20px; 
                    border: 1px solid rgba(229, 231, 235, 0.5); 
                    transition: all 0.3s ease; 
                }
                .card:hover { 
                    transform: translateY(-4px); 
                    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); 
                }
                .card-system { border-top: 4px solid #3b82f6; }
                .card-memory { border-top: 4px solid #10b981; }
                .card-network { border-top: 4px solid #8b5cf6; }
                .card-ports { border-top: 4px solid #f59e0b; }
                .card-header { 
                    margin-bottom: 16px; 
                    padding-bottom: 12px; 
                    border-bottom: 2px solid #f3f4f6; 
                }
                .card-title { 
                    font-size: 1.2rem; 
                    font-weight: 800; 
                    color: #111827; 
                    margin: 0; 
                    letter-spacing: -0.5px;
                }
                .card-content { 
                    font-size: 0.95rem; 
                    color: #4b5563; 
                    line-height: 1.6; 
                }
                .card-item { 
                    display: flex; 
                    justify-content: space-between; 
                    align-items: center; 
                    padding: 8px 0; 
                    border-bottom: 1px dashed #f3f4f6; 
                    width: 100%; 
                }
                .card-item:last-child { border-bottom: none; }
                .card-label { 
                    color: #6b7280; 
                    font-weight: 600; 
                    flex: 1; 
                    font-size: 0.95rem;
                }
                .card-value { 
                    font-weight: 700; 
                    color: #1f2937; 
                    text-align: right; 
                    max-width: 55%; 
                    overflow: hidden; 
                    text-overflow: ellipsis; 
                    white-space: nowrap; 
                }
                .progress-bar-bg { 
                    width: 100%; 
                    height: 6px; 
                    background-color: #e5e7eb; 
                    border-radius: 3px; 
                    overflow: hidden; 
                    margin-top: 4px; 
                }
                .progress-bar-fill { 
                    height: 100%; 
                    background: linear-gradient(90deg, #3b82f6, #2563eb); 
                    border-radius: 3px; 
                    transition: width 0.5s ease; 
                }
                .mem-text { 
                    display: block; 
                    font-size: 0.85rem; 
                    color: #6b7280; 
                    margin-top: 4px; 
                    font-weight: 600;
                }
                .status-badge { 
                    display: inline-flex; 
                    align-items: center; 
                    gap: 4px; 
                    padding: 4px 10px; 
                    border-radius: 9999px; 
                    font-size: 0.75rem; 
                    font-weight: 700; 
                }
                .status-ok { 
                    background-color: #d1fae5; 
                    color: #065f46; 
                }
                .status-err { 
                    background-color: #fee2e2; 
                    color: #991b1b; 
                }
                .port-rates { 
                    margin-top: 6px; 
                    font-size: 0.8rem; 
                    display: flex; 
                    gap: 12px; 
                    width: 100%; 
                }
                .traffic-container { 
                    background: #ffffff; 
                    border-radius: 16px; 
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); 
                    padding: 24px; 
                    border: 1px solid rgba(229, 231, 235, 0.5); 
                    margin-bottom: 80px; 
                }
                #traffic-chart { 
                    width: 100% !important; 
                    height: 320px !important; 
                }
                
                /* 图表字体增强 */
                .chartjs-render-monitor {
                    font-family: 'Inter', sans-serif !important;
                }
                
                /* 刷新按钮样式优化 */
                .fab-button { 
                    position: fixed; 
                    bottom: 30px; 
                    right: 30px; 
                    width: 72px; 
                    height: 72px; 
                    border-radius: 50%; 
                    background: linear-gradient(135deg, #3b82f6, #2563eb); 
                    color: white; 
                    border: none; 
                    box-shadow: 0 6px 16px rgba(59, 130, 246, 0.5); 
                    cursor: pointer; 
                    display: flex; 
                    align-items: center; 
                    justify-content: center; 
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); 
                    z-index: 1000; 
                }
                .fab-button:hover { 
                    transform: scale(1.1) rotate(5deg); 
                    box-shadow: 0 8px 20px rgba(59, 130, 246, 0.6); 
                }
                .fab-button:active { 
                    transform: scale(0.95); 
                }
                
                .icon-spin svg { animation: spin 1s linear infinite; }
                @keyframes spin { 
                    0% { transform: rotate(0deg); } 
                    100% { transform: rotate(360deg); } 
                }
                
                /* 按钮点击态优化 */
                .btn-config-network:active, .btn-details:active { 
                    transform: scale(0.96); 
                    opacity: 0.9; 
                }
                
                @media (max-width: 600px) { 
                    .status-dashboard { grid-template-columns: 1fr; } 
                    .fab-button { 
                        bottom: 20px; 
                        right: 20px; 
                        width: 60px; 
                        height: 60px; 
                    } 
                    .fab-button span { 
                        font-size: 11px !important; 
                    }
                }
            `]),
            topBar,
            E('div', { class: 'status-dashboard' }, [systemCard, memoryCard, networkCard, portsCard]),
            E('div', { class: 'traffic-container' }, [
                E('h3', { 
                    class: 'card-title', 
                    style: 'margin-bottom: 20px; font-size: 1.2rem; font-weight: 800; color: #111827; letter-spacing: -0.5px;' 
                }, '实时流量监控'),
                E('canvas', { id: 'traffic-chart' })
            ]),
            refreshBtn
        ]);
    }
});

