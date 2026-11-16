# SKU daily traffic monitor

The first version adds `/sku-traffic-monitor` under Data Analysis. It uses the existing unified browser-plugin queue and remains compatible with existing working collectors. The integrated 1.5.4 plugin also repairs loading-state navigation and actively verifies the current Seller session when extension Cookie access and passive request headers are unavailable. This browser-only verification never grants server-side Cookie binding. Source requests still depend on an online, authorized Seller session. This is a local validated implementation, not evidence of live Ozon acceptance.

## Two-tier storage

- A controlled single-day run asks only for `total_views`, `search_views`, `pdp_views`, `total_hits_to_cart`, `ordered_units`, `conv_views_to_order`, `conv_total_views_to_cart`, and `conv_hits_to_cart_to_order`.
- Raw pages use `seller_analytics_snapshots` with source `sku-traffic-daily-stage`. Each response is stored once; no duplicate per-SKU raw metric records or ABC requests are saved for these runs. Completed request projections/settings are temporary too.
- Raw daily pages and completed daily run metadata become eligible for bounded cleanup after 24 hours. Pending work is retained until the 30-day window expires; already received raw pages are not extended indefinitely by pending status. A resumed task whose earlier page expired needs recollection, and cannot replace successful daily facts.
- `seller_sku_traffic_daily` stores only enterprise/shop/SKU/report-date keys, eight numeric fields and an update timestamp. Product names, images and offers come from the existing `online_products` entry, not repeated daily. Missing product metadata does not invent a name or an image.
- `seller_sku_traffic_days` stores small coverage/freshness records and fences late task results. Both final tables retain the last 30 complete calendar report dates. Cleanup is bounded and hourly; logical reads exclude older dates immediately.
- The new one-day staging policy applies to daily-monitor runs. Existing seven-/28-day analysis snapshots retain their existing lifecycle because those screens still consume them.

## Collection and correctness

`sku_traffic_daily_dispatch` checks hourly. It queues yesterday and refreshes the two preceding days once per Beijing calendar day, then fills older gaps inside the retained window. At most three days wait per shop. Queue success means dispatch succeeded, not that Ozon data arrived. There is also manual selected-day recollection. While the monitor is open it refreshes once per minute and wakes the existing collector only for pending days; explicit collection also wakes it immediately. This does not require manually enabling extension polling. Closing the page or browser can stop browser-dependent execution; server dispatch remains queued, never falsely complete.

Only completed, single-day, contiguous `all_metrics/by_sku` page chains with a short terminal page can replace a complete day. A machine-verified source offset cap may publish the observed SKU rows as explicit partial coverage; it cannot replace prior complete-day facts and never manufactures missing SKUs as zero. Partial days with received rows are not repeatedly requeued within one calendar day. Missing pages, unsupported response shapes, unexplained pagination truncation, duplicate SKU identities, foreign-store identity, missing source pages or conflicting observed request dates leave prior facts intact. Final replacement and coverage completion are one transaction. Late results cannot overwrite a newer reservation. Empty official arrays can complete an empty day; absent SKUs/fields are not manufactured as zeros.

The source accepts a maximum page limit of 50 and offsets below 1000 (verified live on 2026-11-16). Existing collectors retain the explicit partial-coverage behavior. Manual single-day collection can request `category_partitioning`: after a capped chain, the server queues the observed Seller category-tree endpoint, replaces parent chains with disjoint category children, and splits again down to description type if necessary. Every planned leaf needs a continuous terminal chain. Superseded parent rows never publish. Duplicate SKUs, missing leaves, remaining leaf caps and mismatches against the unfiltered totals of all five count metrics prevent a complete-day replacement. The 1.5.7 unified collector / 1.0.47 standalone collector add the tree endpoint and preserve observed partition filters in compact uploads. This is an optional feature; the analysis page enables it only when a supporting collector version is observed, while unsupported older plugins continue existing collection and must never silently mark partial data complete.

A seven-day total cannot populate seven daily rows. PDP views are not labelled as clicks, and `ordered_units` is not labelled as order count. Conversion metrics retain the existing official percentage-unit convention and are not calculated by averaging percentages. Today is excluded because it is incomplete. Source report-date strings remain dates; collection timestamps display in Beijing time.

## API and migration

- `GET /api/db/seller-analytics/sku-daily`: tenant-scoped pagination (up to 100 SKUs), bounded 30-day series and shop/day coverage.
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

## Monitor workflow and attention

