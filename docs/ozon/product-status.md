# Ozon Product Status Notes

Confirmed by a live read on 2026-10-24: the `id` returned by `/v3/product/info/list` is a product identity distinct from `sku` and `sources[].sku`. Do not repair an existing product ID by copying a SKU from legacy order/source data. Review the current official response for the specific shop/SKU; retaining a newer row with a different product ID can be correct. The reviewed business disposition and exact old rows belong in a separate cleanup manifest, not an automatic global rewrite.

Confirmed from the live Ozon seller API on 2026-07-14:

- `/v3/product/list` with `filter.visibility = "ARCHIVED"` can return products that must be treated as archived locally.
- `/v3/product/info/list` can return `is_archived: true` and `is_autoarchived: true`; either flag means local `online_products.archived` must be `1` and the status bucket must be `archived`.
- Archived products may still include FBS stock data in `stocks`, for example `present: 888`. Stock presence must not keep an archived product in pending-listing or ready-for-sale buckets.
- Pending-listing sync needs an archived reconciliation pass so products that moved from pending to archived are written back locally. The former strict visibility-only candidate policy is superseded by the 2026-11-07 policy below.
- When the same product appears under multiple visibility buckets, `ARCHIVED` must win over `READY_TO_SUPPLY`, `EMPTY_STOCK`, and other sale-state buckets.
- `/v3/product/list` pending-visibility references may contain only `product_id` and visibility. Use `product_id` to reconcile `/v4/product/info/stocks` before the detail request; do not reject a candidate for missing SKU until `/v3/product/info/list` has been read.
- The former final numeric-SKU requirement is superseded by the 2026-11-07 policy below. Product IDs, seller offer IDs and Ozon SKUs remain separate identities.

## Pending-listing policy reviewed 2026-11-07

This is the ERP's recall and filtering policy, not a claim that Ozon changed the meanings of `EMPTY_STOCK` or `READY_TO_SUPPLY`. Fresh official visibility-enum semantics could not be independently retrieved during this review.

- Collect `ALL`, `EMPTY_STOCK` and `READY_TO_SUPPLY` references, deduplicate by product ID, and separately reconcile `ARCHIVED`. `ALL` supplements candidate recall; it does not establish eligibility or stockability.
- Read current `/v4/product/info/stocks` for those product IDs, then fetch details for candidates without positive FBS stock. Exclude archived products and any product with positive FBS `present` or `available` stock in either response.
- Final pending results require explicit zero-stock evidence: matching FBS quantity fields with no positive stock, an explicit empty stock array returned for the matching product, or product detail `stocks.has_stock=false`. An absent product/stock response is unknown and must not be silently converted into a confirmed zero.
- Do not discard a zero-stock product solely because its details lack an Ozon SKU. Preserve its actual product/offer identity through the existing local placeholder mechanism. Never synthesize a real numeric SKU from the product ID. Ozon can still reject stock updates for an unprocessed, unmoderated or otherwise ineligible product; report that rejection per product.
- Product and stock pagination accept `total_items` before legacy `total`; empty terminal pages end traversal only when they do not contradict the reported count. Repeated cursors and incomplete pages fail explicitly.

See [stock-pending-listing.md](./stock-pending-listing.md) for official sources, warehouse pagination and stock-write confirmation boundaries.
