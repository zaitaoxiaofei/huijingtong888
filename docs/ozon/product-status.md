# Ozon Product Status Notes

Confirmed by a live read on 2026-10-24: the `id` returned by `/v3/product/info/list` is a product identity distinct from `sku` and `sources[].sku`. Do not repair an existing product ID by copying a SKU from legacy order/source data. Review the current official response for the specific shop/SKU; retaining a newer row with a different product ID can be correct. The reviewed business disposition and exact old rows belong in a separate cleanup manifest, not an automatic global rewrite.

Confirmed from the live Ozon seller API on 2026-07-14:

- `/v3/product/list` with `filter.visibility = "ARCHIVED"` can return products that must be treated as archived locally.
- `/v3/product/info/list` can return `is_archived: true` and `is_autoarchived: true`; either flag means local `online_products.archived` must be `1` and the status bucket must be `archived`.
- Archived products may still include FBS stock data in `stocks`, for example `present: 888`. Stock presence must not keep an archived product in pending-listing or ready-for-sale buckets.
- Pending-listing sync should still use the strict pending visibility buckets for candidates, but it also needs an archived reconciliation pass so products that moved from pending to archived are written back locally.
- When the same product appears under multiple visibility buckets, `ARCHIVED` must win over `READY_TO_SUPPLY`, `EMPTY_STOCK`, and other sale-state buckets.
- `/v3/product/list` pending-visibility references may contain only `product_id` and visibility. Use `product_id` to reconcile `/v4/product/info/stocks` before the detail request; do not reject a candidate for missing SKU until `/v3/product/info/list` has been read.
- Final pending-listing rows still require a real numeric Ozon SKU. This final SKU check removes incomplete/non-stockable records without dropping valid candidates whose SKU is only present in product details.
