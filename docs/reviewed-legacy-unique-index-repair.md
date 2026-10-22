# Reviewed legacy unique-index repair

This administrator-only tool repairs only these established natural keys:

| Table | Intended UNIQUE key |
| --- | --- |
| `online_products` | `uk_online_products_shop_sku(shop_id, ozon_sku)` |
| `order_status_history` | `uk_order_status_history_hour_state(order_id, observed_hour, status, logistics_status, tracking_stage, sync_state)` |
| `ozon_category_mappings` | `uq_ozon_category_mapping(description_category_id, type_id)` |

The October 22 backup contains distinct primary rows violating these keys. The current production global `unique_checks` and `foreign_key_checks` are enabled. The historical cause has not been established. Keeping all dump rows by downgrading these three indexes produces a data-exact recovery clone, with `schema_exact=false`; it does not itself repair production.

## Scope and safeguards

`scripts/repair-reviewed-unique-indexes.mjs` defaults to read-only inspection. Both `--database` and `--mysql-admin-socket` are mandatory; application configuration is never imported. Audit starts a READ ONLY transaction, uses a ten-second per-SELECT execution limit, and only inspects explicit primary IDs. Duplicate discovery over the complete history table belongs on the isolated recovery clone, not the live service. Output contains IDs, fingerprints, differing column names and refusal reasons; SQL errors are redacted because MySQL can include private SKU values in duplicate-key messages.

Plans explicitly list each group, keeper, all inspected row hashes, accepted differing columns, reference digest, reviewer and reason. IDs beyond JavaScript's safe integer range must be JSON strings. The suggested keeper is advisory. Online keepers must retain each group's unique effective product/Ozon identity; different nonempty identities are refused, even if there are no current references. Category keepers must remain active and retain positive official category/type IDs. `is_auto` describes category classification and is not an authorization or trust signal.

All ownership checks resolve legacy NULL ownership only to the actual default enterprise. Shops, inventory products and order-item parents must agree. Unknown typed references, FK relationships, triggers, generated/invisible columns, or unexpected key definitions require separate review. Existing malformed parent relationships fail closed; the tool does not silently repair historical business relationships.

The six audited SQL `online_product_id` columns reference local `online_products.id`: actions, outbound records, stock snapshots, barcode-label cache, recipes and SKU mappings. The active inventory application reference `inventory_product_requests.payload_json.online_product_id` is also migrated. Changing an inventory or external Ozon ID with a similar name is forbidden. Barcode-cache collisions require explicit invalidation; full PDF bytes and both affected cache originals remain archived. Other fields and timestamps are preserved. Action/listing/AI JSON snapshots remain historical evidence, including original source IDs; they are not numerically searched and replaced. Review stale active drafts/browser contexts before resuming work.

## Maintenance execution

Stop all application writers, workers, scheduled jobs, event-scheduler writes and administrator SQL writers. `maintenance_confirmed` is an operator acknowledgement, not an automatic server-wide write lock. A database-specific advisory lock prevents two instances of this tool, but cannot stop unrelated writers. The apply connection must have `unique_checks=1`. Keep maintenance active until independent validation and a fresh successful dump/restore finish.

1. Audit the explicit seed plan and copy the returned `expected_hashes`, `differing_columns` (as `accepted_differing_columns`) and `expected_reference_digest` into the reviewed plan. Specify a fresh twelve-character lowercase hex `repair_id`, `reviewed_by`, `reason`, `maintenance_confirmed:true` and `rollback_restores_nonunique_schema:true`. Online repair also needs `invalidate_barcode_cache:true` and `preserve_historical_json:true`.
2. Review every identity, parent/tenant and schema conflict. Any refused group blocks automatic apply. Omitting a real duplicate group does not bypass this: the shadow's real UNIQUE key rejects the copy.
3. Run audit, then apply using the same explicit database/socket and reviewed plan:

   ```text
   node scripts/repair-reviewed-unique-indexes.mjs --database=EXPLICIT_DB --mysql-admin-socket=EXPLICIT_SOCKET --plan=/absolute/reviewed-plan.json
   node scripts/repair-reviewed-unique-indexes.mjs --database=EXPLICIT_DB --mysql-admin-socket=EXPLICIT_SOCKET --plan=/absolute/reviewed-plan.json --apply
   ```

Apply builds fresh strict shadow tables from PRIMARY-index reads, excluding only reviewed nonkeepers. There is no IGNORE, REPLACE, truncation, field merging, or DELETE against an original duplicate business table. Full retained-row hashes/counts and original AUTO_INCREMENT are preserved. Every original row remains in the complete old table. A separate reference transaction locks rows and archives native complete before/after rows, then remaps only the seven audited paths. Any DML error rolls that transaction back, including cache invalidation and archive inserts.

The original broken UNIQUE is downgraded to a same-column NONUNIQUE index using in-place DDL, and the table is rehashed. This is essential: leaving a broken UNIQUE on an archive would make the next dump unrestorable. Atomic multi-table RENAME installs all fresh shadows together and retains complete originals in `_uir_<repair_id>_old_<table>`. `_reviewed_unique_index_repairs` stores the reviewed plan, original schema text, counts/hashes, artifact identities and durable phases. Before/after reference tables preserve full native data, including BLOBs.

MySQL DDL commits implicitly. Reference changes, index downgrade and table swap cannot be one SQL transaction. The journal records `preparing`, `references_applied`, `swap_pending`, `applied` and rollback phases. A failed command must leave maintenance active. Inspect the journal rather than rerunning the same repair ID:

```text
node scripts/repair-reviewed-unique-indexes.mjs --database=EXPLICIT_DB --mysql-admin-socket=EXPLICIT_SOCKET --journal=REPAIR_ID
node scripts/repair-reviewed-unique-indexes.mjs --database=EXPLICIT_DB --mysql-admin-socket=EXPLICIT_SOCKET --rollback=REPAIR_ID --maintenance-confirmed
```

Undo checks all canonical rows, original archives and complete affected reference sets against stored hashes before writing. Later changes or new affected references refuse automatic undo. It can recover after reference commit, after forward RENAME before phase persistence, and after reverse RENAME before reference restoration. Repaired tables are retained as `_uir_<repair_id>_undo_<table>`. Original data and reference bytes are restored, with the known natural keys NONUNIQUE. **Undo is data restoration with `schema_exact=false`; it cannot make the original contradictory data satisfy a valid UNIQUE or authorize restarting normal business writers.** Retain all archives/journal until reviewed backups and business verification are complete.

## Isolated verification

`test/reviewed-unique-index-repair-mysql.test.js` creates/drops only random fixture databases on the explicitly provided `TENANT_TEST_MYSQL_SOCKET`, requires TCP networking disabled, and never imports production credentials. It exercises three-table apply/undo, complete PDF/JSON restoration, strict copy failure, atomic reference rollback, identity/tenant guards, later-write refusal, read-only audit, and interrupted forward/reverse phases. No business database or production service is modified by these tests.
