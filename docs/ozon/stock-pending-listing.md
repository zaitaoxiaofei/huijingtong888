# Ozon stock and pending-listing adaptation

Reviewed 2026-11-07. This note separates official API changes from the ERP's product-recall policy. It does not record a production deployment or a live inventory-write acceptance test.

## Official evidence

- [Total-field migration, 2026-09-24](https://dev.ozon.ru/news/801-Otkaz-ot-polia-total-v-metodakh-Seller-API/): `/v3/product/list`, `/v4/product/info/stocks` and `/v5/product/info/prices` replace response `total` with `total_items` on 2026-11-23. Readers should accept the new name while retaining legacy compatibility.
- [FBS/rFBS warehouse API changes, 2025-11-10](https://dev.ozon.ru/news/641-Izmeneniia-v-metodakh-Seller-API-rasshirenie-limita-na-sozdanie-skladov-FBS-rFBS/): `/v2/warehouse/list` requires `limit` and `cursor`. `/v4/product/info/stocks` no longer fills `warehouse_ids`; use the dedicated warehouse-stock methods for warehouse-specific stock, including v2 for sellers with many warehouses.
- [Official stock-update reference](https://docs.ozon.ru/api/seller/#operation/ProductAPI_ProductsStocksV2) and [Seller API FAQ](https://dev.ozon.ru/start/257-Seller-API-FAQ-spravochnik-oshibok-i-sposobov-ikh-resheniia): `/v2/products/stocks` updates stock for a specified warehouse. The FAQ documents up to 100 updates per request and notes that products must be processed; per-item rejection is possible. The FAQ is historical and does not independently prove today's seller-specific rate quota.

The current official notification feed did not establish a replacement for `/v4/product/info/stocks` or `/v2/products/stocks`. This is an evidence limit, not a guarantee that no changes exist. On this review, direct Seller reference pages were not extractable and Swagger retrieval hit a size limit or redirect loop. Do not describe fresh visibility-enum semantics or the entire latest Swagger schema as verified.

## ERP implementation

Affected modules: `src/ozonClient.js`, `src/services/mysql-cutover.js`, `src/services/ozon-stock-update.js`, `src/server/routes/catalog.js`, and `frontend/admin/views/inventory/OnlineProductsView.vue`.

- Pending-listing recall now includes `ALL` alongside the existing pending buckets, followed by explicit current zero-FBS-stock evidence and archive filtering. Missing SKU alone no longer removes a product whose real product/offer identity is available. Details and limits are in [product-status.md](./product-status.md).
- The batch-stock page starts with all statuses so zero-stock products and products without a returned SKU remain findable. The batch-stock gate continues to exclude archived and hidden products. Operators can apply narrower filters explicitly.
- Warehouse loading uses only `/v2/warehouse/list`, `limit=200`, and cursor pagination governed by `has_next`. Reject malformed responses, duplicate warehouse IDs, stalled cursors and incomplete traversal. Preserve the existing inactive/archive warehouse filters. Each request and response checks current enterprise ownership, active-shop state and unchanged credentials; no demo warehouses are supplied for a business shop missing real credentials.
- The UI caches only a complete successful warehouse list for at most one minute. Forced refresh clears the previous selection and cache. Failure remains visible and blocks submission. Older, cross-shop and cross-session responses cannot replace the active result.
- Stock writes validate nonnegative integer quantities and a valid warehouse, then split into batches of at most 100. Match each `updated/errors` receipt to the exact product and warehouse. Missing, duplicate, contradictory or rejected receipts do not count as accepted. A later ordinary request failure preserves earlier batch receipts for review.
- `accepted` means Ozon explicitly accepted that row's update. It does not prove the requested stock is already visible or sellable. Preserve product failures and instruct operators to refresh/synchronize before deciding whether to retry. Do not manufacture success from HTTP 200 or submitted-row counts.
- Cancellation, shop disablement, ownership changes and credential changes stop subsequent requests. Inventory operations keep their existing enterprise and shop boundaries; this adaptation does not grant new access.

## Verification

Use focused client, zero-stock, receipt, warehouse, online-product and enterprise-isolation regression tests with mocked provider responses; isolated MySQL checks exercise the actual service boundaries. Run `npm run check:encoding` and the frontend build after UI or Chinese-copy changes. Any browser/service verification uses local `8788`.

No live stock writes are required for these regressions. A real-shop acceptance must separately distinguish an accepted write from stock read-back, processing/moderation eligibility and warehouse availability. ECS deployment or production restart requires fresh approval after the final repair and local results are reviewable.

### Existing normalization-test discrepancy

On the task baseline `8096f9f`, `test/ozon-product-normalization.test.js` test `normalizeOzonPosting does not fallback item ozon_sku to offer_id` already fails: it expects an empty `ozon_sku`, but the unchanged posting normalizer returns `"4779399576"` from the fixture's `product_id`. Importing the original `git show HEAD:src/ozonClient.js` in isolation reproduced the same result. The product-normalization test in that file passes. This stock adaptation leaves both the order normalizer and its existing test unchanged; it does not change order SKU identity semantics to make an unrelated baseline assertion pass.
