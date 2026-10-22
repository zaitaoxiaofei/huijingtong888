# 库存、采购试点隔离验收记录

本记录针对 `codex/saas-pilot-isolation` 的开发中代码，不代表 release 或 ECS 已上线。未完成项必须继续关闭，默认企业也不能绕过企业边界。

## 范围规则

- 可信企业上下文来自登录会话；请求体、查询参数不能选择企业。
- `admin` 只解析为启用中的默认企业，查询范围为该企业数值 ID 与合法历史 `NULL`，不会查询全库。
- 产品、组件、SKU、店铺、供应商、采购申请、采购单、入库记录及库存流水同时检查主记录和关联父记录归属。
- 新增采购单、采购明细、入库、成本版本、导入记录均保存明确的企业 ID。历史库存、采购 `NULL` 不自动重新分配。
- 平台共用物流规则引用仅接受启用中的默认企业规则和历史 `NULL` 规则；其他企业的数值归属规则不能被引用。

## 已实施并有真实 MySQL 证据的核心链路

使用 `test/helpers/tenant-mysql-fixture.js` 建立随机测试数据库，执行仓库 canonical schema 与真实订单查询事实初始化。只允许显式指定独立、关闭 TCP 的测试 MySQL socket；结束仅删除该随机库。

`test/tenant-inventory-procurement-mysql.test.js` 已覆盖：

- 有默认企业和外企产品的新库先初始化、再预热库存，外企名称不会被默认预热修改。
- A / B / 默认企业及默认历史 `NULL` 的商品、图片、供应商查询。
- 外企产品、组件、店铺、供应商引用被拒绝，拒绝前不创建库存流水。
- A 企业申请 → 合并采购单 → 确认采购 → 部分收货 → 库存入账；B 和默认企业不读到该批次。
- SKU 组合配方读写、跨企业在线商品和配方组件拒绝。
- 台账不计入指向本企业产品的外企污染流水；企业操作人校验；相同操作重复提交不重复记账。
- 默认历史产品的手动出库、编辑后返回的新流水 ID、删除恢复库存；A 的直接收货保持明确归属。
- 订单采购预览、创建和自动合并确认显式传递企业；跨企业订单和订单明细被拒绝。
- 共用物流规则的默认企业与历史 `NULL` 引用成功，其他企业私有规则引用失败。
- 平台订单、支付账单迁移前后，旧程序和 A / B 新程序对相同外部单号分别保持幂等；跨企业支付匹配被拒绝。

采购台账、采购工作台行为与日报导出的现有聚焦测试继续保留；MySQL JSON 保存后对象键顺序变化，不会导致相同台账提交被误判为不同内容。

## 可独立审核的接口集合

中央门禁由统一权限模块管理；以下是可审核候选，不表示整组已自动放开。

| 集合 | 入口 |
| --- | --- |
| 商品、SKU | `/api/products`、`/api/products/:id`、图片、组件、隐藏/恢复、`/api/mappings`、`/api/sku-inventory-recipes`、在线商品绑定/建品 |
| 基本采购闭环 | `/api/procurement/requests`、`/api/procurement/purchase-orders` 及单条详情/确认/编辑/删除、`/api/inbound-records` 及单条收货 |
| 库存台账 | `/api/inventory/ledger`、`/api/procurement/ledger` 及预览、手动出库、`/api/inventory/movements` |
| 采购读取 | summary、pending-inbound、order-history、purchase-history、cost-versions、stock-cost-tasks、daily-report |
| 导入对账 | platform-orders/import、payments/import、reconciliation、候选支付、匹配与实际成本应用 |
| 异步采购/收货 | confirm-from-requests-async、batch-update-async；通过企业私有任务 registry 恢复可信会话后运行 |

## 必须保留关闭或继续补验的范围

- **产品合并和撤销**：`POST /api/products/merge-preview`、`POST /api/products/merge`、合并历史撤销。旧引用迁移与快照恢复尚未全面检查企业归属，不能仅在外层传企业参数后放开，默认企业也不例外。
- **FBP 全链验收**：虽然主要补货、短缺采购、发仓、入仓、库存/在线同步已加企业范围与关联校验，仍需真实 A / B / 默认企业的完整补货、批次、打印、收货及后台恢复测试后再开放整组入口。
- **高级采购读取/修复**：成本历史回填、组合采购推荐、绑定建议、需求自动刷新和修复入口已逐步补范围，需与实际工作台组合筛选及异常历史数据联合验收，不能把核心链路通过视作全部完成。
- **后台权限变化**：registry 在排队和启动时重新校验企业、成员及订阅；还需补暂停/撤销后的实际库存任务行为证据。

## 迁移顺序与旧程序兼容

`scripts/migrate-tenant-inventory-procurement.mjs` 默认 dry-run；apply 必须显式提供管理员 socket，并加 `--assign-legacy-platform-default`。

1. 增加采购、入库、成本及库存申请/命名字典的归属字段和索引。
2. 检查平台订单、支付交易、支付匹配三表的有效默认企业、重复外部键和父记录归属冲突。
3. 只将这三张已约定属于历史默认工作流的导入表的 `NULL` 填为实际默认企业 ID；其他采购、库存历史 `NULL` 保留。
4. 将三表 `tenant_id` 改为 `NOT NULL DEFAULT <实际默认企业 ID>`，在同一条 `ALTER TABLE` 中替换旧全局唯一键为企业复合唯一键。旧程序省略企业字段仍有默认值和去重保护，没有 `NULL` 唯一键失效的切换空窗。
5. 切换强制写入明确企业 ID 的新程序后，按上述测试验证 A / B / 默认企业；不得因表结构已迁移就扩大业务门禁。

新库 canonical schema 要求导入表明确填写 `tenant_id`；生产升级脚本解析真实默认企业 ID，不假定其恒为 `1`。
