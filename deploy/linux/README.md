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
npm run deploy:ecs -- -Version 2026.10.21-identity -ReviewedIdentityManifest "C:\安全目录\reviewed-identities.json" -AllowServiceInterruption
```

```bash
npm run deploy:ecs:unix -- --version 2026.10.21-identity --reviewed-identity-manifest /secure/reviewed-identities.json --allow-service-interruption
```

执行数据库维护、提供身份清单，或发布包包含始终执行的利润版本 schema 脚本时，远端先使用本机 MySQL root socket 对应用 `DB_NAME` 全库执行 `mysqldump --single-transaction`，包括触发器、事件和存储过程，压缩并校验后才允许数据库初始化或迁移。即使跳过常规数据库维护，利润版本 schema 的准备也必须先完成备份。备份位于 `/opt/ozon-erp/shared/backups/identity-releases/pre-release-<version>-<UTC时间>-<PID>.sql.gz`，新建子目录权限为 `0700`，备份文件为 `0600`；不修改已有备份父目录权限，也不输出数据库密码。

常规迁移包含 `asset_tail_templates` 企业归属列和索引；既有 NULL 归属保持原值。提供身份清单时，在常规 schema 准备后、候选启动前停止记录的旧候选进程和主服务，依次运行官方身份脚本的只读盘点与应用，再继续原有候选、切换和健康检查。未提供清单时不执行身份迁移，也不增加这个停服步骤。

上传的清单位于 `/tmp/ozon-erp-identity-<version>.json`，激活前设为 `0600`，成功后删除；失败时保留用于复核。备份失败会阻止数据库维护，身份迁移失败会触发现有代码回滚。代码回滚不会还原数据库；本次仅显式新增平台授权、保留原有企业关系的清单与旧版读数兼容，其他权限调整必须另行审查回滚方案。

## 已审阅的素材优化历史归属

素材批次的历史归属清单与人员身份清单分别传递，不进入发布包，也不打印清单内容：

```powershell
npm run deploy:ecs -- -Version 2026.10.23-reviewed-material -ReviewedAiMaterialManifest "C:\安全目录\reviewed-material.json" -AllowServiceInterruption
```

```bash
npm run deploy:ecs:unix -- --version 2026.10.23-reviewed-material --reviewed-ai-material-manifest /secure/reviewed-material.json --allow-service-interruption
```

清单由素材迁移脚本严格核对批次、全部明细、原操作人、来源和结果草稿、优化任务以及原行摘要。远端第 5 个参数仍为人员身份清单，第 6 个参数为素材清单；没有身份清单时保留空占位。素材清单以随机临时文件名上传，创建时即限制为 `0600`，客户端和远端在成功、失败退出时均尝试删除，日志只记录执行结果。

正式发布先只读检查素材结构和历史归属。未被清单完整覆盖的异常历史会拒绝发布，不能在日常发布中静默隐藏到待核对区；空库可以创建新结构。只有确需素材结构或归属变更时，才要求批次及明细均无等待、运行任务；有任务时直接拒绝本次发布，不取消任务、不自动等待。

普通发布若检查出素材结构／归属需要变更，或提供了人员身份迁移清单，会在备份、数据库变更和停服前拒绝，并保留原服务。只有明确安排维护窗口并传入 `-AllowServiceInterruption`／`--allow-service-interruption` 时，才执行原有停写流程：完整备份校验后停止旧主服务和旧候选，再次复核任务和清单，应用迁移、预热候选后切换。该开关允许维护窗口内中断服务，不是绕过清单、活跃任务检查或迁移鉴权。没有覆盖所有旧写入路径的业务写门禁时，不能让旧进程继续写入来伪装无停机迁移。代码回滚不等于数据库回滚，原记录继续保留在归属审阅元数据中。已完成历史的原员工后来停用，不会改变仍有完整证据的企业归属；未完成任务仍要求有效操作人。

## 候选预热与失败回退

普通兼容发布在主服务运行期间预热候选，完整的就绪和版本检查预算为 360 秒；不再使用上次首次素材迁移的 45 秒冷启动限制。安装、只读预检或候选预热失败时，只清理本次候选，不改 `current` 链接、不重启仍在服务的主进程。候选必须同时通过 `/api/ready` 与发布版本检查，之后才能切换链接和重启主进程。

如果切换之后主进程启动失败，回退旧链接并等待旧版本实际就绪，同时保留已经验证的新候选承接 Nginx 故障转移。即使旧主已就绪，也保留该候选作热备，由下次发布安全替换，避免 Nginx 尚在故障等待期时失去备用进程。旧主未恢复时明确报告回退未就绪并保留候选，不能只凭 `systemctl restart` 返回成功就报告恢复。显式维护仍可能有冷启动停机，360 秒是单个就绪阶段预算，不是停机时长承诺。

2026-10-24 的定向测试执行实际 Bash 发布函数、模拟服务控制与 HTTP 回应，覆盖超过 45 秒的冷启动、预切换失败不重启主服务、切换后旧主恢复、旧主恢复失败保留候选、错误版本和意外退出拒绝，以及默认禁止迁移停写。没有访问 ECS 或对生产执行部署、迁移、重启；生产交付前仍须按正式流程验证。

## 性能索引、冻结内容读取与积分准备

发布会在校验数据库备份后、候选启动前，依次只读检查并应用订单搜索索引、草稿列表索引、冻结内容表及积分五表的增量迁移。即使跳过常规维护，这四项准备也会执行；遇到同名不兼容结构直接拒绝，不自动改写账务或历史业务行。迁移不创建积分账户、不充值、不设置价格，也不自动启用冻结草稿写入。普通发布继续保持 `LISTING_FROZEN_DRAFT_TENANTS` 为空，先让当前及可回滚版本都具备读取能力，后续再按企业试开新 writer。

四个增量 CLI 的独立数据库会话均设 `lock_wait_timeout=5`。订单和草稿索引使用 `ALGORITHM=INPLACE, LOCK=NONE`，不支持时拒绝，不降级为拷表；冻结内容和积分迁移只创建缺少的空表。长事务阻塞元数据锁时约五秒失败并保留原服务，待阻塞解除再重试；该设置不是整个迁移的运行时限，也不能保证在线索引创建完全没有短时锁。

积分结果元数据保存在 `shared/private-ai-results`，发布目录的 `data/ai-credit-results` 只链接这个共享私有目录；也可通过 `AI_CREDIT_RESULT_ROOT` 指定其他受保护的持久目录。不得指向 public/uploads，不把结果数据装入代码包。数据库备份完成后，同批保存 `.ai-results.jsonl.gz` 文件，逐条校验内容及总清单摘要。SQL 与结果文件需要配对保留，不能只恢复钱包数字却丢掉成功结果。

配置的私有结果目录缺失或链接异常时直接拒绝本轮发布，不会静默跳过配对备份。备份/恢复会检查祖先目录链接，恢复先写私有临时文件、同步后原子安装最终文件，避免暴露半写入结果；发生冲突时不覆盖原文件。

定向恢复默认只检查，不写入；显式 `--apply` 也只补缺失文件，相同内容可重放，冲突文件拒绝覆盖。先恢复到独立私有目录并验证，再按数据库恢复点匹配，不能把恢复脚本直接当作线上回滚命令：

```bash
node scripts/backup-private-ai-results.mjs --inspect --input=/secure/pre-release.ai-results.jsonl.gz
node scripts/backup-private-ai-results.mjs --restore --input=/secure/pre-release.ai-results.jsonl.gz --root=/secure/ai-results-restore
node scripts/backup-private-ai-results.mjs --restore --apply --input=/secure/pre-release.ai-results.jsonl.gz --root=/secure/ai-results-restore
```

文件恢复验证包括损坏/截断、路径穿越、符号链接、重复及超大条目、已有文件冲突和部分写入撤回。此验证覆盖积分结果元数据，不代替整套人工资料与 OSS 媒体恢复验收。
