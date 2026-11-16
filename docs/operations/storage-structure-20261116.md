# 存储优化顺序与验收

2026-11-16只读调查：磁盘已用约32.14GB，可用约7.81GB。以下均为十进制字节单位；候选大小不是承诺可立即释放的磁盘量。

| 顺序 | 对象与现有占用 | 本轮处理及清理条件 |
| --- | --- | --- |
| 1 | 上传与缓存约4.41GB | 复用已发布的OSS持久化与按需恢复。仅对私有/发布副本完整哈希一致、恢复路径通过实测、全局引用扫描完整、无活动写入的文件执行已有审核清理。近期、任务状态不明及引用不明的文件保留；不提高权限、不放宽引用保护。 |
| 2 | 历史备份约4.28GB | 默认只读运行`prune-release-backups.mjs`。当前最新两对、显式pin、维护依赖及未配对SQL均保留，没有自动可删候选。迁出完整数据库备份和解除本地恢复依赖需要具体归档/恢复方案及单独授权；本轮不取消pin。 |
| 3 | 模板：editable约965MB、独立属性约536MB | 大属性/原始元数据分段压缩，同一字段内相同内容只保存一个字典项。独立属性保持JSON数组，名称、已选值保留明文；API和事务读取自动还原。旧格式可读，新写入显式开关控制。 |
| 4 | 草稿manual_facts约788MB、ai_payload约96MB | 同样的可逆分段存储；变体数组、图片、价格、来源商品ID、资产ID保留原SQL投影。独立企业内逐字段归档、CAS更新，后续编辑不覆盖。 |
| 5 | 已分配但可复用的数据库页 | 逻辑压缩不等于`.ibd`立刻缩小。仅在迁移、恢复、业务接口均通过后，再测量目标表空闲页并安排有空间预算的单表重建；本工具不自动执行OPTIMIZE/TRUNCATE。 |
| 6 | 商品图片字段：已读出的内嵌媒体至少18MB，另有超过读取上限的大字段 | 新图片/视频先OSS存储并实际读回SHA核验，数据库只存URL。失败拒绝保存。历史`products`逐页迁移，先私有归档原图片字段，后做租户内CAS更新，支持恢复。不可读超大记录保留，分批另查。 |
| 7 | 部署暂存约250MB、旧依赖约377MB、14天前系统日志约336MB | 清理前重新核对主备/回滚版本、符号链接和进程引用。旧系统日志清理会减少排障材料。与恢复点、业务附件和正在使用的Python依赖分开审核。 |

swap文件4.29GB是系统交换空间，目前有实际使用，不作为垃圾文件删除。订单状态/利润修订属于审计历史，本轮不改利润版本、不批量删除；抽样重复指纹仅作为后续调查候选。

## 新版本的兼容性与发布

- `LISTING_SECTION_STORAGE_ENABLED`默认关闭。先从精确合并release提交构建并部署，主服务和备用服务均验证读取新旧格式后，才显式设置`LISTING_SECTION_STORAGE_ENABLED=1`启用新写入。生产部署、重启与配置变更按AGENTS.md要求提交具体版本和验证结果，经用户批准后执行。
- 新格式只用于`listing_drafts.manual_facts_json/ai_payload_json`与`listing_category_templates.editable_payload_json/attributes_json`。现有冻结模板格式、发布记录和财务历史不转换。
- 普通MySQL读取、别名、连接池事务与一致性读都还原JSON。后台引用扫描独立还原新格式；损坏或超过扫描界限时标记不完整并拒绝清理。
- 图片校验会读取已上传的真实OSS内容；不使用HEAD长度代替哈希。新内嵌媒体处理无本地/数据库base64回退。
- 删除旧的原始JSON前，`private-json-archive`在`database-archives/listing-drafts/<tenant>/`、`listing-templates/<tenant>/`或`inventory-media/<tenant>/`创建私有gzip原文，读回校验，再写持久化恢复映射。数据库JSON的原文字节可恢复，API重组结果做JSON语义相等验证。
- 归档模板原文、历史商品媒体字段及额外恢复清单的生产导出范围，在发布审批中明确列出；工具存在不等于已执行或已获授权。

## JSON迁移

使用部署包自身的脚本，工作目录必须为已审核的当前release。先核对主备进程均运行同一读取兼容版本。管理员socket与数据库名必须显式提供；不复用生产密码运行本地测试。

