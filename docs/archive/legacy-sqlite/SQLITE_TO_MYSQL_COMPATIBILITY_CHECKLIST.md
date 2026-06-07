# SQLite to MySQL Compatibility Checklist

> Historical note: this checklist is retained as migration history. The current runtime baseline is MySQL; this file should not be read as evidence that SQLite is still active in production.

Last updated: 2026-05-17

## 1. Purpose

This document tracks the SQLite-specific database behavior that must be replaced, abstracted, or verified before MySQL can become a real runtime option.

This is not the migration script itself.

It is the engineering checklist that sits between:

- database adapter extraction
- schema separation
- MySQL schema draft
- SQLite-to-MySQL dry-run migration

## 2. Current Rule

Any SQL path that depends on SQLite-only behavior must be marked in this document before it is considered migration-ready.

## 3. Status Legend

- `Done`: already abstracted, replaced, or no longer blocks MySQL
- `In progress`: work has started but is not yet fully safe
- `Next`: should be handled in the next implementation batches
- `Backlog`: acknowledged but not the immediate critical path

## 4. Compatibility Items

| Topic | Status | Current usage | Required action | Notes |
| --- | --- | --- | --- | --- |
| Runtime client API | In progress | Service code still mixes adapter calls and direct `db.prepare()` usage. | Continue expanding adapter-backed paths and reduce direct SQLite client access. | Analytics snapshot refresh runtime wiring is complete, finance sync writes now prefer adapter execution, core order sync write/insert paths now use adapter-compatible helpers, online product entry/runtime writes now use adapter-style execute helpers, catalog mapping maintenance writes now use runtime adapter execution, and most configuration CRUD writes now use adapter helpers; next high-value target is remaining direct transaction control and older monolithic procurement/inbound write flows. |
| `PRAGMA` | Backlog | SQLite startup pragmas are now isolated in `src/database-client.js`. | Keep fully client-owned and never leak into service SQL. | This should not appear outside SQLite client setup. |
| `sqlite_master` metadata lookup | In progress | `tableExists()` in `src/db.js` still queries `sqlite_master`. | Move metadata checks behind schema/migration helpers. | MySQL will need `information_schema` or adapter-owned checks. |
| `INSERT OR IGNORE` | Next | Still exists in schema/bootstrap flows, especially seed data. | Replace with adapter-owned insert-ignore helpers or dialect-specific migration helpers. | SQLite and MySQL handle this differently. |
| `ON CONFLICT ... DO UPDATE` | In progress | Used in configuration, inventory, analytics cache, sync, finance, review, order mark, label, and stock snapshot upserts. | Inventory each upsert and define MySQL equivalent strategy. | Most likely `INSERT ... ON DUPLICATE KEY UPDATE` on MySQL. |
| `ON CONFLICT ... DO NOTHING` style semantics | Next | Implicit through some insert-ignore patterns and idempotent writes. | Standardize behavior behind helpers. | Must verify unique-key assumptions table by table. |
| Boolean storage | Next | Current schema uses `INTEGER 0/1` for many flags. | Define MySQL boolean mapping and verify read/write coercion. | Service code should not rely on SQLite truthiness quirks. |
| Timestamp defaults | Next | Current schema relies on `CURRENT_TIMESTAMP` widely. | Verify MySQL default timestamp behavior and update rules. | Especially important for `updated_at` expectations. |
| Autoincrement / last inserted id | In progress | Adapter already exposes `insertAndGetId`. | Keep code on adapter path and avoid SQLite-specific `lastInsertRowid` leakage. | Current adapter boundary is the right direction. |
| Transaction control | In progress | Adapter has `runInTransaction`, but some modules still call `db.exec("BEGIN")` directly. | Move remaining transaction paths to adapter helpers. | Historical profit review plus procurement / purchase-order / inbound flows now use adapter-owned transaction control, and `recalculateOrderCancelLossFlags()` has been moved as well; remaining direct transaction control still exists in older service paths. |
| String concatenation / formatting SQL | Backlog | Some SQL still uses SQLite-oriented string formatting functions. | Audit and replace where needed. | Includes generated inventory IDs and some presentation-side SQL expressions. |
| Date extraction / timezone SQL | In progress | China date grouping uses SQLite datetime/substr expressions. | Decide whether to keep dialect-specific helper SQL or move more logic to application code. | Current helper direction: `chinaDateSql(...)`. |
| Aggregation helpers | Backlog | Some list/report SQL depends on SQLite aggregation details like `GROUP_CONCAT`. | Verify MySQL equivalents and output compatibility. | This matters for dashboard and inventory alert presentation queries. |
| Text matching / pattern rules | Backlog | Some rules use `LIKE`, `LOWER(...) LIKE`, and text pattern assumptions. | Verify collation and case-insensitive behavior under MySQL. | Important for cancellation rules and warehouse classification. |
| Placeholder style | Done | Current project uses `?` placeholders consistently. | Keep this convention. | Compatible with both SQLite and MySQL drivers. |

## 5. Immediate Priority Buckets

### Priority A: must stabilize before MySQL draft is meaningful

1. Reduce remaining direct `db.prepare()` usage in write-heavy service modules.
2. Replace direct transaction control with adapter helpers.
3. Separate migration metadata checks from raw `sqlite_master` lookups.
4. Inventory all active upsert patterns.

### Priority B: must finish before dry-run migration

1. Define MySQL equivalents for every current `ON CONFLICT` path.
2. Standardize boolean and timestamp handling.
3. Audit reporting SQL that depends on SQLite date/string functions.
4. Confirm schema default-value behavior table by table.

### Priority C: verify during dry-run and shadow validation

1. Compare row counts after import.
2. Compare key profit, inventory, and order aggregates.
3. Compare representative API outputs.
4. Compare behavior for seed/config/rule tables that rely on idempotent writes.

## 6. First Concrete SQL Translation Targets

These are the best next targets because they are both important and structurally contained:

1. `src/services/analytics-refresh.js`
2. analytics cache upsert paths
3. inventory stock snapshot upsert paths
4. configuration-domain rule upserts
5. sync-domain raw-order and finance upserts

## 7. Current Progress Note

Current preparation status:

- database config standardization is done
- the adapter exists and is already in use for selected modules
- schema splitting is underway
- analytics snapshot refresh now has end-to-end adapter-capable runtime wiring
- finance sync / finance reapply core writes now prefer adapter execution with SQLite fallback
- order sync now routes raw posting persistence, core order/item inserts, outbound record writes, and sync log writes through adapter-compatible helpers
- online product entry/runtime writes now route action logs, bind/update flows, archive flags, and sync logs through adapter-compatible helpers
- historical profit review now uses adapter-owned transaction control for cleanup and manual review write flows
- catalog mapping maintenance writes now route mapping/product-link/order-item updates through runtime adapter execution
- most configuration CRUD writes now route through adapter `execute` / `insertAndGetId`, including shop, supplier, logistics-rule, and cancellation-rule maintenance paths
- procurement / purchase-order / inbound mutation flows in the monolithic service file now wrap their multi-step writes with adapter-owned transaction control

The next milestone is not "turn on MySQL".

The next milestone is "finish compatibility control over the major write paths".
