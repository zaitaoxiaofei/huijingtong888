# Batched physical stock writes and product save performance

Initial base: release/2026.10.21-task-brand at 9bf03e73a6e7a72e2b0b9e3a5660a13e8cf98a09. User explicitly requested merge into latest release and ECS deployment after validation.

## Behavior

- Batch stock dialog supports explicit 全部填0 and a uniform nonnegative quantity for all editable rows or checked rows. Count fields remain initially empty; negative stocks retain the existing missing_purchase default reason.
- A single scoped batch context read replaces N full per-product ledger/forecast requests. One POST submits 1–100 physical products in one transaction. Any invalid, stale, foreign, disabled, virtual or unauthorized item blocks the entire batch.
- Context uses fresh canonical order/stock coverage once for all product IDs. Physical stock includes previously posted deductions for pending local orders, and excludes FBP goods. Revision fields include quantity/reservation state, movement evidence, stocktake ID, unresolved cost tasks and normalized SQL product timestamps.
- Sorted product locks precede the repeatable-read snapshot. Authorization is rechecked with locking reads after lock waits. Existing stocktake plans validate reasons, counted quantities and cost-task policy. Quantities use one inventory_current multi-row upsert; movements and audit rows are also inserted in sets. A zero-count batch of 100 products uses four write statements; positive missing-purchase counts may add one bulk cost-task insert.
- Inventory_current incremental semantics, FBP stock, reserved/damaged/in-transit balances and financial costs remain unchanged. Every product has its own audit action and movement. A tenant-scoped batch request key plus complete payload digest provides atomic retries; an uncertain client retry preserves its exact payload. Reusing a key for changed contents is rejected.
- Product edits compare normalized old/new component identity, quantity and role. Unchanged composition is neither rewritten nor synchronized against open order outbound records; actual composition changes retain the existing transactional save and post-commit synchronization.
- PUT product responses use a lean scoped detail read, retaining naming, composition identity, dimensions and profit parameters while omitting stock availability projections and publish operations. The existing profit-recalculation choice remains intact.

## Validation

102 focused tests passed, including real MySQL batch SQL, 100 products, pending-order deduction parity with the single ledger, late write failure rollback, concurrent retries, changed-payload refusal, disabled/foreign/virtual products, permission revocation while awaiting a lock, original bundle and procurement ledger behavior, product identity history and lightweight save responses (six SQL acquisitions).

Ego-browser fixture verified fill-all zero, selected-row fill 5, unchanged default reasons, and a single 20-item POST completing all rows. Screenshots retained in deliverables. No production inventory updates are part of verification or deployment.

The existing tenant-catalog-route-contract assertion about asset-variant-engine/generate also fails on the untouched 9bf03e73 base; it is unrelated to these two new inventory routes. Exact new route gates and trusted session dispatch are separately tested. The unrelated product edit-history HTTP subtest is excluded because its fixed 127.0.0.1:8788 binding is occupied by another protected preview; direct database identity/save tests run normally.
