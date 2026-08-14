# ECS 一键部署

这套流程用于把本地当前版本发布到 Ubuntu ECS，不需要再打开 Workbench 上传 ZIP 或逐段复制 Linux 命令。

## 首次准备

推荐按下面方式配置，整个过程只做一次：

1. 打开阿里云 ECS 控制台，确认地域选择“华南2（河源）”。
2. 进入“网络与安全 → 密钥对”，点击“创建密钥对”。
3. 名称填写 `ozon-erp-deploy`，创建类型选择“自动创建密钥对”。
4. 创建后浏览器会自动下载一个 `.pem` 文件。这个文件通常只能下载一次，请妥善保管，不要发送给任何人。
5. 返回 ECS 实例列表，找到当前服务器，点击“全部操作 → 绑定密钥对”，选择 `ozon-erp-deploy`。
6. 确认绑定并重启 ECS。控制台绑定密钥对必须重启后才生效，重启期间服务会短暂中断。
7. 回到本项目，双击 `首次配置阿里云密钥.vbs`，选择刚下载的 `.pem` 文件。
8. 弹出“配置成功”后，以后只需双击 `一键部署到阿里云.vbs`。

首次配置工具会把私钥复制到当前 Windows 用户的 `.ssh/ozon-erp-deploy.pem`，限制文件权限，并把主机、用户和私钥路径保存到 Git 忽略的 `.deploy-artifacts/ecs-deploy.json`。不会保存数据库密码、OSS 密钥或阿里云 AccessKey。

开发电脑需要 Windows OpenSSH。PowerShell 中确认：

```powershell
ssh -V
scp -V
```

建议给 ECS 配置 SSH 密钥。密钥只保存在开发电脑，不写入项目、发布包或服务器环境文件。可以使用已有私钥，并设置：

```powershell
$env:OZON_ECS_IDENTITY_FILE="C:\安全目录\ozon-ecs-key"
```

如果 ECS 地址或 SSH 用户改变，可以设置：

```powershell
$env:OZON_ECS_HOST="47.113.195.4"
$env:OZON_ECS_USER="root"
$env:OZON_ECS_PORT="22"
```

服务器必须已经具备当前基础环境：Node.js 22、MySQL、Nginx、`ozon-erp` 系统用户、`ozon-erp.service`，以及 `/etc/ozon-erp/ozon-erp.env`。

## 日常发布

最简单的方式：直接双击项目根目录的 `一键部署到阿里云.vbs`。确认后会在后台完成全部工作，不需要打开 PowerShell 或 Workbench。结束时会弹出成功或失败提示，日志保存在 `.deploy-artifacts/one-click-deploy.log`。

命令行方式如下：

进入 `ozon-system` 后执行：

```powershell
npm run deploy:ecs
```

脚本会自动完成：

1. 部署前检查、UTF-8 检查、SQL 检查和前端生产构建。
2. 生成不含 `.env`、数据库密码、OSS 密钥和历史 uploads 的发布包。
3. 通过 SCP 上传发布包和服务器发布脚本。
4. 在 `/opt/ozon-erp/releases/<version>` 安装新版本。
5. 复用 `/opt/ozon-erp/shared/uploads`，不会覆盖历史上传目录。
6. 执行兼容性数据库初始化、切换 `current` 软链接并重启 `ozon-erp`。
7. 检查 `127.0.0.1:3000`；失败时自动切回上一版本。
8. 成功后保留当前版、上一版及一个更早版本，清理更旧发布目录。

只检查命令配置、不构建和发布：

```powershell
npm run deploy:ecs -- -DryRun
```

使用指定版本号：

```powershell
npm run deploy:ecs -- -Version 2026.08.01-001
```

紧急情况下跳过数据库初始化：

```powershell
npm run deploy:ecs -- -SkipDatabaseInit
```

构建产物保存在 `.deploy-artifacts`，该目录已被 Git 忽略。服务器真实配置始终保留在 `/etc/ozon-erp/ozon-erp.env`，不会跟随发布包上传。

## 本地验证

本地测试继续使用受控端口 `8788`：

```powershell
npm run start:server
```

访问：`http://localhost:8788/admin.html`。`8787` 和 `8087` 及其原有环境已经移除；生产发布统一使用上述 ECS 流程。
