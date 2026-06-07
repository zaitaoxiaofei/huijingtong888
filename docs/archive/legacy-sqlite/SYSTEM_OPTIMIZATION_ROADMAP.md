# Ozon ERP System Optimization Roadmap

> Historical note: this roadmap includes pre-cutover SQLite analysis. The current runtime baseline is MySQL.

Last updated: 2026-06-01

## 1. Document Goal

This document turns the current system review into an executable optimization plan.

Primary goals:

- Keep the current system stable while improving response speed, maintainability, and future migration readiness.
- Optimize the current `Node.js + SQLite + Vue 3` system first, instead of starting with a risky full rewrite.
- Build a clear path toward a later `MySQL + ORM` migration after module boundaries and query paths are stable.

This document is execution-oriented: each phase includes scope, actions, deliverables, acceptance criteria, and risks.

## 2. Current System Facts

The current active runtime is already:

- Frontend: `Vue 3 + Element Plus`
- Backend: `Node.js`
- Database: `SQLite`

Core runtime entry:

- Frontend shell: `public/admin.html`
- Frontend source: `frontend/admin/*`
- Backend entry: `src/server.js`
- Service layer: `src/services.js` + `src/services/*`
- Data layer: `src/db.js`

Current structural pressure points identified during review:

- `src/services.js` is still a large mixed business file.
- `src/server.js` still contains too much route dispatch and request branching logic.
- `src/db.js` contains both schema creation and a growing set of migrations/repairs/bootstrap logic.
- High-frequency pages such as orders, profit dashboard, and exception workbench still depend on heavy aggregation queries.
- SQLite itself is not yet the first bottleneck; the bigger issue is mixed responsibilities and repeated reporting-style reads.

## 3. Optimization Principles

All optimization work in this roadmap should follow these principles:

1. Stabilize before replacing.
2. Split responsibilities before changing storage technology.
3. Optimize read paths before introducing a more complex infrastructure stack.
4. Keep backend API contracts stable unless a change has clear business value.
5. Treat MySQL migration as a later phase, not the first optimization step.

## 4. Target Architecture Direction

Near-term target:

- Frontend remains `Vue 3 + Element Plus`
- Backend remains `Node.js`
- Database remains `SQLite`
- Reporting/performance-sensitive reads gradually move to snapshot/cache/incremental models

Mid-term target:

- Backend service boundaries become domain-based
- Query paths are measurable and predictable
- Snapshot/materialized business tables cover high-frequency dashboards and ranking pages

Long-term target:

- Migrate stable domain models and query patterns to `MySQL`
- Introduce ORM only after table boundaries and write/read responsibilities are clear

## 5. Phase Plan

## Phase 1: Structural Refactor First

### Goal

Reduce coupling in backend entry, service layer, and data initialization so later performance work is lower risk.

### Scope

- `src/server.js`
- `src/services.js`
- `src/services/*`
- `src/db.js`

### Main Tasks

1. Continue splitting `src/services.js` by domain.
2. Move route handlers out of `src/server.js` into clearer route modules.
3. Separate database concerns inside `src/db.js`.
4. Establish a clearer rule for cross-domain calls.

### Recommended Module Boundaries

Backend route layer:

- `src/server/routes/orders.js`
- `src/server/routes/profit.js`
- `src/server/routes/inventory.js`
- `src/server/routes/procurement.js`
- `src/server/routes/settings.js`
- `src/server/routes/sync.js`

Backend service layer:

- `src/services/orders.js`
- `src/services/analytics.js`
- `src/services/inventory.js`
- `src/services/procurement.js`
- `src/services/configuration.js`
- `src/services/sync.js`
- Later add:
  - `src/services/auth.js`
  - `src/services/dashboard.js`
  - `src/services/finance.js`
  - `src/services/online-products.js`

Database layer:

- `src/db/schema.js`
- `src/db/migrations.js`
- `src/db/indexes.js`
- `src/db/bootstrap.js`
- `src/db/repairs.js`

### Deliverables

- No new business feature is added into the giant mixed files.
- `src/services.js` becomes a compatibility export surface only, or is reduced to a very thin facade.
- `src/server.js` focuses on startup, middleware, auth, dispatch, and error handling.
- DB boot logic is separated from schema and migration logic.

### Acceptance Criteria

- `src/services.js` size reduced substantially.
- No new route is added directly into the main branching block unless necessary.
- Domain changes can be made without reading the whole system file.

