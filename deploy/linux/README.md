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

## 已审查的平台身份迁移

日常发布只使用已提交的 `main` 或 `release/*` 工作区；本次生产发布必须使用干净的 `release/*` 分支，不使用紧急的 `--allow-dirty` 开关。Windows 和 Bash 入口都会在正式发布前校验工作区，构建记录实际分支、提交和 `production` 渠道。

需要随发布执行身份迁移时，先按 [平台身份与企业成员迁移](../../docs/platform-enterprise-identity-migration.md) 核对清单。每个人必须明确指定平台授权和迁移后保留的全部企业成员关系；部署脚本不会推断人员授权。清单单独上传，不进入发布包。

```powershell
npm run deploy:ecs -- -Version 2026.10.21-identity -ReviewedIdentityManifest "C:\安全目录\reviewed-identities.json"
```

```bash
npm run deploy:ecs:unix -- --version 2026.10.21-identity --reviewed-identity-manifest /secure/reviewed-identities.json
```

执行数据库维护、提供身份清单，或发布包包含始终执行的利润版本 schema 脚本时，远端先使用本机 MySQL root socket 对应用 `DB_NAME` 全库执行 `mysqldump --single-transaction`，包括触发器、事件和存储过程，压缩并校验后才允许数据库初始化或迁移。即使跳过常规数据库维护，利润版本 schema 的准备也必须先完成备份。备份位于 `/opt/ozon-erp/shared/backups/identity-releases/pre-release-<version>-<UTC时间>-<PID>.sql.gz`，新建子目录权限为 `0700`，备份文件为 `0600`；不修改已有备份父目录权限，也不输出数据库密码。

常规迁移包含 `asset_tail_templates` 企业归属列和索引；既有 NULL 归属保持原值。提供身份清单时，在常规 schema 准备后、候选启动前停止记录的旧候选进程和主服务，依次运行官方身份脚本的只读盘点与应用，再继续原有候选、切换和健康检查。未提供清单时不执行身份迁移，也不增加这个停服步骤。

上传的清单位于 `/tmp/ozon-erp-identity-<version>.json`，激活前设为 `0600`，成功后删除；失败时保留用于复核。备份失败会阻止数据库维护，身份迁移失败会触发现有代码回滚。代码回滚不会还原数据库；本次仅显式新增平台授权、保留原有企业关系的清单与旧版读数兼容，其他权限调整必须另行审查回滚方案。
