# Promotion cleanup

Reviewed 2026-10-27. See the official [migration guide](https://dev.ozon.ru/start/563-Obnovlenie-metodov-raboty-s-aktsiiami-v-Seller-API-v2/) and [shared-price announcement](https://dev.ozon.ru/news/840-Seller-API-napominanie-o-edinoi-predelnoi-tsene/). Detailed schema provenance is recorded in [promotions-contracts-reference.json](./promotions-contracts-reference.json).

## Execution and enterprise boundary

- A background cleanup restores its saved enterprise and operator, and rechecks active membership and operations permission before external requests. Missing legacy identity remains blocked; never infer an owner or automatically assign one.
- The explicit all-shop business endpoint saves the authorized caller for enabled shops in their current enterprise, then runs in the background. Disabled shops and other enterprises are not changed. The scheduler itself cannot grant identities.
- Configuration reads never enable new shops. Status distinguishes missing authorization, disabled scheduling, pending/running work and actual errors. Partial HTTP 200 responses are not successful cleanups.
- Runtime result patches preserve newer switches and saved identities. Turning a shop off stops subsequent removal batches; finishing an older scan cannot switch it on again.

## Two separate enrollment lists

- Existing participation uses cursor-paged products. Legacy methods remain usable for shops where supported. An explicit unified-price refusal switches that scan to `/v2/actions/products`, whose `products`, `total` and `last_id` are root fields. Only explicit `add_mode=AUTO` is eligible; `SELLER` and unknown values are protected.
- Future enrollment uses each exact future `auto_add_dates` value returned by `/v1/actions`, with `/v2/actions/auto-add/products/list` offset pagination. Read all pages before deletion. Its boolean `add_mode=false` denotes automatic enrollment; the official guide also describes `is_manually_added`. Missing or contradictory flags are never eligible.
- Future removal uses `/v2/actions/auto-add/products/delete` with the exact action, date and product IDs, then rereads the same list. Removing a future reservation is not proof that an existing participation was removed.
- Invalid schemas, incomplete pages, repeated cursors or duplicate product identities fail closed. Manual rows must not be treated as automatic after a pagination conflict.

## Current automatic exit price policy

The user's 2026-10-27 request authorized repairing automatic exits for all enabled shops. Under Ozon's new model, Boosting and stock-discount exits require updating the shared promotion limit, not blindly replacing v1 deactivate with v2. The policy is:

1. Never change the retail `price` field or guess a missing currency. Require valid, matching Money values with supported two-decimal precision.
2. Read all current and known activity participation before a shared-limit write, then refresh that evidence immediately before writing. If the product is manual or unknown in any activity, preserve it and report the blocked exit. Incomplete evidence also blocks the write.
3. For an eligible automatic-only product, use the smallest supported price strictly above that activity's `max_action_price` (one hundredth of its currency), without lowering its existing `action_price`, `min_seller_price`, or any previously attempted shared limit in this sweep. Even an unknown write response retains that floor for later activities.
4. Use `/v1/actions/products/update` with `product_id` and Money. Voucher-only forced removal uses `/v2/actions/products/deactivate`. Unknown activity types require review.
5. Require a deactivation receipt and a full reread. An HTTP 200, active-product receipt, or submitted count is not an exit count. Manual conflicts and unverified exits remain visible failures; do not report them as fully cleared.

## Validation

`test/ozon-action-cleanup-execution.test.js` exercises the real service using an isolated MySQL instance with TCP disabled and mocked Ozon responses. It covers enterprise A/B boundaries, authorization recovery, revocation, queued execution, concurrent disabling, v2 schema/pagination, scheduled enrollment, shared-price safety and read-back verification. Frontend handler/state checks are in `test/ozon-actions-cleanup-view.test.js`.

## Follow-up awaiting deployment approval

The first repair was deployed as `84b00c8`. Production verification then confirmed a v2 discrepancy: one activity reported 1007 products while cursor traversal enumerated 990 distinct products, followed by repeated empty responses at the unchanged final cursor. Initial cleanup refused that mismatch. This later follow-up remains local until the user approves another ECS rollout:

- Accept this specific cursor termination only after a nonempty traversal and an additional read of the exact terminal request returns the same empty page, unchanged cursor and unchanged reported total. Preserve `reportedTotal`, actual scanned count and `paginationWarning`. Initial empty pages, missing cursors, changing terminal evidence, duplicate products and invalid schemas still fail closed.
- For a batch mixing automatic-only and manually protected products, remove only the safe subset. Keep the protected subset, record `blockedCount` and report the remaining items as a partial result. One protected product must not prevent safe products in the same batch from being processed.
- Do not deploy, restart production, or change production configuration for this follow-up without fresh explicit user approval.

## Explicit manual removal

Manual removal is a separate operator intent from automatic cleanup: an operator may explicitly select seller-added products. Resolve the current shop, activity and joined product IDs from Ozon before writing; client-supplied prices, currency, activity type and unrelated IDs are not authority. Report missing IDs separately without submitting them.

When legacy reads are accepted but a legacy mutation returns the explicit unified-price refusal, refresh products through v2 before selecting the new mutation. Voucher promotions use v2 deactivate; Boosting/stock promotions use the verified Money exit limit and require `confirmSharedPrice=true` after the UI explains the possible effect on the same product's other official promotions. Do not change retail price. Automatic cleanup's cross-promotion manual protection still applies only to unattended cleanup; it must not silently defeat an explicit confirmed manual request.

Return per-product confirmed and failed IDs. Only count products with an unambiguous deactivation receipt that are absent from a subsequent complete joined-list read. Active-only receipts, rejected products, unverifiable responses and failed read-back stay failed or pending; an HTTP 200 is not proof that all selected products exited. Seller-created promotion removal retains its existing separate API workflow.