### Risks

- Cross-file extraction may introduce circular imports.
- Shared helper placement may be unclear in early refactor rounds.

### Risk Control

- Extract one domain at a time.
- Keep exported function names stable during the split.
- Run API health verification after each extraction batch.

## Phase 2: High-Frequency Read Path Optimization

### Goal

Make the system faster under real operational usage without changing core business behavior.

### Priority Read Paths

1. Orders list and filters
2. Exception workbench
3. Profit summary
4. Profit dashboard
5. Profit ranking
6. Inventory warning pages

### Main Tasks

1. Audit hot queries with `EXPLAIN QUERY PLAN`.
2. Remove unnecessary repeated full aggregations.
3. Ensure pagination paths always query IDs first, then fetch detail rows.
4. Expand short-lived service cache only where correctness is safe.
5. Convert expensive reporting queries to snapshot-first reads.

### Recommended Actions

Orders:

- Keep `paged` query path as the default runtime path.
- Avoid loading large joined payloads before pagination.
- Separate list payload from detail payload more aggressively.

Exceptions:

- Cache task generation results briefly.
- Split generation logic from presentation/filter logic.
- Avoid rebuilding the full workbench for every filter change.

Profit:

- Continue moving summary/ranking/dashboard reads toward snapshot tables:
  - `analytics_shop_daily`
  - `analytics_product_profit_daily`
  - `analytics_sku_profit_daily`
- Use live recalculation only when snapshot data is missing or explicitly refreshed.

Inventory:

- Precompute warning facts where possible.
- Avoid recomputing local/FBS/FBP warning status from raw joins on every page open.

### Deliverables

- Query audit notes for hot pages
- A list of confirmed hot SQL statements
- Snapshot-first implementations for high-frequency dashboard/report endpoints
- Smaller API payloads for list endpoints

### Acceptance Criteria

- Orders page response time is noticeably reduced under larger data volumes.
- Profit dashboard and ranking pages no longer rely mainly on live multi-join scans.
- Exception center filters do not trigger heavy data rebuilds on every switch.

### Risks

- Cache may show temporarily stale values.
- Snapshot refresh design may drift from business expectations.

### Risk Control

- Use explicit refresh flags on reporting endpoints.
- Keep cache TTL short for operational pages.
- Record refresh timestamps in payloads where useful.

## Phase 3: Sync and Incremental Data Strategy

### Goal

Reduce unnecessary data pulls and background processing pressure.

### Scope

- Ozon order sync
- Online product sync
- Stock sync
- Background refresh jobs

### Main Tasks

1. Audit current incremental order sync range logic.
2. Prevent accidental wide-range syncs.
3. Introduce fast pre-check logic before heavy writes.
4. Make background jobs idempotent and observable.

### Recommended Actions

- Add range validation before sync execution.
- Log sync window, fetched count, inserted count, updated count, and duration.
- If shop/date-range metadata indicates no change, skip heavy merge logic.
- Standardize sync logs into queryable records.

### Deliverables

- Sync audit document for current order pull behavior
- Safer incremental sync guards
- Better sync logging and operational visibility

### Acceptance Criteria

- `拉取新订单` no longer unexpectedly pulls large historical windows.
- Background sync can be observed and debugged from logs.
- Sync-related performance spikes become rarer.

## Phase 4: Frontend Runtime Optimization

### Goal

Keep the current Vue admin shell, but reduce unnecessary reloads and repeated page logic.

### Scope

- `frontend/admin/*`
- `frontend/orders/*`
- shared page controls and API utilities

### Main Tasks

1. Continue replacing whole-page or whole-domain reloads with scoped refresh methods.
2. Keep list page state local and predictable.
3. Reuse shared toolbar/table/pagination/dialog patterns across modules.
4. Reduce over-fetching after row-level mutations.

### Recommended Actions

- After a single-row mutation, patch the row or refetch only that domain list.
- Separate "list fetch", "detail fetch", and "mutation follow-up refresh" responsibilities.
- Keep filter state, page state, and selection state isolated in composables.
- Standardize table page contracts across orders, inventory, procurement, and profit lists.

### Deliverables

- Domain-scoped refresh helpers
- Shared list-page interaction pattern
- Reduced duplicated frontend page logic

### Acceptance Criteria

- Single-row operations do not always force a full module reload.
- List pages behave consistently across modules.
- Frontend performance improves without replacing Vue.

