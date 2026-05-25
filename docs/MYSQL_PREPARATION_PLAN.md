# MySQL Preparation Plan

Last updated: 2026-05-17

## 1. Goal

This document defines the concrete preparation work required before the project can safely migrate from the current SQLite runtime to MySQL.

This is not a direct migration runbook.

The current codebase is still tightly coupled to:

- `node:sqlite`
- SQLite-specific SQL syntax
- file-based backup and restore workflow
- mixed runtime/bootstrap/migration logic inside `src/db.js`

The immediate goal is to make the backend database-agnostic enough that a later MySQL rollout becomes low-risk and trackable.

## 2. Current State Summary

Based on the current code:

- Runtime database client is created directly in [src/db.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js).
- Runtime config only exposes `DATABASE_PATH` in [src/config.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/config.js).
- Schema creation, schema upgrade, repair scripts, seed data, and runtime helpers are mixed in one file.
- Business services call SQLite APIs directly through `db.prepare()` / `db.exec()`.
- Existing backup and restore scripts are designed for SQLite database files and WAL files.

Current conclusion:

- MySQL should be treated as a phased engineering program.
- The first deliverable is not "switch to MySQL".
- The first deliverable is "remove SQLite lock-in from runtime structure".

## 3. Scope and Non-Goals

### In scope

- database configuration standardization
- runtime database adapter abstraction
- schema and migration separation
- SQLite/MySQL SQL compatibility audit
- data migration script design
- backup and restore strategy redesign
- verification and rollback plan

### Not in scope for the first implementation batch

- full ORM rewrite
- direct production cutover to MySQL
- replacing all SQL at once
- changing business rules together with database migration

## 4. Execution Principles

1. Keep SQLite as the default stable runtime during preparation.
2. Do not couple structural refactor and business-rule changes in one batch.
3. Replace infrastructure boundaries first, then replace storage engine.
4. Every migration step must have a rollback path.
5. All database-facing changes must be traceable in `docs/DEVELOPMENT_TRACKER.md`.

## 4.1 Naming Conventions

All MySQL preparation work must keep naming predictable across configuration, modules, and runtime APIs.

- Environment variables: upper snake case, for example `DB_CLIENT`, `DB_HOST`, `DB_PORT`, `DB_NAME`.
- Runtime config fields: camelCase, for example `dbClient`, `dbHost`, `dbPort`, `dbName`.
- Exported JavaScript identifiers: camelCase, for example `createSqliteDatabaseConnection`, `runBootstrapSeedData`, `runBackfillOutboundAuditFields`.
- Module filenames: lowercase kebab-style with domain intent, for example `database-client.js`, `database-adapter.js`, `db-bootstrap.js`, `db-repairs.js`.
- Migration milestone ids: uppercase `M` + number, for example `M1`, `M2`, `M3`.

Do not mix snake case, camelCase, and ad-hoc abbreviations in the same layer.

## 5. Target Architecture Direction

Recommended backend data-layer shape:

```text
src/
  db/
    client/
      index.js
      sqlite-client.js
      mysql-client.js
    schema/
      baseline.js
      indexes.js
    migrations/
      *.js
    bootstrap/
      seed.js
      repairs.js
    dialect/
      sql-helpers.js
```

Recommended runtime usage shape:

```text
server/services
  -> db adapter
  -> transaction helper
  -> query helpers
  -> dialect-safe SQL
```

The service layer should no longer know whether the runtime database is SQLite or MySQL.

## 6. Phased Plan

## Phase 0: Inventory and Baseline Audit

### Goal

Make the current SQLite coupling explicit before any refactor starts.

### Tasks

1. Inventory all database entry points.
2. Inventory all tables, indexes, unique constraints, and bootstrap behavior.
3. Inventory all SQLite-only syntax and metadata access.
4. Identify critical transaction paths.
5. Identify current backup/restore and maintenance flows tied to SQLite files.

