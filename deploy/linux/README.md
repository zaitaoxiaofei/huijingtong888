# Ubuntu ECS 部署

目标环境：Ubuntu 24.04、2 核 2 GiB、Node.js 22、MySQL 8、Nginx。Node 仅监听 `127.0.0.1:3000`，公网入口由 Nginx 和 HTTPS 提供。

## 上线前准备

1. 为 ECS 创建至少 2 GiB swap，避免 MySQL、Node、Sharp 或 FFmpeg 同时工作时触发 OOM。
2. 安装 Node.js 22、MySQL 8、Nginx、certbot。
3. 创建系统用户 `ozon-erp`，应用目录 `/opt/ozon-erp/current`，共享目录 `/opt/ozon-erp/shared`。
4. 安全组只开放 22、80、443；不要开放 Node 的 3000 端口和 MySQL 的 3306 端口。

## 发布包

在开发机运行：

```powershell
npm run package:deploy
```

发布包位于 `dist/deploy`。默认不包含真实 `.env`、历史 uploads 或备份文件，避免密钥进入压缩包。把发布包上传到 `/opt/ozon-erp/current` 后执行：

```bash
cd /opt/ozon-erp/current
npm ci --omit=dev
```

将 `deploy/linux/ozon-erp.env.example` 复制到 `/etc/ozon-erp/ozon-erp.env`，填入服务器真实配置并执行：

```bash
sudo chown root:ozon-erp /etc/ozon-erp/ozon-erp.env
sudo chmod 640 /etc/ozon-erp/ozon-erp.env
```

## 服务与反向代理

1. 将 `ozon-erp.service.example` 复制为 `/etc/systemd/system/ozon-erp.service`。
2. 将 `nginx-ozon-erp.conf.example` 复制到 `/etc/nginx/sites-available/ozon-erp`，替换域名后启用。
3. 启动前先初始化或导入 MySQL，再启动应用。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ozon-erp
sudo nginx -t
sudo systemctl reload nginx
```

初次上线保持 `SCHEDULED_JOBS_ENABLED=false`。页面、数据库和 OSS 验证稳定后，再由人工开启定时任务并重启服务，避免迁移期间后台同步抢占 2 GiB 内存。

## 验证与回滚

验证顺序：本机健康检查、Nginx HTTP、HTTPS、登录、数据库只读页面、OSS图片上传。保留上一个发布目录 `/opt/ozon-erp/releases/<version>`；新版本验证失败时，把 `current` 软链接切回上一版本并重启 systemd。

严禁把开发机 `.env`、AccessKey、数据库密码或备份文件放进发布包和代码仓库。