## Phase 5: Data Layer Preparation for MySQL

### Goal

Prepare migration-ready boundaries without migrating too early.

### Important Clarification

Do not migrate directly from the current mixed SQLite model into MySQL.

Do this only after:

- service boundaries are stable
- query shapes are known
- snapshot strategy is in place
- recalculation scope is under control

### Main Tasks

1. Define stable domain aggregates.
2. Separate transactional tables from reporting tables.
3. Mark immutable/frozen facts versus recalculable fields.
4. Standardize runtime database config and validation.
5. Introduce a database adapter so new code no longer depends directly on SQLite APIs.
6. Split schema, migration, bootstrap, and repair responsibilities out of `src/db.js`.
7. Audit and replace SQLite-specific SQL patterns.
8. Draft MySQL schema mapping after Phase 1-4 are materially complete.

### Current execution note

The current preparation stream has already completed the dual-database config contract and started real extraction work:

- `src/config.js` now carries the dual-db config contract while SQLite remains the default runtime.
- `src/database-adapter.js` is in use for session, configuration, and selected orders/inventory write paths.
- `src/database-client.js`, `src/db-bootstrap.js`, and `src/db-repairs.js` have started taking over runtime client, bootstrap, and safe repair responsibilities from `src/db.js`.

The next concrete step in this roadmap phase is schema and migration extraction, not MySQL driver cutover.

### Recommended Domain Categories

Transactional/fact tables:

- `orders`
- `order_items`
- `ozon_orders_raw`
- `ozon_finance_items`
- `inventory_movements`
- `outbound_records`
- `inbound_records`

Reference/master tables:

- `products`
- `shops`
- `people`
- `online_products`
- `sku_mappings`
- `suppliers`
- `logistics_fee_rules`

Reporting/snapshot tables:

- `analytics_shop_daily`
- `analytics_product_profit_daily`
- `analytics_sku_profit_daily`
- future materialized warning or exception facts

### Deliverables

- MySQL migration design draft
- Table ownership map
- Database adapter boundary
- SQL compatibility checklist
- ORM evaluation notes

### Acceptance Criteria

- MySQL migration scope is explicit and phased.
- SQLite remains the stable default runtime while preparation work is in progress.
- The backend has a defined path away from `node:sqlite` lock-in.
- No direct "big bang" rewrite is required.

### Implementation Note

Execution details for this phase are maintained in:

- `docs/archive/legacy-sqlite/MYSQL_PREPARATION_PLAN.md`

## Phase 6: Multi-User Concurrency Hardening

### Goal

Continue reducing multi-user operation risk after the first optimistic-lock pass, while keeping current production workflows stable.

### Current Baseline

The first pass has already protected the main daily edit paths with timestamp-based conflict checks:

- Product edit, SKU mapping edit, procurement request edit, inbound record edit.
- Shop, person, logistics rule, order cancellation rule edits.
- Listing automation category templates and publish-record retry/edit flows.
- AI provider config, AI strategy, AI prompt template, and shop asset variant rule saves.
- Listing automation can open separate workspace tabs by full path.

### Long-Term Backlog

1. Add version checks to delete, disable, archive, and restore actions.
   - Examples: people, shops, procurement requests, inbound records, logistics rules, cancellation rules, prompt templates, products, mappings.
   - Expected behavior: if a row changed after the operator opened it, block the action and ask for refresh.

2. Add conflict summaries to batch and merge actions.
   - Examples: procurement request merge, inbound batch update, product merge, historical profit review batch actions.
   - Expected behavior: validate all target row versions before execution and return a per-row conflict list instead of partially surprising the operator.

3. Add operation idempotency and fresh-state checks to external platform actions.
   - Examples: Ozon promotion add/remove products, seller action toggle/archive, online product archive/restore, advertising setting apply.
   - Expected behavior: refresh or verify remote/local state before execution, reject duplicate clicks, and make retries safe.

4. Extend optimistic locking to lower-frequency configuration pages.
   - Examples: suppliers, stock warehouse rules, packaging fee rules, order quality rules, material assets, asset tail templates.
   - Expected behavior: use the same `updated_at` payload pattern as the protected P0/P1 pages.

5. Improve user-facing conflict recovery.
   - Show who/when changed the record when that data is available.
   - Offer a refresh-and-compare flow for long forms where retyping would be costly.
   - Keep destructive actions explicit and easy to audit.

