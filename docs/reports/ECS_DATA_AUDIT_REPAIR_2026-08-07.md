# ECS 数据全量审计与修复报告（2026-08-07）

## 结论

本次已完成本地 MySQL 与 ECS MySQL 的全库审计、ECS 修复前备份、非破坏性数据合并、核心财务修复、缺失尾段补齐、磁盘故障处置以及服务恢复验证。

- ECS 基础表由 123 张、约 352,922 行提升到 146 张、约 2,220,004 行。
- ECS 原先缺失的 23 张表已全部创建并补入数据，修复后不存在 `missing_on_ecs` 表。
- `ozon_finance_items` 从 0 行恢复到 49,884 行。
- `order_status_history` 从约 31,858 行补到 1,475,288 行；本地核验时为 1,473,491 行，ECS 为包含线上增量的超集。
- `listing_media_assets` 从 2 行补到 69,334 行。
- `seller_analytics_product_metrics` 从 6,514 行补到 182,948 行。
- `seller_analytics_snapshots` 从 234 行补到 7,697 行。
- `sync_logs` 从 1,964 行补到 53,933 行。
- ECS 磁盘最终从 100% 恢复到约 54%，可用空间约 18GB。
- `ozon-erp` 服务最终为 `active`，服务器本机 `/admin.html` 返回 HTTP 200；公网 HTTPS 已到达认证层，未登录请求返回 HTTP 401。

## 原始问题与根因

本地和 ECS 并非共用同一数据库。两边虽然一度显示相同订单数，但 ECS 缺少大量历史和派生数据，且部分相同主键记录内容不同。

最直接的财务根因是 ECS 的 `ozon_finance_items` 为空；同时 ECS 的 `order_profit_items`、广告日数据以及订单/订单项冻结字段和本地不一致。因此问题不是浏览器缓存，也不是单纯重新计算页面即可解决。

修复前审计发现：

- 23 张表 ECS 完全缺失。
- 60 张表行数不同。
- 36 张表结构哈希不同。
- 大量订单状态历史、刊登资产、分析指标、利润明细快照和插件数据未部署到 ECS。

## 已执行修复

1. 生成本地和 ECS 全库结构、行数、范围、容量审计 JSON。
2. 生成 ECS 修复前一致性压缩备份并校验 SHA256。
3. 采用 `INSERT IGNORE` 逐表合并，保留 ECS 同主键记录及 ECS 较新的类目参考数据。
4. 创建并补齐 23 张 ECS 缺失表。
5. 补齐订单历史、刊登、库存、采购、广告、分析、AI、客户消息、评论、任务和系统历史等表。
6. 对财务流水执行完整补入；对利润明细按本地快照主键修复。
7. 对 6 张结构差异且仍缺尾段的表按主键范围补齐：订单状态历史、刊登草稿、插件采集、出库记录、系统设置变更、采购请求。
8. 合并期间产生大量 MySQL binlog，导致系统盘占满。已将修复前备份下载到本地并校验，然后使用 MySQL 官方命令精确清理 `binlog.000379` 之前的日志，保留 `binlog.000379` 和 `binlog.000380`。
9. 恢复并验证 ECS ERP 服务。

## 修复后对比

修复后审计摘要：

- `missing_on_ecs`: 0
- `row_count_diff`: 20；这些表的 ECS 行数均不低于本地，主要是保留的 ECS 线上增量。
- `same_count_data_diff`: 90；审计工具的 QUICK checksum 对部分表不提供可靠内容级结论，因此同数表仍需按业务键抽样，而不能仅依赖此状态。
- `schema_mismatch`: 36；多数是列顺序、时间默认值或运行期懒迁移差异。关键表的数据已按明确列名成功合并。

典型 ECS 超集：

- `seller_analytics_product_metrics`: 本地 176,434，ECS 182,948。
- `scheduled_job_run_events`: 本地 118,475，ECS 139,906。
- `seller_analytics_snapshots`: 本地 7,471，ECS 7,697。
- `sync_logs`: 本地 53,859，ECS 53,933。
- `listing_media_assets`: 本地 69,332，ECS 69,334。

## 同主键订单链覆盖结果

经用户明确授权，已按本地一致快照覆盖 ECS 中 `orders`、`order_items`、`ozon_orders_raw` 和 `order_profit_items` 的同主键记录。覆盖会话关闭了 binlog，并在短暂停止 ECS ERP 服务后执行；结束后服务已恢复。

覆盖后的 2026 年 7 月订单利润基础聚合如下：

| 指标 | 本地 | ECS | 差额（ECS - 本地） |
|---|---:|---:|---:|
| 利润行数 | 3,289 | 3,289 | 0 |
| 销售额 | 131,428.08 | 131,428.08 | 0.00 |
| `net_profit_cny` 合计 | 45,226.51 | 45,226.51 | 0.00 |
| `gross_profit_cny` 合计 | 49,545.42 | 49,545.42 | 0.00 |

本地与 ECS 的 7 月聚合差额已归零。最终计数中 ECS `order_profit_items` 比本地多 2 条 ECS 独有记录；这些记录不属于同主键覆盖范围，因此按保留线上增量的原则未删除。

## 备份、审计与回滚

修复前 ECS 完整备份已下载并校验保存在：

`ozon-system/.deploy-artifacts/data-audit-2026-08-07/ecs-before-repair.sql.gz`

SHA256：

`31cb39ebd536efba529f20ce825534bddc24808930df93dc198f742210e39c2e`

审计文件目录：

`ozon-system/.deploy-artifacts/data-audit-2026-08-07/`

关键文件包括：

- `local-audit.json`
- `ecs-pre-repair-audit.json`
- `ecs-post-repair-audit.json`
- `diff-pre-repair.json`
- `diff-post-repair.json`
- `diff-post-repair.txt`

如需回滚，必须先停止 ECS ERP 服务，再将上述 SQL 压缩备份恢复到新的隔离数据库并验证，禁止直接覆盖当前库。

## 运维建议

1. 扩容 ECS 系统盘或将 MySQL 数据盘独立出来；40GB 对完整业务数据、备份和 binlog 余量不足。
2. 设置 MySQL binlog 到期策略和磁盘告警，避免再次占满。
3. 部署流程必须带数据库迁移和数据同步检查，不能只发布代码。
4. 订单、财务和利润应建立定期对账任务，至少检查订单数、财务流水数、利润行数和月份汇总。
5. 后续执行同主键覆盖前，先生成字段级差异清单并由业务确认。
