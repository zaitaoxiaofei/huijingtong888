# Order profit calculation versions

This change preserves the existing profit business tables as the active read
projection. Order lists, pagination and statistics continue to read their current
tables. Revision history is not joined into those queries.

## Supported formulas

Only `V1` is defined. `src/services/profit-formulas/v1/` freezes the existing
profit, pricing, CEL/OGL, outcome and final aggregation functions. Golden hashes
guard that dependency closure. Future work must create a separate version
directory and an explicit registry entry, with separately approved estimate,
finance allocation and aftersale behavior. `V2`, `V3`, missing/unknown registry
versions and corrupt existing bindings are rejected; there is no latest fallback.

The current finance preparation/allocation SQL still lives in `mysql-cutover.js`.
Its writer must check the pinned version before doing business writes. Only its
explicit V1 branch is currently allowed. New finance behavior cannot be enabled
by adding a display label or changing the shared accounting helpers.

## Storage and ownership

`order_profit_calc_state` has one row per authoritative tenant and order item,
the pinned formula, active estimate/actual revision IDs and a revision counter.
Tenant ownership comes from `order_items -> orders -> shops`: a positive
`shops.tenant_id` is converted to its decimal string, otherwise it is `admin`.
An administrator viewing another tenant does not become the data owner.

`order_profit_calc_revisions` stores append-only business snapshots, separate
formula/rate/cost versions, hashes, layer, parent, source, actor and reason.
Legacy snapshots preserve existing amounts and lock fields verbatim. Their
inputs are marked `legacy_unknown`; current product dimensions are never
invented as historical inputs. An incomplete baseline is not claimed replayable.
Real later business or finance changes may create another V1 revision.

## Writer contract

Call `ensureOrderProfitCalculationState(connection, ...)` inside the same
transaction that writes the existing profit tables. Capture a legacy baseline
before changing the projection. `recordOrderProfitCalculation(connection, ...)`
then stores the result and its state pointer on that same connection. Its optional
`project` callback can perform the business write. No coordinator call commits,
creates tables, opens another connection or uses the global pool. Mixing global
`mysqlExecute` with a transaction callback is not atomic.

Identical current input/output hashes do not create another revision. Hashes
exclude synchronization timestamps and normalize financial record ordering.
Item/variant ordering, financial operation dates, zero/negative amounts and
actual locks remain meaningful. Credentials and customer fields are excluded.
A state row lock and unique revision keys serialize concurrent workers. A manual
`commandId` is retryable; reusing it for different business values fails instead
of making an unaudited projection change. An A -> B -> A business change creates
a new revision, while duplicate retries do not. A failed transaction rolls back
the revision, pointer and business projection together.

State initialization uses a no-op `INSERT ... ON DUPLICATE KEY UPDATE` rather
than `INSERT IGNORE`: the latter can hold shared duplicate-record locks and
deadlock on a later `FOR UPDATE` lock upgrade. The upsert acquires an exclusive
record lock directly without modifying existing state metadata. Other business
lock dependencies can still deadlock. Use
`retryProfitCalculationTransaction(withMysqlTransaction, callback)` at the
outermost transaction boundary only. The provider must roll back the complete
failed transaction before another attempt; retrying just the failed SQL can lose
the earlier projection/revision work. Existing-connection/nested writers leave
retry responsibility to their owner. Only deadlock errors are retried, at most
three times by default; callbacks must not perform external side effects.

Ordinary estimate updates must preserve the existing finance lock/stage checks.
Current business data may still arrive; a V1 baseline does not permanently stop
finance accrual. The original baseline stays immutable. History defaults to the
latest 20 revisions per item and reports truncation explicitly.

## Narrow schema and baseline migration

Do not run general database initialization or maintenance for this feature.
The following commands are explicit operational commands; they are not executed
merely by importing the migration or this module.

```sh
# Read-only audit/one cursor batch; no DDL or profit writes.
node scripts/migrate-order-profit-calculation-versions.mjs

# Before candidate start: create only the two companion tables.
node scripts/migrate-order-profit-calculation-versions.mjs --write --create-schema --schema-only

# After the version-aware writer is active: copy old results in bounded batches.
node scripts/migrate-order-profit-calculation-versions.mjs --write --all --batch-size 250

# Resume from a reported item cursor.
node scripts/migrate-order-profit-calculation-versions.mjs --write --all --batch-size 250 --after-id 12345

# Read-only coverage and monetary/lock totals.
node scripts/migrate-order-profit-calculation-versions.mjs --audit
```

The baseline only reads current projections and writes companion tables; it
never invokes recalculation, finance application, inventory operations or
dashboard refresh. Existing initialized items are skipped. Default audit fails
if global business totals change during the run. If ordinary business sync must
continue, explicitly add `--allow-concurrent-writers`: changed totals are reported
as `projection_unchanged:false` and `concurrent_business_totals_changed:true`.
That mode does not claim historical amounts stayed equal; independently compare
sample locks/amounts and baseline output hashes. DDL is outside transactions
because MySQL DDL implicitly commits.

## Verification and rollback

Run `test/order-profit-calculation-versions.test.js` for deterministic tests.
The opt-in `test/order-profit-calculation-versions.mysql.test.js` uses only
`OZON_PROFIT_VERSION_TEST_MYSQL_URL`, accepts local MySQL hosts and creates a
random `ozon_profit_versions_test_*` database. It never imports application
configuration or uses production credentials. It checks real concurrent row
locking, tenant isolation and rollback across revisions/projection. Without an
explicit local test URL it is skipped, not reported as a MySQL pass.
For a separately authorized Linux integration run, the only supported socket
override is `OZON_PROFIT_VERSION_TEST_MYSQL_SOCKET=/var/run/mysqld/mysqld.sock`.
It uses socket authentication as root solely to create/drop the generated test
database; application configuration and existing databases are not selected.

Only V1 can currently be selected, so no V2 activation/upgrade endpoint exists.
An unsupported pinned version must fail before projection writes. Companion
table/read failures must not be reported as a successful versioned calculation.
Rollback must retain a writer that understands existing pinned versions; it must
not silently rewrite V2 records using V1. Retain revision history when disabling
new version selection. This implementation does not deploy or restart services.

## Release verification

The ECS release hook creates only the companion schema before candidate startup,
including when broad database maintenance is skipped. After the version-aware
release is live, explicitly run the bounded baseline command and the read-only
coverage audit. Do not substitute general database initialization, historical
profit repair or a bulk recalculation for this migration.

Use `--allow-concurrent-writers` only when ordinary order sync must continue;
the returned audit must still disclose any changed business totals. Compare
sample saved values/locks and baseline outputs independently. Existing rows with
live calculation revisions are not relabeled as historical baselines.

New item insertion and its first profit revision share one transaction. If a
revision fails, the item insertion rolls back so the next normal sync can still
execute the original first-outbound path. Completed finance projections,
including a zero profit, are protected from ordinary estimate recalculation.
