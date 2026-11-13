# FBS order postings

## List endpoint

- Endpoint: `POST /v4/posting/fbs/list`.
- The `filter.since` and `filter.to` fields use RFC3339 timestamps.
- Ozon documents a maximum query period of one year for this list operation.
- The ERP uses 31-day request chunks, which stay well within that limit while keeping historical imports bounded.
- The ERP requests up to 100 postings per page and passes the returned `cursor` while `has_next` is true.
- Status-specific reconciliations filter the complete date range locally after reading all pages.
- All FBS list requests share one process-wide queue with at least 1.2 seconds between requests. A rate-limit response pauses further list requests for at least 30 seconds, without fast retries.

Official reference: <https://docs.ozon.ru/api/seller/#operation/PostingFbsList>

## Split packages during FBS shipment

- Endpoint: `POST /v4/posting/fbs/ship`.
- The request accepts a `packages` array. Each package contains its own `products` array with `product_id` and `quantity`.
- A posting can therefore be prepared as multiple packages, including splitting the quantity of one product across packages or placing different products into separate packages.
- The total quantity assigned for every product must exactly match the posting quantity. Empty packages, foreign products, missing quantities, and excess quantities must be rejected before the API call.
- Package splitting must happen while the posting is still eligible for preparation. After shipment, the posting should be refreshed before labels are requested.

Official reference: <https://docs.ozon.ru/api/seller/#operation/PostingAPI_ShipFbsPostingV4>

Verified: 2026-07-25.

## OGL acceptance after preparation

Verified against live FBS detail responses and matching ERP status history: 2026-10-22.

- Affected OGL postings had already progressed from `awaiting_deliver` to `acceptance_in_progress` / `posting_acceptance_in_progress`. Their available actions were tracking and label downloads; the ERP database and the live Ozon response agreed. The previous waiting-for-preparation display was a classification error, not proof that preparation was missing.
- Treat these acceptance states as the waiting-for-delivery category and keep their actual platform status/substatus in storage and detail. Preparation and split preparation must be disabled; label availability remains governed by the platform actions.
- A stale preparation request may reconcile a verified advanced posting, but must not submit `/v4/posting/fbs/ship` again. Reuse the verified detail snapshot and return the same state that was stored. Delivered, transported, cancelled and disputed states take precedence over an older waiting-stage value.
- Platform acceptance, printing, and a locally recorded physical OGL handover are separate evidence. Correcting this category must not create a handover batch, repeat an inventory deduction, recalculate profit, or alter a print record.

## FBP logistics snapshots

Verified against live posting responses and ERP sync history: 2026-10-21.

- The ERP reads both `/v4/posting/fbs/list` and `/v1/posting/fbp/list`. The same FBP posting can occur in both feeds. An observed FBP list response contained `provider_id` but omitted the delivery method, warehouse, tracking number and substatus that were present in the FBS detail response.
- `/v3/posting/fbs/get` returned the actual delivery method and warehouse for the affected active and cancelled FBP postings. A cancelled status does not by itself mean that these logistics fields are unavailable.
- Merge duplicate postings within a shop before saving. A sparse FBP response must preserve previously verified logistics for that same shop/posting, while its current status, products, financial data and cancellation remain authoritative. Explicitly changed provider, method or warehouse identities prohibit inheriting incompatible old logistics.
- Persist the merge under a row lock. All raw-posting writers, including shipping reconciliation, must use the same persistence boundary and use its returned tracking fields. An asynchronous detail response only supplements the row read under that lock; it must not restore business fields from the snapshot captured before the request.
- List sync attempts at most 20 missing-method detail lookups per shop, each bounded to 20 seconds. Scheduled detail reconciliation prioritizes FBP postings with missing methods, including cancelled postings. No carrier, official service class or transport mode is inferred from a provider ID, another order, dimensions or a billing rule.
- `scripts/repair-fbp-order-logistics.mjs` provides a shop/date-scoped dry run and an explicit metadata-only write with a new private backup. It must not call order upsert, inventory posting or profit recalculation.

## Posting SKU and catalog identity

Verified: 2026-11-12 against the official Seller API Swagger schemas.

- `/v4/posting/fbs/list`, `/v3/posting/fbs/get`, and the FBP list/get methods expose the marketplace identity as `products[].sku`.
- In FBS and FBP list financial rows, `financial_data.products[].product_id` means marketplace **SKU**, not the seller catalog product ID. FBP get financial rows instead expose `sku`. Never fill `ozon_product_id` by copying an indexed financial row: its field has a different meaning and row order is not an identity join.
- Keep an explicit product-level catalog ID if supplied, but do not infer a missing posting SKU from that catalog ID or from the seller's `offer_id`. Product catalog normalization remains separate.
- `/v1/posting/fbs/split` and `/v4/posting/fbs/ship` name their request field `product_id`, but both officially define that value as SKU. Build those requests and compare split receipts using the verified live posting's `ozon_sku`, including recovery after an unknown split response. A different catalog ID must not replace it.
- This correction applies to future normalization and request construction. It does not rewrite saved historical orders, mutate historical split receipts, or recalculate profit. Historical receipts containing the wrong identity may require manual verification; mismatches remain blocked rather than auto-resubmitting a split.
- Local validation: 33 unit/contract tests, 13 isolated MySQL split workflow tests, and 44 isolated MySQL shipping/enterprise tests passed. No real shipment or split was submitted. Production rollout requires separate approval.

References: [FBS list](https://docs.ozon.ru/api/seller/#operation/PostingFbsList), [split](https://docs.ozon.ru/api/seller/#operation/FbsSplit), [ship](https://docs.ozon.ru/api/seller/#operation/PostingAPI_ShipFbsPostingV4).
