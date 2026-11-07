# SKU daily traffic monitor

The first version adds `/sku-traffic-monitor` under Data Analysis. It uses the existing unified browser-plugin queue and remains compatible with existing working collectors. The integrated 1.5.4 plugin also repairs loading-state navigation and actively verifies the current Seller session when extension Cookie access and passive request headers are unavailable. This browser-only verification never grants server-side Cookie binding. Source requests still depend on an online, authorized Seller session. This is a local validated implementation, not evidence of live Ozon acceptance.

## Two-tier storage

- A controlled single-day run asks only for `total_views`, `search_views`, `pdp_views`, `total_hits_to_cart`, `ordered_units`, `conv_views_to_order`, `conv_total_views_to_cart`, and `conv_hits_to_cart_to_order`.
- Raw pages use `seller_analytics_snapshots` with source `sku-traffic-daily-stage`. Each response is stored once; no duplicate per-SKU raw metric records or ABC requests are saved for these runs. Completed request projections/settings are temporary too.
- Raw daily pages and completed daily run metadata become eligible for bounded cleanup after 24 hours. Pending work is retained until the 15-day window expires; already received raw pages are not extended indefinitely by pending status. A resumed task whose earlier page expired needs recollection, and cannot replace successful daily facts.
- `seller_sku_traffic_daily` stores only enterprise/shop/SKU/report-date keys, eight numeric fields and an update timestamp. Product names, images and offers come from the existing `online_products` entry, not repeated daily. Missing product metadata does not invent a name or an image.
- `seller_sku_traffic_days` stores small coverage/freshness records and fences late task results. Both final tables retain the last 15 complete calendar report dates. Cleanup is bounded and hourly; logical reads exclude older dates immediately.
- The new one-day staging policy applies to daily-monitor runs. Existing seven-/28-day analysis snapshots retain their existing lifecycle because those screens still consume them.

## Collection and correctness

`sku_traffic_daily_dispatch` checks hourly. It queues yesterday and refreshes the two preceding days once per Beijing calendar day, then fills older gaps inside the retained window. At most three days wait per shop. Queue success means dispatch succeeded, not that Ozon data arrived. There is also manual selected-day recollection. While the monitor is open it refreshes once per minute and wakes the existing collector only for pending days; explicit collection also wakes it immediately. This does not require manually enabling extension polling. Closing the page or browser can stop browser-dependent execution; server dispatch remains queued, never falsely complete.

Only completed, single-day, contiguous `all_metrics/by_sku` page chains with a short terminal page can replace a complete day. A machine-verified source offset cap may publish the observed SKU rows as explicit partial coverage; it cannot replace prior complete-day facts and never manufactures missing SKUs as zero. Partial days with received rows are not repeatedly requeued within one calendar day. Missing pages, unsupported response shapes, unexplained pagination truncation, duplicate SKU identities, foreign-store identity, missing source pages or conflicting observed request dates leave prior facts intact. Final replacement and coverage completion are one transaction. Late results cannot overwrite a newer reservation. Empty official arrays can complete an empty day; absent SKUs/fields are not manufactured as zeros.

The existing source adapter caps offsets at 1000. This feature does not guess a different vendor pagination contract. Stores that hit that cap retain received SKU facts as explicitly partial coverage and need an independently verified partition/export strategy before full-store acceptance. All six current active shops exceed 1,000 online SKUs, so full-store acceptance remains outstanding; charts and selected-SKU comparisons do not claim store-wide coverage.

A seven-day total cannot populate seven daily rows. PDP views are not labelled as clicks, and `ordered_units` is not labelled as order count. Conversion metrics retain the existing official percentage-unit convention and are not calculated by averaging percentages. Today is excluded because it is incomplete. Source report-date strings remain dates; collection timestamps display in Beijing time.

## API and migration

- `GET /api/db/seller-analytics/sku-daily`: tenant-scoped pagination (up to 100 SKUs), bounded 15-day series and shop/day coverage.
- `POST /api/db/seller-analytics/sku-daily/collect`: owned shop ID or `all`, with optional complete report date. Client enterprise selectors are ignored; ownership comes from the session.
- The additive migration is registered with the ECS read-only preflight/backup plan and release workflow. It refuses incompatible columns or enterprise-unsafe primary keys. Apply only after the concrete release is approved.

```sh
node scripts/migrate-sku-traffic-daily.mjs --database=<database> --mysql-admin-socket=<local-admin-socket>
node scripts/migrate-sku-traffic-daily.mjs --database=<database> --mysql-admin-socket=<local-admin-socket> --apply
```

## Local validation

Focused service, routing, release and compatibility tests cover strict daily periods, sparse curves, per-shop/per-enterprise ownership, original-page-only staging, complete-page promotion, idempotency, rollback, late-result fences, additive migration refusal and retention boundaries. Socket-only MySQL fixtures exercise the actual queue/result handler into final tables. Browser validation mounts the real Vue component over an isolated synthetic database, including failure, empty, pending, zero and missing-day cases.

A local synthetic 10,000-SKU × 15-day measurement produced 150,000 final records occupying 28.09 MiB including the primary and series indexes. The bounded 30-SKU page with 15 points each read in about 129 ms on the local fixture. This excludes staging, existing product tables, backups, binary logs and production workload; it is not a production capacity or latency guarantee. Reproduce using `test/fixtures/sku-traffic-daily-storage.mjs` and `TENANT_TEST_MYSQL_SOCKET` against a socket-only test server.

The first version contains daily counts/rates and trend inspection. Advertising attribution overlays and automatic potential-SKU scoring are not implemented; small samples must not be treated as proven product potential.
