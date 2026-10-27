# AI 工作素材保留与回收

规则：AI 工作素材保留 7 天；已经采用到草稿、商品、案例、刊登记录或正在执行的任务中的素材继续保留。日期按 UTC 保存，管理界面按北京时间显示。删除展示索引与删除 OSS 实物分开执行。

AI素材页面的两条列表请求显式发送 `recent_days=7`，只展示近 7 天创建的工作素材。`GET /api/material-assets` 与 `GET /api/listing/ai-variant-assets` 的该参数可选，只接受整数 1–7；不传参数的历史消费者和详情读取保持原行为。旧素材即使最近被编辑也不会重新进入近七日工作库；已经采用的文件仍可从草稿和案例中使用。

## 范围

- `material_assets`：仅 `ai_generated`、`ai_variant`、`ai_variant_workbench`、`ai_product_material_optimizer`、`asset_variant_engine`、`asset_variant` 来源。
- `listing_media_assets`：仅 `asset_variant`、`ai_variant_workbench`、`ai_variant_rich_text`、`ai_product_material_optimizer`、`ai_optimization_v2`、`ai_optimization_v2_lightweight`、`ai_material_optimizer`、`ai_variant_lab`、`ai_generated`、`ai_ecommerce_suite_workbench` 来源。
- `listing_ai_variant_assets`：仅明确 AI 来源，且 `field_status` 为 `generated/completed/ready/saved/failed/done` 的结果索引。
- `source/raw/reference/input/original` 角色、未知来源、生成中状态均不纳入。生产存在的 `public_ready/local_only` 是已生成工作素材状态，可以在保护检查后过期。
- `created_at` 和最后 `updated_at` 都必须早于固定审阅截止时间。默认企业的旧 NULL/admin 归属通过数据库中 `slug=default` 的真实 ID 识别；其他企业依然独立。物理文件引用保护扫描全部企业，因为相同内容可能共用一个 OSS key。

不会删除积分流水、供应商回执、未知结果、财务资料、订单、业务草稿或公共定义。原 30 天 AI 历史清理任务没有被改成 7 天。

## 引用保护

扫描真实存在的业务表及 URL、路径、JSON 字段，包括草稿、冻结主版本、类目模板、刊登快照、店铺副本、在线商品、库存商品、成功案例、工作台草稿和活跃后台任务。JSON 中转义的 URL、显式素材 ID 和迁移映射仍指向的 OSS 目标也受保护。其他保留的素材索引可保护共用对象。旧终态任务输出本身不会无限期保留全部候选素材；未知结果、审核中任务和未结积分会阻止所属企业索引回收。

必要业务表缺失、JSON 损坏、扫描超过上限时保留全部候选。报告会说明保留原因，不能宣称全部清空。旧的未采用矩阵生成结果不当作永久业务引用；已导入和近期矩阵结果继续保护。

## 预览与人工执行

工具不读取应用配置，不推断数据库。必须明确本机管理员 socket、数据库和绝对清单路径；OSS 配置由受控进程环境提供。清单仅保存 ID、企业、来源、状态、角色、日期、输出 URL 及完整原行摘要，不携带大段 metadata、提示词或原始 JSON。原行恢复由部署维护前的已批准数据库备份保障。清单使用私有目录、0600 权限，不应放入公共下载目录或 Git。

```sh
node scripts/cleanup-ai-media-retention.mjs \
  --database=ERP_DATABASE --mysql-admin-socket=/var/run/mysqld/mysqld.sock \
  --output=/private/retention/plan.json --limit=25000 --max-scan-rows=2000000 \
  --prior-manifest-dir=/private/retention/queue
```

默认只有 SELECT、OSS list/head 和清单写入。CLI 默认每表检查 200 条；显式提高上限时仍每页最多读取 10 个完整候选，逐行计算摘要后释放大字段。单行文本总量超过 8 MiB 的索引保留，不纳入本批候选。业务引用扫描同样小页读取，并设行数、单行字节、引用 token 和内存预算；超大业务行只读取警示标记，整批按扫描不完整保留。`ai-unused/` 可从完整临时命名空间清单发现；永久 `listing-media/` 只接受明确 AI 输出索引或以往受保护清单证明的来源。不会因为文件超过 7 天而删除未知来源的永久对象。

大表引用扫描依据真实索引使用 `id > 上页末尾 ID` 翻页，避免累进 OFFSET 反复扫描前面的数据；迁移 URL 映射也只按 ID 遍历一轮。只有非空、单列唯一 ID 才使用该方式。企业与 ID 组成复合键的表继续完整小页扫描，避免相同 ID 的其他企业引用被跳过。

清单只能用于相同数据库和 server UUID，24 小时内有效。即使只删除索引，`--apply` 也必须同时提供 `--offline-maintenance`：现有业务写入没有统一素材行锁，在线扫描之后可能新增只引用素材 ID 的记录。工具重新扫描当前引用，在事务中锁定并核对原行完整指纹后才删除索引；行已改变则保留。

## 离线 OSS 回收

永久对象回收必须在部署脚本明确停掉所有 ERP 服务、候选服务和 worker 后执行：

```sh
node scripts/cleanup-ai-media-retention.mjs \
  --database=ERP_DATABASE --mysql-admin-socket=/var/run/mysqld/mysqld.sock \
  --manifest=/private/retention/plan.json --apply --offline-maintenance
```

CLI 只允许本机 Linux 维护环境，检查其他 Node/tsx 应用与 ERP Python worker 进程、目标数据库其他连接，产生绑定该清单的私有维护证据。PM2 的空闲守护进程可以存在。每个删除操作前再次检查；写入冻结无法证明就停止，不用“已停止某一个端口”代替全部 writer 停写。

数据库索引处理完后，再做一次不排除剩余索引的全企业引用扫描，逐对象复核 key、bucket、长度、ETag、最后修改时间和版本信息。对象变新或有引用则保留；任意非空版本号（包括版本暂停桶中的字符串 `null`）都需要另外审阅版本保留策略，本工具不删除。DeleteObject 不依赖未经官方确认的 If-Match 原子比较语义；安全边界是全部 writer 已停写和删除前再次 HEAD 核验。删除并发上限 6，head 并发上限 8。只允许 `ai-unused/` 与来源已确认的 `listing-media/`；`product-media/collector-media/video-source/database-archives` 和任意其他前缀均不能物理删除。

## 自动任务契约

`createAiMediaRetentionSweep({ query, storage, saveManifest, loadCursor?, saveCursor? })` 每次每表最多检查 200 条旧素材，只保存候选清单并推进游标，返回 `pending_offline_gc/rows_queued`。自动任务不硬删索引或 OSS 对象，避免扫描与新业务引用写入之间的竞态。实际删除在统一维护停写窗口中执行。

`saveManifest` 必须把最小清单持久保存到 shared 私有队列，并返回文件名。旧清单保留 AI 来源证据；以后离线预览传入 `prior-manifest-dir`，在重新反查引用与校验 OSS 头之后，才生成新的物理回收计划。不能先删索引再丢弃来源。队列读取也有文件大小和总内存上限，过大时应明确分批审阅。队列清单不是用户界面的永久素材库。

游标由 `manifest.next_after_ids` 提供，`loadCursor/saveCursor` 可保存到 shared 私有状态文件，重启后继续分页。引用中的旧素材不会让批次一直停留在前 200 条；扫到末尾后从头开始下一轮。

清单生成不等于已经清理。上线执行结果应分别报告删除索引行数、实际删除对象数、实际回收字节、保留原因及失败项。