```bash
# 只读：每页10条，生成哈希计划，不把原文写进审核清单。
node scripts/migrate-listing-json-sections.mjs --mode=audit --tenant=admin \
  --table=listing_category_templates --socket=/var/run/mysqld/mysqld.sock \
  --database=ozon_erp --out=/opt/ozon-erp/shared/storage-reviews/REVIEW/templates --all

# 先审核一页作为小批量试迁移；文件名取实际审计输出。
flock -n /var/lock/ozon-erp-release.lock node scripts/migrate-listing-json-sections.mjs \
  --mode=apply --write --socket=/var/run/mysqld/mysqld.sock --database=ozon_erp \
  --plan=/opt/ozon-erp/shared/storage-reviews/REVIEW/templates/page-0001.json

# 重新读取OSS原文、核对数据库存储哈希并解压重组逐项比较。
node scripts/migrate-listing-json-sections.mjs --mode=verify \
  --socket=/var/run/mysqld/mysqld.sock --database=ozon_erp \
  --plan=/opt/ozon-erp/shared/storage-reviews/REVIEW/templates/page-0001.json.result.json

# 首批做实际恢复演练；原有字段原文字节应完全一致。
node scripts/migrate-listing-json-sections.mjs --mode=restore --write \
  --socket=/var/run/mysqld/mysqld.sock --database=ozon_erp \
  --plan=/opt/ozon-erp/shared/storage-reviews/REVIEW/templates/page-0001.json.result.json
```

恢复成功后重新审计该页再压缩，避免覆盖已有结果文件。草稿将`--table`改为`listing_drafts`。每批至少保留3GiB磁盘，再为下一字段预留4倍原始大小；本批binlog增长预算最多256MiB，达到后停止。清理已核验的关闭日志或等待保留期回收后，重新审计余下记录继续，不能关闭binlog或降低保留期绕过预算。

恢复日志在更新事务前`fsync`，并在提交后登记。中断的partial结果与journal均保留；不能当作整页完成结果盲目重试。恢复要求数据库UUID、租户、列白名单、原文哈希和当前存储哈希全部一致；用户已编辑的记录拒绝回滚覆盖。

## 历史内嵌图片

`migrate-inventory-inline-media.mjs`同样默认只读。`--mode=audit --tenant=admin --socket=... --database=... --out=/绝对路径/plan.json`只审计10条；根据`next_after_id`翻页。审核后`--mode=apply --write --plan=...`迁移，`--mode=verify --plan=....result.json`会从私有归档恢复原图片字节，重新核验实际OSS媒体再与数据库URL比较；`--mode=restore --write`用于实际恢复演练。总原文字段超过60MiB的商品原样保留。历史合并/财务恢复快照中的内嵌媒体不直接改写。

## 必须通过的检查

1. 独立本地MySQL：默认企业和A/B企业隔离，普通查询/别名/事务/快照均可读；变体计数、查询用ID、图片手动清空和已选字典值不变；失败的OSS/恢复日志不能触发数据库更新；真实恢复原文字节通过。
2. 部署后：主备ready、模板详情、完整/轻量草稿、模板关键词/车型筛选、SKU图片编辑排序、发布校验、商品图片预览、视频及下载。
3. 每批：私有归档实际读回、存储哈希、解压重组、未压缩字段和业务更新时间不变；最后核对无未知/近期任务及遗漏引用，才清理审核范围内的本地缓存或旧副本。
4. 原文归档、恢复映射、受保护备份及现用依赖不随资源清理删除。发布程序回滚前先恢复新格式记录或使用包含新读取器的回滚版本。

## 本轮验证记录

- 205项相关功能测试通过，21项独立本地MySQL检查通过；另行开启新格式验证真实模板/草稿创建、编辑、发布SKU关联、完整及轻量读取与恢复。
- 前端构建、UTF-8编码检查、SQL绑定检查通过。构建提示既有大chunk与AI页面运行时代理告警，未改动对应前端。
- 扩展回归中，`tenant-inventory-procurement-mysql.test.js`因旧测试输入缺包装字段失败，`mysql-interactive-read-priority.test.js`因VM测试上下文缺`createOrderReadDiagnostics`失败；均在未修改的11236127基线复现，不计作本轮通过项。
- 生产只读备份审核没有可删候选。本轮尚未部署新程序、启用新写入、迁移历史JSON或执行新一轮资源删除。上述生产步骤需要具体版本批准及逐批验证，不将本地合成数据的压缩比当作线上节省量。