The monitor selects arbitrary owned shops, 1/7/15/30 days, attention/tag and inventory binding filters. Its compact coverage button opens per-shop/per-date collection entries on demand; the main page has no permanently expanded date strip. Each entry routes to the existing analysis page in fixed single-day mode and carries monitor filters back on return. Generic period summaries are hidden in that mode so a previous successful period cannot be mistaken for the selected day. Switching analysis shops only changes the view; it never cancels another browser's batches. Explicit batch cancellation remains available.

Catalog, inventory bindings and saved attention contribute SKU candidates even without daily facts; missing values remain null. Inventory groups are paginated in SQL before metadata hydration, keeping all selected matching SKU rows for a group together. Combo SKUs may appear in multiple associated groups; no cross-group metric total is manufactured. `seller_sku_traffic_watch` stores enterprise/shop/SKU, attention, one tag, a short note and update time, independent of 30-day fact cleanup. The additive migration checks its tenant primary key too.

## Local acceptance, 2026-11-16

- Base release: `5e96f3962597d0d6161c13e4bf7ba696365e1a1c`. No production code, configuration or task queue writes were made.
- RuVibe Mart (Seller ID 3570178), report date 2026-11-15: authenticated ego browser read 117 requests through the canonical local queue/result handlers and exact compact-upload function. Category partitions published 1618 unique SKU facts; all five count sums matched the unfiltered source totals (exposure 114611, search exposure 17657, PDP views 7746, carts 646, ordered units 192). This proves report coverage, not a zero record for every online product. Online catalog count was 3864; absent SKU dates remain missing.
- Browser delivery in this run used a controlled ego worker, not installation of the new extension build. Extension packaging and compatibility are separately tested; production extension acceptance remains outside this local-only task.
- Isolated MySQL fixtures run two shop workers against the same canonical queue concurrently; disjoint claims, cross-shop result rejection, same-SKU isolation, repeated-day reuse, category-child insertion, complete partition promotion, rollback and tenant ownership are verified.
- Production read-only observation: SKU fact table data/index about 1.52/0.27 MiB; analysis snapshots 32.02/0.25 MiB; expanded product metrics 55.16/24.20 MiB. Actual raw response payload sum 9.24 MiB for normal snapshots and 0.06 MiB for current daily staging; metric raw JSON sum 9.18 MiB. `information_schema` table row counts are estimates, while explicit aggregate counts are exact at query time. Normal-analysis snapshots counted 712 and daily stage 12 at that instant. Figures exclude backups/binlogs and are not a growth forecast.
- Filesystem read-only observation: root filesystem 40 GiB total, 30 GiB used, 7.4 GiB available (81%). No cleanup was applied.

Reproduce local component preview with `TENANT_TEST_MYSQL_SOCKET` against a socket-only server using `test/fixtures/sku-traffic-workflow-preview.mjs`. It creates an isolated test database, renders the real monitor/analysis views, and exposes local test-only worker endpoints. Configure `SKU_PREVIEW_HOST` if localhost:8788 is occupied. The preview must never use a production database or production credentials.

Local validation passed 131 focused tests, the production Vite build, UTF-8 encoding, SQL bindings and generated API-reference checks. The build retains existing CSS/chunk-size warnings. The full online product catalog was not exported; automatic approval review rejected that separate export, so the local real-day viewer intentionally shows missing product metadata while the synthetic demo verifies hydrated product/inventory presentation.

## Follow-up review gate

The compact coverage revision was integrated with remote release head `4fb0e4f2036967562d7342cc28495abc1cf83835` before validation. Coverage now occupies one short row; per-date details remain in the on-demand drawer. All 131 focused checks and the production Vite build passed again.

Live two-browser production acceptance passed on 2026-11-16 after the user aligned the ego collector enterprise. At 08:00:02 UTC both Mart and Z had ten requests actively executing in the same production SQL queue. Mart run `sacr_f6680072-ecce-4cdd-af0b-0697560620e0` finished at 08:05:53 UTC with 348/348 successes; Z run `sacr_c119d651-a663-4503-9d5a-206c568f9bfc` finished at 08:04:34 UTC with 348/348 successes. Both had zero failed/cancelled requests and zero request-store mismatches. Different browser instance IDs were observed. Each run persisted 348 source pages, and metric-to-snapshot shop mismatches were zero (Mart 8622 metric rows, Z 8308). This acceptance used the existing 1.5.6 production collectors; the new 1.5.7 partition transport remains covered by the separately described local daily pipeline and packaging checks.

Production queue batches were created through the normal authenticated ERP collection API for this user-requested concurrency acceptance. No production code rollout, service restart or production configuration change was performed. Afterward, release head `61f1ef53c7be35149882e4f77ac535ce41364b7f` was integrated and all 131 focused tests, production build, UTF-8, SQL bindings and generated API-reference checks passed again. A concrete ECS release still requires the repository-mandated explicit approval before activation.
