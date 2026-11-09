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
$env:OZON_ECS_HOST="47.120.47.194"
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

跳过兼容性数据库初始化（仅显式开启广泛维护时才会运行初始化）：

```powershell
npm run deploy:ecs -- -SkipDatabaseInit
```

日常发布默认跳过广泛数据库维护，以下旧开关仍可兼容使用：

```powershell
npm run deploy:ecs -- -SkipDatabaseMaintenance
```

无需广泛维护及兼容性初始化时，也可显式使用两个旧开关；候选必需结构仍会只读预检：

```powershell
npm run deploy:ecs -- -SkipDatabaseInit -SkipDatabaseMaintenance
```

默认不执行广泛维护。确需维护时使用 `-RunDatabaseMaintenance`（Bash 为 `--run-database-maintenance`）；不能与跳过维护开关同时传入。候选必需结构先只读检查，有实际迁移需求才校验备份并应用，发布包带迁移脚本不代表需要备份。构建、上传、服务切换、重启和健康检查仍会执行。应用原有启动时的幂等 schema warmup 不受这些发布开关控制。

构建产物保存在 `.deploy-artifacts`，该目录已被 Git 忽略。服务器真实配置始终保留在 `/etc/ozon-erp/ozon-erp.env`，不会跟随发布包上传。

## macOS / Linux 命令行入口

macOS 和 Linux 使用 Bash 3.2+，并安装 Node.js/npm、OpenSSH 的 `ssh`/`scp` 与 `zip`。入口复用 Windows 流程所调用的 `npm run package:deploy` 和同一个 `deploy/linux/remote-release.sh`，不会维护另一套服务器发布规则。

只验证参数和本机配置、不构建、不联网、不发布：

```bash
npm run deploy:ecs:unix -- --dry-run
```

指定版本发布（必须先取得生产发布授权）：

```bash
npm run deploy:ecs:unix -- --version 2026.09.07-001
```

Mac 独立密钥可通过以下环境变量指定：

```bash
export OZON_ECS_IDENTITY_FILE="$HOME/.ssh/ozon-erp-mac-deploy"
```

不要复制 Windows 私钥，也不要禁用 SSH 主机身份校验。正式执行前，应先使用 `BatchMode=yes` 做只读 SSH 连通性验证，并通过可信渠道核对首次出现的主机指纹。

关键步骤对照：

| Windows PowerShell 入口 | macOS/Linux Bash 入口 | 共同验证点 |
| --- | --- | --- |
| `npm.cmd run package:deploy` | `npm run package:deploy` | 部署预检、编码、SQL、前端构建、插件打包和部署清单 |
| `tar.exe -a ...` | `zip -r ...` | 单个版本化 ZIP 发布包 |
| `scp` 上传 ZIP 和远端脚本 | `scp` 上传同样两项 | 不上传 `.env` 和历史 uploads |
| SSH 调用 `remote-release.sh` | SSH 调用同一文件 | 发布目录、数据库初始化、候选实例、切换、重启、健康检查、回滚、清理 |

DryRun 在创建产物目录、构建、压缩、上传和任何 SSH 命令之前退出，因此不会触碰生产文件、数据库或服务。

## 本地验证

本地测试继续使用受控端口 `8788`：

```powershell
npm run start:server
```

访问：`http://localhost:8788/admin.html`。`8787` 和 `8087` 及其原有环境已经移除；生产发布统一使用上述 ECS 流程。
## 未变组件复用（本地验证，尚未部署）

Mac/Linux 的 `deploy-ecs.sh` 使用 Linux 打包配置：完整保留应用快照和来源提交，
将 `mutool.exe`、`SumatraPDF.exe` 拆成单独校验的 gzip 对象。首次发布需要上传工具；
后续内容未变就复用 `/opt/ozon-erp/artifacts/files/` 中的 SHA-256 对象。
每个发布目录仍引用明确版本，旧版本回滚不会被新工具覆盖。
Windows/通用包继续保留完整 tools 目录，PowerShell 入口保持原上传方式，兼容现有使用者。

依赖缓存位于 `/opt/ozon-erp/artifacts/dependencies/`。缓存指纹包括 package.json、
锁文件、Node 版本及 ABI、平台、架构、libc、npm 版本和安装配置。
只改应用代码可以复用缓存；指纹变化则重新受限安装并原子发布新缓存。
根项目存在安装生命周期脚本时禁用复用，防止跳过依赖应用源码的安装动作。
命中缓存仍检查原生模块能否加载，并保留原有资源预检和安装限额。

缓存归 root 所有且只读，发布目录使用符号链接。禁止原地修改缓存，禁止从正在运行的
生产目录拷贝 node_modules 拼接发布包，禁止删除当前、候选及保留回滚版本引用的对象。
不完整或校验失败的缓存会拒绝发布。这一批不自动清理共享组件缓存。

上传目录和发布脚本带独立任务后缀，上传失败会重试，激活前校验 SHA-256。
发布由独立 systemd 单元执行，最长运行 30 分钟；SSH 状态探测断开不会终止已启动任务。
本地任务信息保存在 `.deploy-artifacts/deploy-job-*.json`。无法确认结果时应先检查该单元，
不能直接重试；运行中的任务所需私有审核清单会保留。热备候选使用独立 systemd 单元，
禁用定时任务，发布任务退出时不会一并清理热备。

前端资源使用内容哈希，不附加时间戳。版本号、渠道写入 HTML 外壳和 release.json，
避免只更换版本标签就导致路由资源全部变化，版本显示和更新检测仍保留。
本批继续使用原有候选预热及主服务切换流程，尚未实现纯前端发布免重启后端。
