# Optimization Progress

Last updated: 2026-05-25

This tracker follows the 80-point principle: prefer small, verified changes that reduce daily maintenance cost or improve real hot paths.

## Current Priority Order

| Priority | Area | Status | Next action | Verification |
| --- | --- | --- | --- | --- |
| P0 | Cross-module navigation after frontend rebuild | Done | Watch for any route that still needs a second click after refresh recovery | `npm run build:frontend`, `npm test`, `npm run check:health` |
| P0 | Build artifact git noise | Done | Keep generated `public/vue-apps/assets/*` ignored and untracked | `git status --short` no longer shows recurring modified asset hashes |
| P1 | `mysql-cutover.js` size and coupling | In progress | Continue splitting low-risk domains such as stock warehouse rules or supplier master data | Targeted tests plus `npm test` |
| P2 | Orders paged performance | Done | Keep profiling `orders rows` and `orders meta` separately when changing order queries | `node scripts/profile-mysql-pages.mjs` |
| P2 | Exception workbench performance | Done | Keep exception tabs in the profiler and avoid sending non-profit tabs through profit-heavy SQL | `node scripts/profile-mysql-pages.mjs`, `npm test` |
| P3 | Large Vue pages | In progress | Continue extracting low-risk helper/dialog blocks from large pages | `npm run build:frontend` |
| P4 | Route dependency entry points | Pending | Move route modules away from direct `mysql-cutover.js` imports | `npm test` |
| P5 | Background task startup contention | Done | Watch restart logs for skipped overlapping background jobs | `npm run check:health` shortly after restart |
| P6 | Performance guardrails | In progress | Keep hot pages covered in `scripts/profile-mysql-pages.mjs`; add thresholds later if needed | Profile script output |

## Completed

- Reduced `src/server.js` direct dependency on `src/services/mysql-cutover.js` for basic routes.
- Ignored generated Vite asset output path in `.gitignore`.
- Optimized stock alert query by replacing an `OR` join with two index-friendly joins.
- Made `scripts/health-check.mjs` default to local `http://localhost:8787`, with `HEALTH_CHECK_BASE_URL` for public checks.
- Removed tracked Vite hash assets from the git index while keeping local files on disk.
- Routed `profit` and `sync` route modules through the service facade instead of direct `mysql-cutover.js` imports.
- Added true `orders rows` and `orders meta` measurements to the MySQL page profiler.
- Extended order counts/logistics option cache from 15s to 60s; rows are already fast, while meta remains the next cold-path target.
- Rewrote the order `unbound` status predicate to avoid an `OR` join; cold counts dropped from about 977ms to about 172ms, and `orders meta` dropped from about 1.3s to about 424ms in local profiling.
- Started large-page cleanup by moving order page static UI constants into `frontend/orders/constants/orders-ui.js`.
- Moved order profit-detail calculation helpers from `frontend/orders/OrdersPage.vue` into `frontend/orders/utils/order-profit-detail.js`.
- Moved order product-display row helpers from `frontend/orders/OrdersPage.vue` into `frontend/orders/utils/order-display.js`.
- Routed order route MySQL calls through `mysqlRuntimeServices` instead of direct `mysql-cutover.js` imports.
- Routed catalog route MySQL calls through `mysqlRuntimeServices`; `catalog.js` no longer imports `mysql-cutover.js`.
- Routed operations route MySQL calls through `mysqlRuntimeServices`; `operations.js` no longer imports `mysql-cutover.js`.
- Improved hot-path profiling by splitting order rows, order counts meta, and order logistics meta in `scripts/profile-mysql-pages.mjs`.
- Split order page meta loading so status counts update before slower logistics filter options.
- Parallelized profit dashboard summary range queries; local summary timing dropped from about 112ms to about 58ms in profiling.
- Preserved the intended admin route across Vite dynamic import reload recovery, including menu clicks and `vite:preloadError`, so cross-module navigation should not bounce back to the previous page after a build refresh.
- Split exception workbench order queries so non-profit tabs skip profit-cost joins and calculations; local cold profiling now shows stock around 125ms and binding around 111ms, down from about 188ms and 161ms.
- Extended exception workbench cache TTL from 15s to 45s and added exception tabs to `scripts/profile-mysql-pages.mjs`.
- Extracted MySQL auth/session persistence into `src/services/mysql-auth-session.js`; `src/server/session.js` no longer imports the large `mysql-cutover.js` directly.
- Extracted reusable MySQL master-data cache helpers into `src/services/mysql-master-data-cache.js`.
- Extracted supplier CRUD/list persistence into `src/services/mysql-suppliers.js` while keeping `mysql-cutover.js` re-exports for compatibility.
- Extracted stock warehouse rule CRUD/list persistence into `src/services/mysql-stock-warehouse-rules.js`.
- Extended order counts/logistics meta cache TTL to 180s and stock alert base cache TTL to 60s to reduce repeated hot-page recomputation.
- Moved profit dashboard summary ranges onto `analytics_shop_daily` snapshots and added a short dashboard cache; local cold summary dropped from about 1.8s to about 30ms.
- Added a global heavy-background-task gate and staggered default startup delays for analytics, advertising, and Ozon category sync.
- Reduced Element Plus frontend bundle cost by replacing full `app.use(ElementPlus)` with `ElLoading` directive registration in admin/orders entry points; build gzip for `vendor-element-plus` dropped from about 238KB to about 143KB.
- Moved order page formatting helpers into `frontend/orders/utils/order-format.js`.

## Notes

- `public/admin.html` is still generated by `npm run build:frontend` and may change when entry assets change.
- If deployment expects committed built assets, build output must be generated during packaging or deployment.
