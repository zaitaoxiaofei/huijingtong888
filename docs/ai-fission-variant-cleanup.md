# AI 裂变历史变体定向清理

`scripts/repair-ai-fission-variant-contamination.mjs` 只处理已逐条确认的子草稿和私有子模板，不修改共享母模板。它不加载应用 `.env`，必须显式指定数据库、本机 MySQL 管理员 socket 和清单绝对路径；默认仅审计。

清单示例（以下均为示例 ID，实际值需从只读核对取得）：

```json
{
  "version": 1,
  "tenant_id": "admin",
  "source_draft_id": 100,
  "source_template_id": 1000,
  "remove_offer_ids": ["CONFIRMED-LEGACY-SKU"],
  "drafts": [
    { "id": 101, "template_id": 1001, "retained_offer_id": "CURRENT-TARGET-SKU" }
  ]
}
```

先审计：

```bash
node scripts/repair-ai-fission-variant-contamination.mjs --database=reviewed_database --mysql-admin-socket=/var/run/mysqld/mysqld.sock --manifest=/secure/input-manifest.json --output=/secure/audit.json
```

审阅输出中的删除数量和目标身份后，将 `audit.json` 中的 `reviewed_manifest` 对象单独保存为 `/secure/reviewed-manifest.json`。它含源草稿及各子草稿／子模板原行摘要；应用前任何行发生变化都会拒绝，需重新审计和审阅。

在获得本次修复授权、确认备份目录为已有私有目录（`0700`）后应用：

```bash
node scripts/repair-ai-fission-variant-contamination.mjs --database=reviewed_database --mysql-admin-socket=/var/run/mysqld/mysqld.sock --manifest=/secure/reviewed-manifest.json --apply --backup-dir=/secure/fission-backups
```

工具在同一事务内锁定源草稿、子草稿和子模板，再次核对企业、父草稿、模板身份及其草稿引用独占性。冻结存储、未知 SKU、删除集合与当前母草稿 SKU 重叠均会拒绝。只有明确列入清单的旧 `offer_id` 会从草稿快照、人工事实及子模板的当前变体数组中移除，保留目标 SKU 全部字段及其他 JSON 内容。

首次写入前，将完整原行写入新建且同步落盘的 `0600` 备份文件。备份失败不写数据库；SQL 失败回滚整个事务，保留备份。备份不得存于 `public`、`uploads` 或符号链接目录。应用后须再次审计，确认删除数量均为零；已清洁的数据不产生 UPDATE。回滚须根据备份逐条核对当前行后另行执行，不会自动覆盖后续人工编辑。

隔离验证：`TENANT_TEST_MYSQL_SOCKET` 指向禁用 TCP 的测试 MySQL，运行 `node --test test/ai-fission-variant-cleanup.test.js`。测试创建并删除随机测试库，验证事务回滚、原行备份、并发版本拒绝、企业边界和目标字段保持，不使用应用数据库凭据。
