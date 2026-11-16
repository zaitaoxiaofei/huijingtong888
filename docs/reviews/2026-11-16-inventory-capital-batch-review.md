# Inventory capital review and batch maintenance

Base: remote release/2026.10.21-task-brand at 53861470683cc11416b05f0add9f112b36d54818.

## Behavior

- Domestic capital sources exclude inactive/deleted products and existing virtual composition parents. Historical movements remain unchanged. Official FBP snapshots and purchase transit batches remain visible under their existing rules.
- Domestic filters: 全部明细、采购成本缺失、库存数量异常、缺少采购记录. FBP binding actions remain available.
- Purchase gaps use the existing tenant-scoped procurement allocation projection for shipped local orders, including physical composition children. A negative balance alone does not prove missing purchases. Missing receipt quantities are separate from missing purchase quantities. Zero-balance goods with procurement gaps stay visible.
- Purchase review shows shipped units, registered purchase/inbound units and approved received units. Totals are quantities, not counts of orders or documents. Returns, transfers and adjustments remain in the original inventory ledger.
- Desktop users select current-page rows for batch physical stocktake or historical purchase backfill. Each row has explicit inputs and a result; successful rows are skipped on retry. Request keys survive uncertain network outcomes. Revision conflicts require reloading/reviewing; enterprise changes stop subsequent submissions.
- Negative stocktake rows preselect the existing missing_purchase reason; counted quantity is never prefilled. Existing validation and cost task creation remain authoritative.
- Historical purchase backfills require actual quantity, money and Beijing purchase date. Server preview precedes explicit confirmation. Existing historical_purchase_bulk actions allocate to eligible missing-source orders; already_accounted prevents another physical stock increase. Stocktake is a separate explicit operation.

## Validation

- 73 focused tests passed: isolated MySQL capital totals, inactive products, zero-balance procurement gaps, virtual parents, tenant boundaries, stocktake/purchase partial retries and conflicts, existing procurement ledger regression.
- UTF-8 encoding and diff checks passed; frontend build passed.
- Ego-browser exercised isolated, simulated two-product batch stocktake and preview/confirm purchase flows. No production business writes. Screenshots saved to task deliverables.
- New code is not deployed. No historical quantity/cost/profit repair is included in deployment scope.

## Approved defaults and rollout follow-up

User explicitly authorized optimization, release merge and ECS deployment on 2026-11-16. Base refreshed to release 7ce80d7 before changes.

- Weighted goods price uses positive-priced actual purchase units, excluding freight and unknown-price quantities. Quantity changes recalculate amount unless manually overridden; editable unit price and amount remain available. Missing price is not guessed.
- Selected missing-source orders are grouped by Beijing ordered_at date (and chunks of at most 500 order items). Each group produces its own dated backfill; no current-day fallback. Missing order dates block with an actionable message.
- Backend order_date mode validates explicit selected order ownership/eligibility and matching date; partial quantity remains limited to that group. Legacy callers retain full-group validation. No stock reconciliation or physical increase is allowed in this mode.
- Before each dated write, current revision and preview are refreshed and compared to reviewed allocations and local balance, allowing sequential dates for one product without stale-version failures. Uncertain retries preserve the exact attempted payload/key.
- 77 focused tests passed on refreshed release base; build, encoding and browser fixture verified quantity 25 × weighted price 17.5 = 437.5, default zero freight, three separate dated groups and confirmation.
