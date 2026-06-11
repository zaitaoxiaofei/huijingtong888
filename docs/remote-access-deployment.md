# Ozon ERP Remote Access Deployment

本文档描述当前已经采用的远程访问部署形态，默认数据库为 MySQL，不再把旧的 SQLite 配置当作当前部署事实。

## 1. 当前生产形态

- 运行主机：Windows
- 应用进程：`node src/server.js`
- 服务监听：`127.0.0.1:8787`
- 外部域名：[erp.hjt888.xyz](https://erp.hjt888.xyz)
- 对外暴露方式：Cloudflare Tunnel
- 外层访问控制：站点访问口令
- 内层访问控制：系统账号登录

关键配置与实现：

- 环境变量：[.env.example](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/.env.example)
- 配置读取：[src/config.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/config.js)
- 站点访问门禁：[src/server/access.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/access.js)
- HTTP 服务入口：[src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
- Tunnel 配置示例：[deploy/cloudflared/config.example.yml](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/deploy/cloudflared/config.example.yml)

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

- Node 只监听本机，不直接暴露到局域网或公网
- 远程用户先经过 Tunnel，再进入应用自己的站点访问口令页
- 通过口令后，仍然需要正常系统账号登录

## 3. 必要环境变量

```env
HOST=127.0.0.1
PORT=8787
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=ozon_erp
DB_USER=replace-with-real-user
DB_PASSWORD=replace-with-real-password
DB_POOL_MIN=0
DB_POOL_MAX=10
DB_POOL_QUEUE_LIMIT=100
DB_POOL_ACQUIRE_TIMEOUT_MS=10000
APP_BASE_URL=https://erp.hjt888.xyz
SITE_ACCESS_PASSWORD=replace-with-a-long-random-password
SITE_ACCESS_COOKIE_NAME=erp_site_access
SITE_ACCESS_SESSION_HOURS=168
APP_SESSION_TTL_HOURS=72
WECHAT_LOGIN_APP_ID=
WECHAT_LOGIN_APP_SECRET=
WECHAT_LOGIN_REDIRECT_URI=https://erp.hjt888.xyz/api/auth/wechat/callback
```

说明：

- `HOST=127.0.0.1`：限制 Node 只接受本机入口
- `APP_BASE_URL`：决定站点口令页回跳地址和安全 Cookie 行为
- `SITE_ACCESS_PASSWORD`：外层访问口令；为空时站点门禁关闭
- `WECHAT_LOGIN_*`：微信网页登录配置
- 当前服务启动要求真实的 MySQL 连接变量，`DATABASE_PATH` 已不是有效运行配置

## 4. 本机启动

推荐：

```powershell
npm start
```

或者：

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

## 5. Cloudflare Tunnel

当前目标是把域名转发到本机：

- `hostname: erp.hjt888.xyz`
- `service: http://127.0.0.1:8787`

示例配置见：

- [deploy/cloudflared/config.example.yml](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/deploy/cloudflared/config.example.yml)

## 6. 当前安全边界

1. Node 不开放公网监听，只绑定 `127.0.0.1`
2. Cloudflare Tunnel 负责安全转发和 HTTPS
3. `SITE_ACCESS_PASSWORD` 提供外层口令门禁
4. 系统账号密码提供业务层登录控制
5. 登录和口令都带有限时会话

## 7. 运维建议

- 修改外网地址时，同时更新 `.env` 里的 `APP_BASE_URL`
- 轮换口令时，同时更新 `SITE_ACCESS_PASSWORD`
- 数据备份与恢复应使用当前 MySQL 备份链路，不再参考旧 SQLite WAL 流程
- Tunnel 配置文件和 `.env` 分开保管，不要提交真实密钥