### Deliverables

- database entry-point inventory
- schema ownership list
- SQLite-specific SQL audit list
- risk list for migration blockers

### Acceptance criteria

- The team can answer where every write path goes.
- The team can identify which SQL statements will break on MySQL.

## Phase 1: Configuration Standardization

### Goal

Introduce dual-database-ready config without changing runtime behavior.

### Tasks

Add the following config fields in [src/config.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/config.js):

- `DB_CLIENT`
- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `DB_POOL_MIN`
- `DB_POOL_MAX`
- keep existing `DATABASE_PATH` for SQLite compatibility

### Deliverables

- unified database config contract
- `.env.example` update
- startup validation for missing required database fields

### Acceptance criteria

- SQLite still starts unchanged.
- MySQL config shape is documented even before MySQL runtime is enabled.

## Phase 2: Database Adapter Extraction

### Goal

Stop direct SQLite API usage from leaking through the business layer.

### Tasks

1. Create a unified db adapter interface.
2. Wrap common operations:
   - `queryOne`
   - `queryAll`
   - `execute`
   - `transaction`
   - optional `insertAndGetId`
3. Move database client creation out of the current monolithic file.
4. Replace direct imports of `db` in high-change service modules first.

### Priority files

- [src/db.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js)
- [src/services.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js)
- [src/services/configuration.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/configuration.js)
- [src/services/orders.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/orders.js)
- [src/server/session.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/session.js)

### Deliverables

- database adapter interface
- SQLite adapter implementation
- transaction helper with stable calling convention

### Acceptance criteria

- New service code no longer depends on `db.prepare()` directly.
- Adapter can be unit-tested without starting the full server.

## Phase 3: Schema, Migration, and Bootstrap Separation

### Goal

Split runtime connection concerns from schema management concerns.

### Tasks

1. Move schema creation into dedicated schema modules.
2. Move upgrade steps into explicit migration units.
3. Move seed data into dedicated bootstrap files.
4. Move repair/backfill logic into repair scripts with explicit invocation points.
5. Keep runtime startup idempotent and minimal.

### Deliverables

- schema baseline module
- migration runner
- seed/bootstrap module
- repair module

### Acceptance criteria

- `src/db.js` is reduced to client/bootstrap composition or replaced by `src/db/client/index.js`.
- Schema upgrades are traceable by ordered migration steps.

### Current implementation status

- `src/database-client.js` now owns SQLite connection creation and startup pragmas.
- `src/db-bootstrap.js` now owns demo-data and bootstrap seed entrypoints.
- `src/db-repairs.js` now owns safe repair helpers for outbound audit backfill, inventory-current rebuild, and recursive product-image cleanup.
- `src/db-schema.js` now exists as the extraction target for schema-related responsibilities; base schema, supplemental schema, and index helpers are now part of the active initialization flow.
- `src/services/analytics-refresh.js` and `src/services/analytics-refresh-entry.js` now have adapter-capable runtime wiring, so analytics snapshot rebuild no longer depends on a hardcoded SQLite execution path.
- `src/services/finance-sync.js` now routes its core write path through adapter-compatible execute helpers while keeping SQLite fallback behavior.
- `src/services/order-sync.js` now routes raw posting persistence, core order/item inserts, outbound record writes, and sync log writes through adapter-compatible helpers or adapter-style insert-id helpers.
- `src/db.js` still owns schema creation, upgrade steps, and one legacy encoded repair routine that should remain local until its seed/update data can be extracted safely without corruption.

### Remaining work

1. Delete the duplicated legacy base-schema SQL still left inside `src/db.js` after `applyBaseSchema(db)` is called.
2. Extract ordered upgrade steps into explicit migration units instead of leaving them inline in `src/db.js`.
3. Continue replacing remaining direct SQLite write paths, with `online product` write flows and direct transaction control as the next high-value targets.
4. Remove duplicated legacy repair helpers that are now routed through `src/db-repairs.js`.
5. Isolate the cancellation-rule corruption repair into a safe migration or data patch module after encoding is normalized.

