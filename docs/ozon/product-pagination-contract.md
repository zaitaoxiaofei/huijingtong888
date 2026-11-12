# Product, stock and price pagination compatibility

Ozon's [2026-09-24 announcement](https://dev.ozon.ru/news/801-Otkaz-ot-polia-total-v-metodakh-Seller-API/) replaces response `total` with `total_items` on 2026-11-23 for `/v3/product/list`, `/v4/product/info/stocks` and `/v5/product/info/prices`.

Product and stock reads already prefer `total_items` and retain legacy `total`. This local batch adds contract coverage for all three readers and preventive guards to the price-read helper: malformed containers/cursors, repeated cursors and premature completion against the new total fail explicitly. A short page with a continuation cursor still continues. Price reads also forward current-authorization and response-return checks, matching product and stock readers.

Explicit `once` mode remains a single-page read. A nonempty initial cursor remains an explicit partial/resume read; its remaining rows cannot be compared with the entire catalog's total. The helper does not claim whole-catalog completeness in those modes. Price amounts and normalization are unchanged, and no price or stock write is executed.

Scope: no production caller of `fetchOzonProductPrices` was found in the current source. This is preventive compatibility work, not an identified cause of current online-product, inventory or activity issues. Product/stock normalizers and financial APIs are not changed.

Validation: 27 focused contract/stock/product authorization tests pass without skips, with UTF-8 and SQL-binding checks. An additional existing `ozon-product-normalization.test.js` posting-SKU expectation fails on both this branch and exact release `72ad222` (1 pass, 1 fail in that separate file); the unrelated order normalizer was not modified. No claim of a clean full-repository suite is made. This batch remains local and is not part of the financial read-limiter rollout.
