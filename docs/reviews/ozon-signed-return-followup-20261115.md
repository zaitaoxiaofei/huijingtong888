# Ozon signed-order aftersale follow-up

Scope confirmed by operator: January 1 through December 31, 2026, Beijing calendar, existing orders as of November 15. No production deployment or financial writes have been performed by this change.

## Live read-only evidence

All 26,722 signed orders belong to six shops. Both official return endpoints were fully paginated for every shop: 1,716 records overall, 357 records matching 346 signed orders. There were no additional signed status variants outside the selected `delivered` orders.

Distinct order classification: 187 refunded, 81 officially disposed, 9 disposal in progress, 65 partial compensation, 1 returned to warehouse, 1 clarification pending, 1 answered-only and 1 cancelled-only application. The last two do not establish a return. A refund is not proof of physical receipt. A disposal-only shipping method is not a disposal completion event.

Read-only official posting finance returned 346 postings / 1,634 accrual rows after retrying rate-limited requests. This endpoint lacks ledger accrual IDs and can omit parent/unlinked charges; its rows must not be manufactured into ledger identities. Of the 187 refunded orders, 185 have zero signed seller-price total in the returned commission entries; two retain a positive total, illustrating why the whole order must not be zeroed solely from a return status.

Existing ERP item snapshots: 376 items, 168 pending, 122 accrued, 86 reviewed provisional. These are item counts, not order counts. Signing permits calculation but does not prove complete official settlement. The previous held-order policy and frozen formulas remain in force.

Evidence and an operator preview are under the conversation deliverables directory `aftersale-lifecycle-audit-20261115`; no buyer contacts or customer photos are exported.

## Repair behavior

- Persist tenant/shop/source/return-ID keyed observations and append state-change history transactionally. Complete both API lists before writing a shop. A failed read never clears previous evidence. Conflicting return-to-posting identity stops the write.
- Original posting status remains intact. The order list and detail receive separate official aftersale state; the list displays refunded, disposal, partial compensation or possible-return labels, with source IDs and loss-review guidance. Two additional filters expose aftersales and possible returns.
- An hourly, tenant-scoped scheduled job follows official return lists independently of original order dates, so a later refund of an old signed order is still discovered. Every HTTP attempt rechecks shop/tenant authorization; commits recheck ownership and active subscription.
- Aftersale reporting includes these separately observed records without treating partial compensation or unconfirmed requests as full returns. Dates retain the existing order-cohort meaning and are explicitly labeled; request creation is never called refund completion.
- Previously booked positive profit is not evidence that a new refund was booked. The report requires matching retained calculation-revision return evidence before presenting confirmed refund loss. Missing loss basis or multi-unit return quantity stays unknown, with an explicit operator message. Archived input JSON is not returned in report payloads.
- No posting status, stock movement, historical estimate, pinned formula, profit revision or financial amount is written by return ingestion. Financial refunds remain signed official cash flows; retained costs, fees and fee reversals remain part of actual profit. A new return is flagged for financial reconciliation rather than inventing a zero profit.

## Validation and rollout

Focused validation includes pure API/state/report checks, isolated MySQL idempotence and ownership tests, real application aftersale report SQL, existing tenant order/list/status regressions, UTF-8 checks and frontend compilation. The isolated test seeds an existing positive actual and verifies every saved profit field stays unchanged while the unreviewed refund is not reported as zero loss.

The release baseline has unrelated stale tests: two old order-accounting expectations conflict with already published reviewed cancellation semantics, and an existing tenant-finance test VM lacks `legacySettlementPolicyMysql`. They are not silently counted as passes; the affected order/list/ownership coverage runs separately with that unrelated finance subtest excluded.

Explicit approval is required before the ECS rollout, production additive schema migration or scheduler activation, per AGENTS.md section 5. Apply the two-table schema with `scripts/migrate-ozon-returns.mjs` using the explicit administrator socket/database, then deploy the exact merged release artifact. Do not activate the new reader before schema exists.

The initial targeted backfill uses `scripts/reconcile-ozon-returns.mjs --tenant-id=1 --input=.../full-year-read.json` in read-only mode first; `--apply` additionally requires the exact reviewed manifest SHA256. It re-fetches live official states and restricts initial writes to the 346 reviewed 2026 orders. Confirm the 344 active aftersale orders and two non-return applications, source histories, UI fields, filter counts, unchanged profit amounts, and successful hourly job execution. The scheduled job subsequently follows official evidence for other existing/future orders as well.

Roll back the application to the previous artifact if necessary; the additive evidence tables and history can remain for audit. Do not delete accounting revisions or rewrite original posting status to reverse this change.