## 6.1 Regression Gate For Migration Work

Every new migration-facing refactor should add or update executable regression tests before the next batch continues.

Current minimum gate:

- `npm test`
- adapter-backed path tests for extracted service modules

Current covered service paths:

- `src/services/analytics-refresh.js`
- `src/services/finance-sync.js`
- `src/services/order-sync.js`

Next coverage targets:

- `src/services/online-products-entry.js`
- `src/services/catalog-mappings-entry.js`
- transaction-heavy procurement / inbound flows in `src/services.js`

## Phase 4: SQL Dialect Compatibility Refactor

### Goal

Remove known SQLite-only SQL patterns from high-value paths.

### Known compatibility topics to handle

- `PRAGMA`
- `sqlite_master`
- `INSERT OR IGNORE`
- `ON CONFLICT ... DO UPDATE`
- `ON CONFLICT ... DO NOTHING`
- `AUTOINCREMENT`
- boolean representation (`INTEGER 0/1`)
- timestamp defaults and update behavior
- transaction statements and lock assumptions

### Tasks

1. Replace SQLite metadata inspection with adapter-owned schema helpers.
2. Normalize upsert strategy behind helper functions.
3. Normalize ID generation expectations.
4. Normalize timestamp conventions.
5. Decide how JSON payload fields are stored and queried in MySQL.

### Deliverables

- SQL compatibility checklist
- dialect helper implementation
- updated service queries for priority write paths

Current checklist document:

- [docs/SQLITE_TO_MYSQL_COMPATIBILITY_CHECKLIST.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/SQLITE_TO_MYSQL_COMPATIBILITY_CHECKLIST.md)

### Acceptance criteria

- Priority paths use SQL that can be implemented on both SQLite and MySQL.

## Phase 5: MySQL Schema Draft and Data Mapping

### Goal

Draft the target MySQL schema before any production migration.

### Tasks

1. Define MySQL table types, charsets, collations, and engine defaults.
2. Convert current SQLite column intent into explicit MySQL types.
3. Define index strategy for:
   - orders
   - order_items
   - online_products
   - sku_mappings
   - inventory_movements
   - analytics snapshot tables
4. Define reference integrity and delete/update rules.
5. Define data migration mapping from SQLite types to MySQL types.

### Deliverables

- MySQL schema draft
- table-by-table mapping sheet
- index baseline proposal

### Acceptance criteria

- Every current runtime table has a proposed MySQL shape and ownership category.

## Phase 6: Migration Tooling and Dry Run

### Goal

Be able to migrate a local SQLite dataset into MySQL repeatedly and verify correctness.

### Tasks

1. Create export/import tooling or a one-step migration script.
2. Migrate master data first.
3. Migrate transactional data second.
4. Migrate reporting/snapshot data last or rebuild it post-import.
5. Add row-count and checksum-style verification.

### Deliverables

- local migration script
- verification report template
- dry-run checklist

### Acceptance criteria

- A local SQLite snapshot can be imported into MySQL and verified.

## Phase 7: Cutover and Rollback Plan

### Goal

Prepare the production switch only after dry-run quality is acceptable.

### Tasks

1. Define cutover preconditions.
2. Define frozen window and backup policy.
3. Define rollback trigger conditions.
4. Define post-cutover verification checklist.

### Deliverables

- cutover runbook
- rollback runbook

### Acceptance criteria

- The team can explain exactly how to move forward and how to revert.

## 7. Concrete Backlog by Work Item

