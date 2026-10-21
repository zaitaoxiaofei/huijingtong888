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

## FBP logistics snapshots

Verified against live posting responses and ERP sync history: 2026-10-21.

- The ERP reads both `/v4/posting/fbs/list` and `/v1/posting/fbp/list`. The same FBP posting can occur in both feeds. An observed FBP list response contained `provider_id` but omitted the delivery method, warehouse, tracking number and substatus that were present in the FBS detail response.
- `/v3/posting/fbs/get` returned the actual delivery method and warehouse for the affected active and cancelled FBP postings. A cancelled status does not by itself mean that these logistics fields are unavailable.
- Merge duplicate postings within a shop before saving. A sparse FBP response must preserve previously verified logistics for that same shop/posting, while its current status, products, financial data and cancellation remain authoritative. Explicitly changed provider, method or warehouse identities prohibit inheriting incompatible old logistics.
- Persist the merge under a row lock. All raw-posting writers, including shipping reconciliation, must use the same persistence boundary and use its returned tracking fields. An asynchronous detail response only supplements the row read under that lock; it must not restore business fields from the snapshot captured before the request.
- List sync attempts at most 20 missing-method detail lookups per shop, each bounded to 20 seconds. Scheduled detail reconciliation prioritizes FBP postings with missing methods, including cancelled postings. No carrier, official service class or transport mode is inferred from a provider ID, another order, dimensions or a billing rule.
- `scripts/repair-fbp-order-logistics.mjs` provides a shop/date-scoped dry run and an explicit metadata-only write with a new private backup. It must not call order upsert, inventory posting or profit recalculation.
