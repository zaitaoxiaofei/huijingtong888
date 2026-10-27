# SKU order tracking schema recovery

Reviewed 2026-10-27. This change is prepared and tested locally; it does not authorize a production migration, deployment or service restart.

## Failure and correction

The application already requires enterprise-owned tracker records. Legacy `sku_order_trackers` tables can still lack `tenant_id`, because `CREATE TABLE IF NOT EXISTS` cannot upgrade an existing table and the release migration plan omitted this migration. This is a schema prerequisite failure, not an employee-role restriction.

Fresh initialization and lazy runtime creation now use the same schema. Runtime checks the unsigned non-null tenant column and complete unique/lookup index definitions. An incompatible legacy schema remains blocked with `TENANT_SKU_TRACKER_MIGRATION_REQUIRED` and HTTP 503; no global-data fallback or runtime ALTER is introduced. Concurrent cold requests share the check, and a failed check can retry after reviewed maintenance.

## Reviewed migration boundary

`scripts/migrate-tenant-sku-order-trackers.mjs` requires both an explicit database and administrator socket. It never loads application credentials. Its default mode starts a read-only transaction, reports schema readiness and audits shop references, enterprise ownership, duplicate natural keys and index definitions.

After approval, apply only fills missing tracker ownership from the existing shop. A legacy shop with NULL ownership belongs to the active default enterprise under the existing compatibility rule. Existing different tracker ownership is a conflict and is never overwritten. The migration preserves every original row and field, including IDs, assignees, thresholds, notification time, creator and both timestamps; it does not rebuild or recalculate orders. The new unique key is installed before the old one is dropped. Repeated apply is a no-op when already ready.

Unknown shops, missing enterprises, conflicting ownership, duplicate records or incompatible same-named indexes stop before automatic repair. There is no automatic deletion, account enrollment, grant change or guessed assignee.

## Execution after explicit production approval

First preserve a durable original snapshot of the small affected tracker table and inspect the default-enterprise/shop attribution. Only this table needs ownership repair; an order-history rebuild or an indiscriminate full-database restore is outside this change. Coordinate tracker writes and run the read-only command against the reviewed database before apply:

```sh
node scripts/migrate-tenant-sku-order-trackers.mjs --database=REVIEWED_DATABASE --mysql-admin-socket=/var/run/mysqld/mysqld.sock
node scripts/migrate-tenant-sku-order-trackers.mjs --apply --database=REVIEWED_DATABASE --mysql-admin-socket=/var/run/mysqld/mysqld.sock
```

These are instructions, not evidence that either command was executed in production. The release planner detects pending tracker work without changing the database. A normal deployment refuses to switch while ownership maintenance is pending. The existing explicitly enabled broad-maintenance path can apply it only when pending, using its existing backup policy. To avoid invoking unrelated broad maintenance or a full-database backup for this isolated repair, an approved targeted table snapshot and explicit migration may be performed first; the subsequent normal deployment then finds the tracker schema ready.

Afterward verify the original row count and field snapshots, tenant-scoped reads for default/A/B, same-SKU independence, and refusal of foreign-shop or foreign-member assignment. A green application health endpoint alone does not prove this business prerequisite was restored.

## Local validation

`test/tenant-sku-order-trackers.mysql.test.js` uses a random database on a named-pipe-only, TCP-disabled MySQL fixture. It covers dry-run, original-field preservation, idempotency, default NULL and explicit ownership, A/B reads/writes, partial migration recovery and refusal to rewrite conflicts. `test/sku-order-tracking-schema.test.js` covers actual index shape and 100 concurrent cold checks. Release-plan and system-event tests protect deployment and notification scope.