| Work item | Status | Owner | Notes |
| --- | --- | --- | --- |
| Database config standardization | Next | Backend | Add dual-db config without changing default runtime. |
| DB adapter interface | Next | Backend | Start from SQLite implementation only. |
| Service-layer decoupling from `db.prepare()` | Next | Backend | Prioritize orders/config/session/inventory domains. |
| Split schema/migration/bootstrap/repair logic | Next | Backend | Reduce `src/db.js` responsibilities. |
| SQLite-specific SQL audit | Next | Backend | Produce a query compatibility checklist. |
| MySQL driver selection | Next | Backend | Prefer `mysql2`; ORM decision can remain later. |
| MySQL schema draft | In progress | Backend | Initial draft now lives in `docs/MYSQL_SCHEMA_DRAFT.md`; continue table-by-table refinement and DDL generation. |
| SQLite-to-MySQL migration script | In progress | Backend | SQLite-side export/verification plus MySQL-side init/import/compare scripts now exist; next step is executing them against a reachable MySQL instance. |
| Backup/restore redesign for MySQL | Backlog | Backend/Ops | Current docs and scripts are SQLite-only. |
| MySQL dry run on real snapshot | In progress | Backend | SQLite export side is ready and MySQL import/compare scripts exist; next step is importing into MySQL and comparing counts/aggregates with real connection settings. |

## 8. Recommended Technical Choices

### Database driver

Recommended first choice:

- `mysql2`

Reason:

- low-level enough for phased migration
- does not force premature ORM adoption
- good fit for keeping current SQL-centric service design

### ORM decision

Do not require ORM adoption in the same phase as adapter extraction.

If later evaluated, compare:

- `TypeORM`
- `Knex`
- `Drizzle`

Decision criteria:

- transaction ergonomics
- migration support
- SQL escape hatch quality
- fit with existing service-style architecture

## 9. Risks and Controls

| Risk | Impact | Control |
| --- | --- | --- |
| Mixing refactor and migration in one batch | High | Keep SQLite as default until adapter and schema separation are done. |
| Query behavior drift after SQL rewrites | High | Add focused regression checks on orders, profit, inventory, procurement, and auth flows. |
| Underestimating SQLite-specific syntax usage | High | Maintain a dedicated compatibility checklist and update it continuously. |
| Backup strategy gap during migration | High | Do not retire SQLite backup flow until MySQL backup and restore runbook is validated. |
| Runtime instability from broad DB changes | Medium | Convert one domain at a time and keep API contracts stable. |

## 10. Tracking Rules

When progress is made on this plan:

1. Update the relevant row in [docs/DEVELOPMENT_TRACKER.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/DEVELOPMENT_TRACKER.md).
2. If the execution order changes, update [docs/SYSTEM_OPTIMIZATION_ROADMAP.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/SYSTEM_OPTIMIZATION_ROADMAP.md).
3. If runtime entry or config changes, update [docs/PROJECT_GUIDE.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/PROJECT_GUIDE.md).

## 11. Definition of Ready

The project is ready to start actual MySQL implementation only when all items below are true:

- database config contract is merged
- db adapter exists and is used by new code
- schema/migration/bootstrap concerns are separated
- SQLite-only syntax has an audited replacement strategy
- target MySQL schema draft exists
- at least one local dry run has succeeded on a real dataset

Until then, the correct status is: "MySQL preparation in progress", not "MySQL migration ready".

## 12. Plain-Language Execution Path

This section explains the migration path in plain language.

### 12.1 What has already started

The current work is the preparation layer, not the cutover layer.

What is already happening:

1. Standardize database config so SQLite and MySQL can share one runtime contract.
2. Add a database adapter so business modules stop depending directly on SQLite APIs.
3. Split `src/db.js` so connection, schema, bootstrap, repair, and migration concerns stop being mixed together.

This is the foundation that makes later SQL translation and MySQL rollout controllable.

### 12.2 Your understanding is mostly correct

Your overall understanding is correct:

1. First isolate SQLite-specific code behind a stable boundary.
2. Then inspect existing SQL and convert high-risk SQLite-specific statements.
3. Then prepare the MySQL schema and migration scripts.
4. Then migrate real data and verify results.
5. Then run comparison checks before final cutover.

