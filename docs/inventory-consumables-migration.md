# 库存耗材类型与显式迁移

`products.is_consumable` 为独立的耗材标志，类型为 `TINYINT(1) NOT NULL DEFAULT 0`。礼盒、气泡袋、香薰片可以标记为耗材；类目名称本身不会触发全库自动标记。旧产品默认仍为 `0`。

该字段独立于 `is_accessory`：一个耗材可以同时作为配件。不会更改 `products.id`、旧 `code`、库存编号、`product_type`、SKU 绑定、组件配方、采购入出库或扣减算法。本次不切换库存编号。

## 工具与执行边界

`scripts/migrate-inventory-consumables.mjs` 不加载应用数据库配置，不支持 TCP 地址，只接受明确数据库和本机管理员 socket / Windows named pipe。默认只读；本地测试仅使用独立测试库和 `8788` 对应开发环境。ECS 执行、部署及服务重启均须本次发布的用户明确批准，并通过[正式发布流程](../deploy/linux/README.md)传入已审核的耗材清单。

先在目标数据库检查添加列的计划，不提供 `--apply`：

```bash
node scripts/migrate-inventory-consumables.mjs --database=REVIEWED_DB --mysql-admin-socket=/var/run/mysqld/mysqld.sock
```

获批后，以同样参数加 `--apply` 只新增缺失的列，不标记任何现有产品。已有列必须为兼容定义，否则拒绝；不改写旧列。DDL 使用 `ALGORITHM=INSTANT`，锁等待上限 5 秒，失败后保留现有服务并排查原因。新增列与产品标记是两次独立操作，避免 DDL 隐式提交破坏标记事务。

## 逐个产品审核

从当前企业快照生成并人工审核清单；不得按品名子串批量选写。仅支持本轮明确的三个核心品名：礼盒、气泡袋、香薰片。示例中的 ID 与编码均为占位值，不能直接执行：

```json
{
  "version": 1,
  "tenant_id": 123,
  "include_legacy_null": false,
  "reviewed_by": "审核人",
  "reason": "已逐款确认礼盒、气泡袋、香薰片属于耗材",
  "products": [{
    "product_id": 456,
    "set_is_consumable": 1,
    "expected": {
      "tenant_id": 123,
      "code": "REVIEWED_OLD_CODE",
      "inventory_number": "60-1",
      "inventory_category": "礼盒",
      "product_type": "main",
      "is_accessory": 0,
      "is_consumable": 0,
      "active": 1,
      "updated_at": "2026-11-05 00:00:00.000000"
    }
  }]
}
```

`expected.updated_at` 使用数据库 UTC 原值，提取格式为 `DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f')`，这是迁移前值校验字段；用户界面时间继续统一按北京时间显示。`tenant_id` 必须为实际企业 ID，不能假定默认企业为 1。仅实际默认企业可显式启用 `include_legacy_null`，且相应产品的预期归属必须逐行明确为 `null`。

提供 `--manifest=/private/reviewed.json` 执行只读校验。确认列已存在、前值与租户校验通过，并取得本次 ECS 数据变更批准后，再同时提供 `--apply --backup=/private/backups/consumables-before.json` 执行标记。

备份目录须预先存在、位于源码 checkout 之外且由操作者保护；工具以独占创建和 POSIX `0600` 权限写入完整产品前像、清单及 SHA-256 文件，拒绝覆盖。Windows 还须使用已有私有目录 ACL。备份或任一校验失败均不提交标志更新；失败产生的备份保留供核查。清单不得进入公开资源、Git 或长期记忆。

事务锁定所列企业和产品，逐字段复核预期值，只更新 `is_consumable`，验证其余产品字段完全不变后提交。不会修改 `updated_at`，避免迁移顺带触发其他业务变更。回退时审核一份新的反向清单，将 `set_is_consumable` 设为原值并填写当前前值；不删除列、不恢复旧数据库快照、不改编号计数器。

本地检查：`node --test test/inventory-consumables-migration.test.js`；有独立、禁用 TCP 的 MySQL 测试 socket 时运行同组真实数据库用例。编辑中文文档后必须运行 `npm run check:encoding`。