### Priority

- P1: Delete/disable/archive/restore version checks.
- P2: Batch and merge conflict summaries.
- P2: External Ozon/advertising action idempotency.
- P3: Lower-frequency configuration optimistic locks.
- P3: Rich conflict recovery UI.

### Status

Planned. Do not implement in the current optimization batch unless explicitly scheduled.

## 6. Suggested Execution Order

Recommended working order:

1. Phase 1: Structural refactor
2. Phase 2: Read path optimization
3. Phase 3: Sync and incremental strategy
4. Phase 4: Frontend runtime optimization
5. Phase 5: MySQL preparation and migration design
6. Phase 6: Multi-user concurrency hardening

Reason:

- If the structure remains mixed, performance tuning will be expensive and fragile.
- If live queries are not controlled, moving to MySQL will only move the same complexity to another database.

## 7. Concrete Task Breakdown

## Sprint A: Backend Structure Cleanup

Tasks:

- Extract one route group at a time from `src/server.js`
- Extract one business area at a time from `src/services.js`
- Separate DB bootstrap/schema/index/migration code
- Keep API contracts unchanged during the split

Done when:

- Main files are thinner
- Domain files are clearly owned
- Health check passes

## Sprint B: Orders and Exception Performance

Tasks:

- Profile orders list SQL
- Profile exception workbench SQL/data build path
- Add/adjust indexes only after query inspection
- Reduce repeated joins and large payload assembly

Done when:

- Orders list and exception center are faster and more predictable

## Sprint C: Profit Snapshot Completion

Tasks:

- Finish snapshot-first reads for dashboard, summary, ranking
- Add manual refresh and timestamp visibility
- Define incremental refresh boundaries by date range

Done when:

- Profit pages depend mainly on snapshots, not full live rebuilds

## Sprint D: Sync Guardrails

Tasks:

- Audit incremental order sync behavior
- Add sync range validation
- Add no-change fast path
- Improve sync logs

Done when:

- Order sync is safer and more stable operationally

## Sprint E: Frontend Refresh Strategy

Tasks:

- Reduce unnecessary full reloads after mutations
- Standardize list-view composable patterns
- Reuse shared controls consistently

Done when:

- Frontend interaction is faster without changing the framework

## Sprint F: MySQL Design Preparation

Tasks:

- Freeze domain boundaries
- Separate fact/report/reference ownership
- Draft migration plan and rollback plan

Done when:

- The team can choose the MySQL migration timing based on real load, not guesswork

## 8. Non-Goals for the Current Phase

These should not be the first move:

- Rewriting the frontend from Vue back to plain JS
- Immediate full migration from SQLite to MySQL
- Replacing the current backend with a new framework before domain boundaries are clear
- Rebuilding all modules at the same time

## 9. Engineering Rules During Optimization

During implementation, follow these rules:

1. Every API contract change must update API docs in the same change set.
2. Every performance change should name the targeted endpoint or query path.
3. Every index addition should be justified by a real query.
4. Every cache should define TTL, invalidation rule, and acceptable staleness.
5. Every snapshot table should define:
   - source data
   - refresh trigger
   - refresh range
   - fallback behavior

## 10. Verification Checklist

Use this checklist after each optimization batch:

- `npm start` runs normally
- `npm run build:frontend` passes
- `npm run docs:api:check` passes if API changed
- `npm run check:health` passes in a valid local environment
- Orders list still paginates and filters correctly
- Profit dashboard numbers remain internally consistent
- Exception center still shows expected task counts
- Sync actions still log clear status and counts

## 11. Recommended First Batch

The recommended first implementation batch is:

1. Split `src/server.js` order/profit/sync route groups
2. Continue shrinking `src/services.js`, starting with remaining dashboard/finance/sync logic
3. Separate `src/db.js` into schema/index/bootstrap/migration units
4. Profile and optimize:
   - `/api/orders`
   - `/api/exception-workbench`
   - `/api/profit-summary`
   - `/api/profit-dashboard`
5. Complete snapshot-first profit reads where live heavy scans still remain

This first batch gives the best balance of:

- low rewrite risk
- immediate maintainability gains
- visible speed improvement
- safer future MySQL migration

## 12. Decision Summary

The system should be optimized in this order:

- first split structure
- then optimize query/read paths
- then improve sync and frontend refresh behavior
- only then design the MySQL migration

This is the lowest-risk and highest-return path for the current codebase.