This is the right direction.

### 12.3 Where the execution order needs adjustment

The main adjustment is this:

Do not start with "two databases both serving writes in production" too early.

Reason:

- dual write is much more dangerous than single write
- if one write succeeds and the other fails, data divergence starts immediately
- repair cost becomes very high if the adapter, schema, and SQL compatibility work are not stable first

So the safer order is:

1. finish structural decoupling
2. finish SQL compatibility cleanup
3. build MySQL schema
4. do offline/local migration dry runs
5. do read-only comparison against MySQL
6. only then evaluate shadow write or dual write on limited scope
7. cut over after repeated verification

### 12.4 The practical execution plan

#### Stage A: make the code no longer hard-bind to SQLite

Goal:

The service layer should stop caring whether the backend database is SQLite or MySQL.

Concrete work:

- keep expanding `database-adapter.js`
- replace direct `db.prepare()` usage in services
- move schema/bootstrap/repair code out of `src/db.js`

Exit condition:

- new business code goes through the adapter
- `src/db.js` becomes orchestration-oriented instead of monolithic

#### Stage B: translate SQLite-specific SQL

Goal:

Identify statements that will break on MySQL and replace them in a controlled way.

Typical examples:

- `PRAGMA`
- `sqlite_master`
- `INSERT OR IGNORE`
- `ON CONFLICT`
- SQLite-specific upsert assumptions
- boolean and timestamp conventions

Concrete work:

- build a compatibility checklist
- replace risky SQL one domain at a time
- keep common query shapes behind helper functions when useful

Exit condition:

- priority write paths are no longer SQLite-only

#### Stage C: build the target MySQL schema

Goal:

Make the target schema explicit before any real migration.

Concrete work:

- define MySQL table types
- define indexes
- define charset/collation
- define foreign-key behavior
- define mapping from SQLite values to MySQL values

Exit condition:

- every current table has a MySQL counterpart definition

#### Stage D: do offline migration and verification

Goal:

Move a SQLite snapshot into MySQL repeatedly in a non-production way.

Concrete work:

- export SQLite data
- import into MySQL
- compare row counts
- compare key business aggregates
- compare representative API results

This stage should be repeated until stable.

Exit condition:

- local dry runs are repeatable
- key business outputs match

#### Stage E: production verification before cutover

Goal:

Verify MySQL with real production-like traffic but avoid premature risk.

Safer order:

1. read-only comparison
2. optional shadow write on a limited scope
3. short controlled cutover window
4. rollback path ready

Read-only comparison means:

- old SQLite remains the source of truth
- the system or verification job queries both sides
- compare counts, totals, and representative rows

Shadow write means:

- SQLite remains authoritative
- MySQL receives mirrored writes for a narrow scope only after the adapter and SQL path are stable
- every mismatch must be logged and reviewed

Exit condition:

- mismatches are understood and cleared
- rollback steps are documented

### 12.5 Why I am currently spending time on "too detailed" work

Because without these lower-level steps, the later high-level migration is not safe.

What looks "too detailed" right now is actually removing hidden coupling:

- runtime config coupling
- direct SQLite API coupling
- schema/bootstrap/repair coupling
- SQLite syntax coupling

If these are not separated first, later SQL translation and dual-db verification will be much harder to trust.

### 12.6 What I will do next

Near-term next actions:

1. make `src/db-schema.js` the single active schema source and remove duplicate base-schema SQL from `src/db.js`
2. split `migrateDb()` into clearer migration units
3. produce the SQLite-to-MySQL compatibility checklist
4. continue replacing remaining direct SQLite service calls with adapter calls
5. after those are stable, start the first MySQL schema draft

### 12.7 One-sentence summary

You are thinking about the right overall path.

What I am doing now is the prerequisite layer that makes the later "SQL translation -> MySQL build -> data migration -> comparison -> cutover" sequence low-risk instead of fragile.
