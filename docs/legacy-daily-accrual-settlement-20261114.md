# Legacy order settlement with daily accrual bills

Task base: remote `release/2026.10.21-task-brand` at `a2b81e45a42e8d3e3204930bdb46d94979f84317`. Worktree branch: `codex/legacy-daily-accrual-settlement`. User requested a verified repair and backfill preview, explicitly without deployment.

## Compatibility policy

Legacy V1 estimation and published arithmetic remain unchanged. V5 is separately registered and reuses V1 estimation, outcome classification and aggregation. It adds a reviewed daily-accrual reader for normal signed orders. Cancellation/return/active outcomes remain explicitly pending instead of silently changing their loss policy.

Daily original amounts use the operation-day FX archive already recorded by the importer. The reader verifies that archive against the FX table and reconciles original and stored CNY amounts. It verifies complete independent accrual IDs, sums signed income exactly once, and preserves distinct monetary events. Missing currency, FX evidence, local purchase cost, final fees, unreviewed positive credits or incompatible formula states block settlement.

Parent expenses are allocated using the old order items' normalized CNY sale weights, never today's inventory prices. Parent categories reconcile in CNY cents across sibling postings, with a deterministic remainder on the last posting. An earlier legacy parent acquiring expense may supplement later daily child bills only when the currency and recorded conversion are verified, its gross income is zero, its category is acquiring, and the source dates do not overlap. Missing old currency stays unknown.

## Transaction and entry points

`settleLegacyDailyAccrualOrderMysql` authorizes the current tenant's finance task. It locks the order, items and applicable finance/FX/sibling evidence, recomputes on the transaction connection and checks an optional preview token. A V1 -> V5 state transition, actual projection and calculation revision commit in one retriable transaction. The previous estimate pointer, amounts, tariff and prior actual records are preserved. Already confirmed unrelated historical actuals are protected. Repeated identical settlement creates no extra revision.

The regular finance application dispatches applicable old daily-bill orders to this service. `scripts/backfill-legacy-daily-accruals.mjs` provides an explicit historical sweep: default preview only; writes require the reviewed plan file, matching hash, explicit tenant and `--apply`. Each order rechecks its token; applied orders' detail snapshots refresh afterward. This script has not been applied to production.

## Validation

- 102 focused tests pass: new source/currency/FX checks, legacy parent overlap protection, gross-income identities, complete-cost requirements, cent conservation, and existing V1/V2/V4 finance/estimation/version behavior.
- Isolated MySQL actual write test passes: V5 upgrade, preserved estimate and prior actual baselines, unchanged frozen freight, idempotence, cross-tenant rejection, stale-preview rejection and complete rollback on injected projection failure.
- Existing isolated product/OGL recalculation integration passes.
- UTF-8 encoding, SQL binding and JavaScript syntax checks pass. No published file under `profit-formulas/v1/` changed.

## Production read-only preview

Standalone calculation-only policy hash: `3c87bdd1d4e878fd0eda8054268f854af0c19627740a5fe37cf21be4aed0a224`. A maintenance process used `SET SESSION TRANSACTION READ ONLY` and a SELECT-only query wrapper; no production code or profit projection was changed. Only scoped projected results and missing-data reasons were returned, not a full source-ledger export.

Snapshot started Beijing 2026-11-14 14:08:29 and finished 14:09:04. Selected 11,774 normal signed orders with daily accrual evidence and without confirmed actual projections. Ready: 7,394 orders; projected actual profit CNY 123,214.74, compared with preserved estimated profit CNY 104,594.24 (difference +18,620.50). The increased scan count compared with the earlier investigation uses a fresh source snapshot and the explicit protected-actual selector.

Held: 4,110 old acquiring expenses without original currency; 183 incomplete final bills; 74 positive credits/compensations requiring review; 12 missing purchase costs; 1 order already carrying a different formula version. No currency, collecting fee or cost was invented. The user was asked to confirm the old acquiring fee's original currency separately.

Independent Python Decimal verification reconciled every ready order's income minus all costs, item/order totals and all shop/overall sums. Results:

- `/Users/michael/Documents/ChatGPT/ozon-erp/deliverables/legacy-daily-accrual-settlement/核验摘要.json`
- `/Users/michael/Documents/ChatGPT/ozon-erp/deliverables/legacy-daily-accrual-settlement/补算预览结果.json`

**Release state:** local repair only. Not merged into the remote release branch, not deployed, and no production actual-profit backfill applied.

## Confirmed legacy acquiring currency

After reviewing the original camera-cover bill and four different product examples, the user explicitly confirmed: “之前的那个收单费，就是卢布的币种，你去继续推进吧”. This is retained as scoped user-confirmed evidence, not a global currency default. The manifest identifies 4,091 exact finance-row/shop/operation tuples, including four separately verified zero-amount acquiring records. It does not alter original ledger currency fields or financial amounts.

The reader accepts this evidence only for its matching legacy row; contradictory explicit currency remains an error, and new daily-accrual rows still require their own original currency. Old posted CNY conversions can be either exact four-decimal conversions or the historically recorded two-decimal rounding. Daily conversion/archive checks are unchanged. Applied actual revisions retain the currency source/reference so future refreshes reuse the same evidence without fabricating original fields. The CLI includes this manifest in the hashed plan via `--currency-evidence`; the apply path uses only the verified plan's evidence.

The isolated MySQL test now covers a missing-currency parent acquiring fee, explicit confirmation, preserved historical actual value, atomic V5 settlement and repeat settlement using only the retained revision evidence. Focused regression: 103 tests pass.

Final read-only preview (Beijing 2026-11-14 15:00:38 to 15:01:16), policy hash `fe08462888e61f0d386dc6e981917fcd583e182ecb21d3c2ea2ee6d92cd88281`:

- Scanned: 11,777 orders; ready: 11,467; held: 310.
- Actual-profit preview: CNY 195,657.51; preserved estimated-profit total: CNY 167,730.14; difference: +27,927.37.
- Held: 198 incomplete final bills; 97 credits/compensations needing review; 14 missing purchase costs; 1 existing different formula version. No remaining missing-currency blocker in this selected batch.
- Independent Decimal reconciliation passed for each ready order, item/order totals, shop totals and overall sums.
- Review outputs: `币种确认后补算预览.json` and `币种确认后核验摘要.json` in the same deliverables directory above. Camera-cover order 11963 projects CNY 15.99; rain-wiper-pad order 12964 projects CNY 12.50; trim-kit order 12990 projects CNY 34.91.

Still no deployment, restart, production configuration change or production profit write. The existing user instruction to review first and not deploy remains in force.
