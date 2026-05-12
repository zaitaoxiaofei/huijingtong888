# 本地远程访问部署方案

这份说明针对当前项目的实际结构，不是假设一个全新的云原生项目。

当前项目特点：

- 后端是原生 Node.js HTTP 服务：[src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
- 数据库是本地 SQLite 文件：`data/ozon-profit-hub.sqlite`
- 备份/恢复接口直接调用 PowerShell 脚本
- 适合先跑在一台长期在线的 Windows 主机上，再通过隧道安全暴露出去

## 推荐方案

最低成本、最适合当前项目的方案：

1. 继续在你自己的 Windows 电脑上运行这个项目
2. 把项目服务监听到 `127.0.0.1:8787`
3. 用 Cloudflare Tunnel 把 `https://erp.你的域名` 转发到本机 `http://127.0.0.1:8787`
4. 用 Cloudflare Access 给这个网址再加一层登录/白名单

推荐原因：

- 不需要公网 IP
- 不需要路由器端口映射
- 不需要私域网
- 自带 HTTPS
- 可以按邮箱、谷歌账号、微软账号控制谁能访问
- 对现在这套 SQLite + Windows PowerShell 备份脚本最友好

## 为什么不建议一开始就上 Docker

Docker 不是不能做，但不是当前最低成本方案。

当前项目里，备份/恢复是这样实现的：

- [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
  `runDataBackup()` 和 `startDataRestore()` 直接调用 `powershell.exe`
- [scripts/backup-data.ps1](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/scripts/backup-data.ps1)
- [scripts/restore-data.ps1](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/scripts/restore-data.ps1)

如果你把应用塞进 Linux 容器：

- 这些 PowerShell 备份/恢复逻辑会直接失效
- SQLite 挂载卷和 `WAL` 文件也要额外验证
- 本地维护复杂度会明显上升

结论：

- 先不要为了“看起来标准”而先上 Docker
- 先把“本地长期运行 + 远程安全访问”跑通
- 后面如果你要迁移到云主机，再做 Docker 化更合理

## 推荐软件组合

最小闭环：

- Node.js 22+
- Cloudflare Tunnel (`cloudflared`)
- 你自己的域名
- Cloudflare Zero Trust Access

可选增强：

- Windows 任务计划程序：开机自动启动 Node 服务
- `cloudflared` Windows 服务：开机自动启动隧道
- GitHub：只管代码版本，不参与运行链路

## 阶段 1：先跑通

目标：

- 先让别人能通过域名访问
- 先不追求“重启后自动恢复”

### 1. 准备 `.env`

在项目根目录创建 `.env`，建议内容：

```env
HOST=127.0.0.1
PORT=8787
DATABASE_PATH=./data/ozon-profit-hub.sqlite
APP_BASE_URL=https://erp.hjt888.xyz
```

说明：

- `HOST=127.0.0.1`：只允许本机访问，避免局域网直接扫到
- `APP_BASE_URL`：改成你的正式访问域名

### 2. 本机启动项目

```powershell
node src/server.js
```

看到类似日志即可：

```text
ozon ERP running at https://erp.hjt888.xyz (bind 127.0.0.1:8787)
```

### 3. 安装 Cloudflare Tunnel

参考 Cloudflare 官方文档安装 `cloudflared`。

### 4. 登录 Cloudflare

```powershell
cloudflared tunnel login
```

### 5. 创建 Tunnel

```powershell
cloudflared tunnel create ozon-erp
```

### 6. 配置域名路由

先把你的域名托管到 Cloudflare，然后执行：

```powershell
cloudflared tunnel route dns ozon-erp erp.hjt888.xyz
```

### 7. 配置 `cloudflared`

参考模板文件：

- [deploy/cloudflared/config.example.yml](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/deploy/cloudflared/config.example.yml)

你自己的配置核心就两行：

- `hostname: erp.hjt888.xyz`
- `service: http://127.0.0.1:8787`

### 8. 运行 Tunnel

```powershell
cloudflared tunnel run ozon-erp
```

这时外部用户就能访问：

```text
https://erp.hjt888.xyz
```

## 阶段 2：加访问控制

不要把这个系统裸露到公网。

建议在 Cloudflare Zero Trust 里增加一个 Access 应用，保护 `erp.hjt888.xyz`。

建议策略：

- 只允许你自己的邮箱登录
- 或只允许指定几个同事邮箱登录
- 每 12 小时或 24 小时重新验证一次

这样实际会有两层保护：

1. Cloudflare Access 外层身份验证
2. 你项目内部自己的账号密码

## 阶段 3：做成长期运行

目标：

- 电脑重启后能自动恢复
- 不需要你每次手动开两个终端

### 方案 A：最省事

- Node 服务用 Windows 任务计划程序开机启动
- Cloudflare Tunnel 用 `cloudflared service install` 注册成系统服务

推荐顺序：

1. 先确认手工运行完全正常
2. 再把 `cloudflared` 安装为服务
3. 最后把 Node 项目做成开机任务

### Node 开机任务建议

动作可以写成：

```text
Program/script:
node

Add arguments:
src/server.js

Start in:
C:\Users\DIZAI\OneDrive\文档\ozon-erp\ozon-system
```

如果你想让它完全无窗口长期运行，后面再考虑：

- NSSM
- WinSW

但第一步没必要先引入。

## 备份建议

因为你现在是本地 SQLite：

- `data/` 目录必须定期备份
- `backups/` 目录建议保留到另一块盘或同步盘
- 最好每天至少自动备份一次

当前项目已经有：

- [backup-data.bat](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/backup-data.bat)
- [restore-data.bat](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/restore-data.bat)
- [scripts/backup-data.ps1](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/scripts/backup-data.ps1)
- [scripts/restore-data.ps1](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/scripts/restore-data.ps1)

建议额外做一个 Windows 定时任务，每天执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-data.ps1
```

## 什么时候再上 Docker

只有在下面这些目标明确出现时，再做 Docker：

- 你要迁移到云服务器
- 你要让另一台机器无脑拉起同一套运行环境
- 你愿意重构备份/恢复逻辑，不再依赖 Windows PowerShell

届时再做这些事更合理：

1. 先把备份/恢复改成跨平台 Node 脚本
2. 再做 Dockerfile
3. 再做 `docker-compose.yml`
4. 最后让 Cloudflare Tunnel 走 sidecar 或宿主机模式

## 备选方案

### 备选 1：Tailscale Funnel

优点：

- 非常快
- 不需要自己域名也能先试

缺点：

- 更适合临时分享或轻量使用
- 官方文档当前仍标注为 beta
- 域名体系是 `*.ts.net`，不如自有域名稳定

适合：

- 今天就想快速给 1 到 2 个人临时看

不适合：

- 当正式内部系统入口

### 备选 2：直接路由器端口映射

不建议。

原因：

- 暴露面太大
- 没有 Zero Trust 外层保护
- 家宽公网和动态 IP 都很折腾

## 你现在最应该做的顺序

1. 先把 `.env` 改成 `HOST=127.0.0.1`
2. 准备一个 Cloudflare 托管的域名
3. 安装 `cloudflared`
4. 先手工跑通 `node src/server.js` + `cloudflared tunnel run`
5. 在 Cloudflare Access 里加邮箱白名单
6. 最后再做开机自启

## 我建议的最终形态

对你当前项目，最合理的第一版生产形态是：

- Windows 主机长期在线
- Node 直接跑宿主机
- SQLite 继续保留本地
- Cloudflare Tunnel 对外暴露
- Cloudflare Access 控制访问
- Windows 定时任务做备份

这个形态比 “Docker + Tunnel + 域名” 更符合你当前项目的成熟度，也更容易维护。
