# FBS order postings

## List endpoint

- Endpoint: `POST /v3/posting/fbs/list`.
- The `filter.since` and `filter.to` fields use RFC3339 timestamps.
- Ozon documents a maximum query period of one year for this list operation.
- The ERP uses 31-day request chunks, which stay well within that limit while keeping historical imports bounded.
- Pagination must continue until Ozon returns `has_next: false`.

Official reference: <https://docs.ozon.ru/api/seller/#operation/PostingAPI_GetFbsPostingListV3>

## Split packages during FBS shipment

- Endpoint: `POST /v4/posting/fbs/ship`.
- The request accepts a `packages` array. Each package contains its own `products` array with `product_id` and `quantity`.
- A posting can therefore be prepared as multiple packages, including splitting the quantity of one product across packages or placing different products into separate packages.
- The total quantity assigned for every product must exactly match the posting quantity. Empty packages, foreign products, missing quantities, and excess quantities must be rejected before the API call.
- Package splitting must happen while the posting is still eligible for preparation. After shipment, the posting should be refreshed before labels are requested.

Official reference: <https://docs.ozon.ru/api/seller/#operation/PostingAPI_ShipFbsPostingV4>

Verified: 2026-07-25.
