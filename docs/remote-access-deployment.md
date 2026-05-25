# Ozon ERP Remote Access Deployment

这份文档只描述当前项目已经采用的远程访问形态，不再保留旧的局域网开放方案或 Cloudflare Access 方案。

## 1. 当前生产形态

- 运行主机：Windows
- 应用进程：`node src/server.js`
- 服务监听：`127.0.0.1:8787`
- 外部域名：[https://erp.hjt888.xyz](https://erp.hjt888.xyz)
- 对外暴露方式：Cloudflare Tunnel
- 外层访问控制：应用内站点访问口令
- 内层访问控制：系统账号登录

当前代码里的关键配置与实现：

- 环境变量：[.env.example](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/.env.example)
- 配置读取：[src/config.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/config.js)
- 站点访问门禁：[src/server/access.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/access.js)
- HTTP 服务入口：[src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
- Tunnel 示例配置：[deploy/cloudflared/config.example.yml](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/deploy/cloudflared/config.example.yml)

## 2. 当前访问链路

```text
Browser
  -> https://erp.hjt888.xyz
  -> Cloudflare Tunnel
  -> http://127.0.0.1:8787
  -> Node server
  -> site access password gate
  -> system login
  -> business pages and APIs
```

要点：

- Node 只监听本机，不直接暴露到局域网或公网。
- 远程用户先经过 Tunnel，再进入应用自己的站点访问口令页。
- 口令通过后，仍然需要正常系统账号登录。
- 本机直接访问时，站点访问口令会按代码逻辑放行。

## 3. 必要环境变量

当前部署至少需要这些变量：

```env
HOST=127.0.0.1
PORT=8787
DB_CLIENT=sqlite
DATABASE_PATH=./data/ozon-profit-hub.sqlite
APP_BASE_URL=https://erp.hjt888.xyz
SITE_ACCESS_PASSWORD=replace-with-a-long-random-password
SITE_ACCESS_COOKIE_NAME=erp_site_access
SITE_ACCESS_SESSION_HOURS=12
APP_SESSION_TTL_HOURS=72
```

说明：

- `HOST=127.0.0.1`：限制 Node 只接受本机入口。
- `APP_BASE_URL`：决定站点口令页回跳地址和安全 Cookie 行为。
- `SITE_ACCESS_PASSWORD`：外层访问口令；为空时，站点门禁会关闭。
- `SITE_ACCESS_COOKIE_NAME`、`SITE_ACCESS_SESSION_HOURS`：控制口令通过后的 Cookie 名称和时长。

## 4. 本机启动

推荐启动方式：

```powershell
npm start
```

说明：

- `npm start` 现在会先构建前端，再启动服务。
- 如果希望本地与线上看到完全一致的页面，应从同一份构建产物启动。

或：

```powershell
node src/server.js
```

项目根目录的 [start.bat](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/start.bat) 也可以作为手工启动入口。

推荐先生成部署产物：

```powershell
npm run package:deploy
```

部署规则：

- 该命令会重新构建前端并生成 `dist/deploy`
- 线上只上传并运行 `dist/deploy`
- 不要直接把整个源码工作区当作线上运行目录
- 不要单独更新 `src` 却漏掉 `public/vue-apps`
- `dist/deploy` 内的 `npm start` 只启动服务，不再重复构建前端

## 5. Cloudflare Tunnel

当前目标是把域名转发到本机：

- `hostname: erp.hjt888.xyz`
- `service: http://127.0.0.1:8787`

示例配置见：

- [deploy/cloudflared/config.example.yml](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/deploy/cloudflared/config.example.yml)

如果需要重新运行隧道，核心命令仍然是：

```powershell
cloudflared tunnel run ozon-erp
```

## 6. 当前安全边界

当前方案的安全边界是：

1. Node 不开放公网监听，只绑定 `127.0.0.1`。
2. Cloudflare Tunnel 只负责安全转发和 HTTPS。
3. 应用内的 `SITE_ACCESS_PASSWORD` 提供外层口令门禁。
4. 系统账号密码提供业务层登录控制。
5. 登录和口令都带有限时会话。

当前不依赖：

- Cloudflare Access
- 公网 IP
- 路由器端口映射
- 局域网固定 IP 对外开放

## 7. 运维建议

建议保留这些固定操作：

- 修改外网地址时，同时更新 `.env` 里的 `APP_BASE_URL`
- 轮换口令时，同时更新 `SITE_ACCESS_PASSWORD`
- 备份数据前确认服务状态，使用 `npm run backup:data`
- 恢复数据前关闭当前服务，使用 `npm run restore:data`
- 把 Tunnel 配置文件和 `.env` 分开保管，不要提交真实密钥

## 8. 开机自启

当前最小成本方案仍然是：

- Node 服务：Windows 任务计划程序或常驻方式启动
- Tunnel：`cloudflared` 自身服务方式启动

先决条件：

- 手工运行 `node src/server.js` 正常
- 手工运行 `cloudflared tunnel run ozon-erp` 正常

确认手工链路正常后，再做开机启动，避免把错误配置固化到系统服务里。

## 9. 不再采用的旧方案

以下内容不再作为当前主方案：

- 直接开放局域网访问
- 用固定局域网 IP 让外部用户直连
- 在当前这套 Windows + SQLite + PowerShell 备份链路上优先做 Docker 化
- 把 Cloudflare Access 当作必需前置条件
