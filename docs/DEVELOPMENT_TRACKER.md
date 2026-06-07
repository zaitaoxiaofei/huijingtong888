# ozon ERP Development Tracker

> Historical note: this tracker contains SQLite-to-MySQL transition history. The current runtime baseline is MySQL; do not treat old SQLite plan items as the active production architecture.

Last updated: 2026-05-17

This document is the single tracking entry for system-level work, cross-page UI rules, and feature backlog. When a feature is started or finished, update the status here first.

Status legend:

- `Done`: implemented and verified locally.
- `In progress`: partially implemented; needs more work or review.
- `Next`: approved direction, should be implemented soon.
- `Backlog`: important but not the immediate development focus.
- `Research`: needs API or business verification before implementation.

## 0. Current Refactor Snapshot

- `In progress`: backend entry layer has been split from the monolithic server entry into dedicated HTTP/session/maintenance modules.
- `In progress`: order/profit/sync route groups are now being extracted from `src/server.js` into `src/server/routes/*` so the main entry keeps shrinking toward startup/auth/dispatch-only responsibilities.
- `In progress`: catalog/config/procurement CRUD route groups are now also being extracted into dedicated `src/server/routes/*` modules, reducing the size of the remaining inline `handleRestRoute` branching block.
- `In progress`: shared dashboard and finance summary logic has been moved into `src/services/dashboard.js` so the giant `src/services.js` file can keep shrinking.
- `In progress`: product-level profit recalculation and outbound-sync maintenance logic is now being pulled into `src/services/profit-maintenance.js` through dependency-injected service extraction instead of another in-place expansion of `src/services.js`.
- `In progress`: historical profit review exports are now being served through `src/services/historical-profit-review-entry.js`, removing another set of wrapper exports from `src/services.js`.
- `In progress`: online product create/update/bind/sync entrypoints are now being served through `src/services/online-products-entry.js`, with runtime dependency registration still centralized in `src/services.js` for a low-risk transition.
- `In progress`: configuration-domain exports now run through `src/services/configuration.js`, moving exchange-rate, shop, people, supplier, logistics-rule, and cancellation-rule entrypoints out of the main service export surface.
- `In progress`: sync-domain exports now start flowing through `src/services/sync-entry.js`, so order sync, incremental sync, and finance sync no longer need to be re-exported directly from the monolithic service file.
- `In progress`: catalog mapping entrypoints now run through `src/services/catalog-mappings-entry.js`, separating SKU binding list/update/delete APIs from the main service export surface while keeping recalculation dependencies injected at runtime.
- `In progress`: catalog product read entrypoints now run through `src/services/catalog-products-entry.js`, so product list/detail/hidden/detail-drilldown reads are no longer exposed directly from the monolithic service export surface.
- `In progress`: catalog product write/import entrypoints now run through `src/services/catalog-product-write-entry.js`, so product create/update/delete and CSV import flows are no longer exposed directly from the monolithic service export surface.
- `In progress`: procurement-domain entrypoints now run through `src/services/procurement-entry.js`, so procurement request / purchase-order APIs are no longer exposed directly from the monolithic service export surface.
- `In progress`: inventory-domain list/movement entrypoints now run through `src/services/inventory-entry.js`, so inbound/outbound/inventory/current/raw-order/profit-item/exception APIs are no longer exposed directly from the monolithic service export surface.
- `In progress`: orders-domain internal dependency cleanup has started, and `src/services/orders.js` no longer needs to import `recalculateOrderCancelLossFlags` from the monolithic service file.
- `In progress`: order-operation entrypoints now run through `src/services/orders-ops-entry.js`, so label printing, package-label generation, shipment prepare, and order-profit recalculation APIs are no longer exported directly from the monolithic service surface.
- `In progress`: analytics snapshot refresh now runs through `src/services/analytics-refresh-entry.js`, so the top-level service index no longer exposes this business entry directly from the monolithic service file.
- `In progress`: profit snapshot refresh implementation itself has started moving out of `src/services.js` into `src/services/analytics-refresh.js`, which marks the shift from export cleanup into real heavy-implementation extraction.
- `In progress`: finance sync / finance reapply implementation has been extracted into `src/services/finance-sync.js`, keeping `src/services.js` as a thin runtime wrapper for this path.
- `In progress`: order profit recalculation implementation has been extracted into `src/services/order-profit-recalculation.js`, separating single-order, mapping-scope, and historical recalculation flows from the monolithic service file.
- `In progress`: order sync write path has started moving into `src/services/order-sync.js`, covering posting raw payload persistence, order/item upsert, initial profit breakdown creation, and outbound stock deduction setup.
- `In progress`: order domain now has its own real service module for order list, paging, detail, marking, quality rules, and exception workbench logic.
- `In progress`: inventory domain now has its own real service module for stock alerts, warehouse stock rules, and Ozon stock sync.
- `In progress`: frontend shared layer is being consolidated inside the Vue 3 + Element Plus admin shell and shared admin components.
- `Done`: active runtime has fully switched to the Vue 3 + Element Plus admin shell; old static frontend entry pages are no longer exposed in the current system.
- `In progress`: high-frequency frontend mutation flows are being switched from full `loadAll()` reloads to domain-scoped refresh helpers (`refreshProcurementDomain`, `refreshCatalogDomain`, `refreshOrdersAndExceptionsDomain`) to reduce post-action latency and avoid unnecessary whole-app data pulls.
- `In progress`: backend high-frequency read paths are being tightened with short-lived service caches and more targeted composite indexes, starting from profit summary, order list filters, and profit/order aggregation joins.
- `Next`: continue replacing duplicated pagination, table rendering, dialog, toast, and motion logic inside the runtime frontend entry with shared helpers, then split the runtime entry by major business views.
- `In progress`: MySQL preparation planning is now tracked as a separate execution stream; implementation should begin with config, adapter, and schema separation rather than direct cutover.

## 1. System-Level Standards

| Area | Status | Requirement | Notes |
| --- | --- | --- | --- |
| UI Design System | In progress | All new UI must follow the current Vue admin design system and shared admin components. | Reference: `docs/UI_DESIGN_SYSTEM.md`. |
| Page structure | In progress | Toolbars, filters, page headers, table headers, modal headers must be sticky where the page scrolls. | Apply first to orders, stock, FBP, procurement, exception center, profit pages. |
| Visual state rules | Done | Do not paint whole rows/cards with saturated red/orange. Use neutral row background and semantic color only on labels/values/badges. | Added to UI docs and `ozon-ui-standard` skill. |
| Table controls | In progress | Search, tabs, page-size selector, and pagination must follow one unified table-control layout. | Pagination should sit at table footer/right side unless page design has a documented exception. |
| Inventory action placement | Done | Inventory actions in order rows belong in the inventory column, not the order operation column. | `去绑定库存`, `创建库存`, `删除绑定`, `创建采购请求` are inventory-column actions. |
| Naming/branding | Done | Use `OZON ERP`; do not use `Ozone` for the product name. | Left nav brand updated. |
| Data safety | Backlog | Add clearer backup/restore UX and safeguards. | Backup/restore buttons exist; still need progress, confirmation copy, and restore risk warning. |
| Backend modularization | In progress | Continue lowering coupling in `server.js`, `services.js`, and the runtime frontend entry through phased module boundaries. | First backend entry split is done. Route-layer extraction now covers order/profit/sync plus catalog/config/procurement CRUD groups under `src/server/routes/*`. Shared dashboard/finance summary logic has been moved into `src/services/dashboard.js`, profit-maintenance logic has started moving into `src/services/profit-maintenance.js`, historical-profit-review exports now go through `src/services/historical-profit-review-entry.js`, online-product entrypoints now go through `src/services/online-products-entry.js`, configuration-domain exports now go through `src/services/configuration.js`, sync-domain exports now start going through `src/services/sync-entry.js`, finance sync implementation now lives in `src/services/finance-sync.js`, order sync write implementation now lives in `src/services/order-sync.js`, catalog mapping entrypoints now go through `src/services/catalog-mappings-entry.js`, catalog product read entrypoints now go through `src/services/catalog-products-entry.js`, catalog product write/import entrypoints now go through `src/services/catalog-product-write-entry.js`, procurement-domain entrypoints now go through `src/services/procurement-entry.js`, inventory-domain list/movement entrypoints now go through `src/services/inventory-entry.js`, the orders module has started shedding reverse imports back into the monolith, order-operation entrypoints now go through `src/services/orders-ops-entry.js`, analytics snapshot refresh now goes through `src/services/analytics-refresh-entry.js`, the snapshot refresh implementation now lives in `src/services/analytics-refresh.js`, and order profit recalculation now lives in `src/services/order-profit-recalculation.js`. Next step is moving more real domain implementations out of the giant files. |
| API contract governance | Done | Any backend API change is a T0 system change and must update `src/server/api-docs.js` plus regenerated `docs/BACKEND_API_REFERENCE.md` in the same change set. | Enforced by `npm run docs:api` and `npm run docs:api:check`. Review must reject drift. |
| Frontend modularization | In progress | Continue consolidating shared UI behaviors inside `frontend/admin` through reusable views, components, and styles. | Priority is common pagination, table rendering, dialog interaction, and shared layout tokens. |
| Frontend refresh strategy | In progress | Replace whole-app refreshes after local mutations with domain-scoped refresh pipelines wherever the changed data scope is known. | Procurement merge/inbound/request flows, online-product sync, exception negative-profit actions, stock archive/unbind, and common order-to-stock binding flows are already moved off full reload. Continue shrinking the remaining legacy `loadAll()` paths. |
| Backend query performance | In progress | Add low-risk caching and composite indexes to the most frequent profit/order/exception read paths before deeper storage redesign. | Current pass adds service-side profit-summary TTL caching plus new order-item / order-status / SKU-offer / mark-print composite indexes to reduce repeated scans under larger datasets. |
| Historical profit review decoupling | Done | The historical profit review workflow should not keep expanding inside the core service entry and page modules. | Extracted backend workflow into `src/services/historical-profit-review.js` and isolated the review UI inside the current Vue admin pages. |
| Database migration history | Archived | SQLite-era migration planning is no longer part of the active runtime baseline. | Historical materials now live under `docs/archive/legacy-sqlite/`; current runtime baseline is MySQL. |
| Configurable packaging fee | Next | Move the current hardcoded packaging fee rule into System Settings -> logistics settings. | Current temporary rule is sale amount > 50 RMB => 1 RMB, otherwise 0.5 RMB. Both estimated and actual order profit should call the same rule. |
| Data persistence layering | In progress | Separate frozen order facts from recalculable estimated profit data so historical signed/accrued orders stop being full-scan recalculation targets. | Current direction: `orders`, `order_items`, `ozon_orders_raw`, `ozon_finance_items`, and accrued `order_profit_items` become persistent fact/history layers; only open/unfinal orders stay in the default recalculation scope. |
| Profit fact locking | In progress | Real accrued profit rows should become locked facts after finance application. | Added `order_profit_items.is_locked / locked_at / lock_reason` schema direction. Next: expose force-unlock/repair flow only for explicit historical correction. |
| Profit analytics snapshots | In progress | Profit dashboard should gradually move from live multi-table aggregation to persisted daily snapshots. | Added schema/service direction for `analytics_shop_daily`, `analytics_product_profit_daily`, and `analytics_sku_profit_daily`. `profitSummary` summary/byShop/bySku/byProduct now prefer snapshot reads when data exists; profit page also has a manual snapshot rebuild entry for the current date range. |

## 2. Current Priority Queue

1. Exception Task Center cleanup and business correctness.
2. Order sync performance and incremental/background sync.
3. Order profit recalculation and inventory-bound recalculation.
4. Inventory/FBP/FBS stock warning improvements.
5. Configurable pricing/logistics fee rules.
6. Cross-page Design System migration.
7. Backend decoupling and phased service/domain split.
8. Frontend runtime entry split and shared UI layer extraction.
9. MySQL preparation: config standardization, db adapter extraction, schema separation, and SQL compatibility audit.
10. Persisted fact tables + incremental/materialized analytics for large-data performance.

## 3. Exception Task Center

| Item | Status | Requirement | Notes |
| --- | --- | --- | --- |
| Business tabs | Done | Only show mutually exclusive tabs: `利润为负`, `订单超时`, `库存不足`, `未绑定库存`. | Removed `全部`, `高优先级`, `打印`. |
| Current title | Done | Internal section title should be `当前异常`, not duplicate `异常任务中心`. | Done in the current Vue admin page. |
| Search and paging | Done | Search by order number, SKU, inventory ID, product name. Pagination follows unified table footer style. | Default page size is 50. Pagination is fixed at the bottom-right of the exception panel with first/previous/next/last controls. |
| Full-height layout | Done | Exception center should use the available viewport height and keep pagination at the page bottom. | `exception-workbench-panel` is now a full-height flex layout; task list scrolls independently above the footer pager. |
| Row hover | Done | Hover must stay neutral and readable. | Final override added in the current admin style system. |
| Product context | Done | SKU-related tasks must show SKU title/image if available; inventory tasks must show inventory product image/name. | Backend and frontend task payloads now include context fields. |
| Profit anomaly details | In progress | Profit-negative tasks should expose product image, SKU, inventory, weight, dimensions, and quick action to edit inventory. | Added direct `重算关联利润` action and profit context line: sales, profit, margin, purchase/logistics/platform fee components. |
| Negative profit Ozon actions | Done | Profit-negative tasks can act on the linked Ozon online product before or during shipping, not only after completion. | Added buttons for zero Ozon stock, archive Ozon product, and zero then archive. Operations are logged in `online_product_actions`. |
| Negative profit scan range | Done | Exception center must not miss profit-negative orders because of order table pagination limits. | Fixed backend generation to scan the full recent order aggregate instead of the first paged 100 orders. Local check now returns 696 profit tasks in the current database. |
| Deadline anomaly | In progress | Order timeout includes: shipment timeout; delivery timeout for land > 20 days; air-land > 15 days. | Logic exists. Need verify against real Ozon statuses and returned logistics timestamps. |
| Exception task state | Done | Exception tasks can be marked handled or ignored so they stop repeating in the current list. | Added `exception_task_states`, backend state API, and card actions. |
| Timeout operator workflow | Next | Timeout orders should expose tracking number copy, order number copy, and reusable customer comfort scripts. | Next node after negative-profit action polish. |
| Stock shortage split pages | Next | Stock shortage should separate local/FBS/FBP warning logic into clearer dedicated views. | Exception center can still summarize, but each tab should become an independent page later. |
| Unbound inventory workflow | Next | Unbound inventory warning should offer bind inventory or create inventory directly from the exception row. | Lower priority than negative profit and timeout handling. |
| Exception categories | Backlog | Add dedicated filters or table columns for root cause, owner, next action, and handled state history. | Useful when task count grows. |

## 4. Order System

| Item | Status | Requirement | Notes |
| --- | --- | --- | --- |
| Order layout | In progress | Order page should follow dense ERP table layout similar to mature Ozon ERP tools. | Main columns are mostly stable: mark, posting, time, shop, status, goods, inventory, quantity, money/profit, delivery, tracking, cancellation, actions. |
| Order page modularization | In progress | Continue splitting the orders page by large module boundaries first: workbench render layer, toolbar/filter action layer, domain rules layer, presenter/display layer, operations layer, then remaining detail/business helpers. | The current orders page already uses dedicated Vue modules for table rendering, controls, domain rules, presenters, and operations. |
| Inventory column actions | Done | Unbound SKU must show `去绑定库存` and `创建库存` directly in inventory column. | Implemented in `orderInventoryCell`. |
| Operation column | Done | Only order operations: stock/prepare, print label, cancel order, recalculate order profit. | Inventory actions removed from operation column. |
| Operation icons | In progress | Operation buttons should include clear icons: print, recalc, cancel, prepare. | Current text/icon placeholders exist; should later migrate to unified icon helpers. |
| Row hover | Done | Only row-level hover should show a subtle tracking color. Inventory cards should not turn saturated colors. | Specific inventory item hover disabled. |
| Print labels | In progress | Single and batch label printing should only print selected FBS orders, not all page orders. | Earlier bugs fixed, but needs another full regression with real printer flow. |
| Print preview | In progress | Batch labels should preview as individual labels/pages, not merge multiple labels onto one printed page. | Needs continued browser/OS print flow validation. |
| Prepare shipment | In progress | Waiting-packaging orders should support single and batch prepare via Ozon API. | Friendly error handling exists; API correctness still needs real account verification. |
| Status tabs | In progress | Tabs include all orders, waiting stock/packaging, waiting delivery, delivering, dispute, delivered, cancelled, unbound. | `待绑定` means any order where at least one SKU is unbound. |
| Marking | In progress | Color marks must persist and filter correctly. | Mark filters were improved; continue verifying all mark types. |
| Cancellation info | In progress | Cancelled orders should show initiator, Chinese reason, and whether it is cancellation or return/loss. | Russian/English mapping exists but should be expanded from real data. |
| Tracking link | Done | Tracking number links to `https://tracking.ozon.ru/?track=...&local=zh-Hans`. | Hide tracking for statuses that should not have tracking. |
| Order time columns | Done | Order time and update time are separated from status details for readability. | Continue compacting if row height grows. |
| Profit detail | In progress | Each order should show clear profit breakdown and “查看详情”. | Recalculation action moved to operation column. |
| Recalculate order profit | In progress | One order can be recalculated after inventory weight/cost/dimension corrections. | Existing button works for single order; still need batch/product-level recalculation. |
| Pull new orders | Research | `拉取新订单` should not sync too many historical orders. | Need audit current incremental sync range/count logic. |

## 5. Inventory System

| Item | Status | Requirement | Notes |
| --- | --- | --- | --- |
| Product inventory page | In progress | Product inventory is now part of inventory system, not nested under order system. | Nav/page naming has been adjusted conceptually; continue code cleanup. |
| Inventory page modularization | In progress | Break the stock runtime entry by large module boundaries first: stock control/action layer, stock workbench render layer, stock alert/FBP workbench layer, stock admin/detail layer, then remaining warehouse-rule/sync lifecycle helpers. | The current inventory pages already use dedicated Vue modules for controls, workbench rendering, alerts, FBP, and detail dialogs. |
| Inventory search | Done | Product inventory has search by product name, SKU, shop, created time. | Continue standardizing controls. |
| Stock alert page | In progress | Stock warning page is first tab under inventory system. | Displays local/FBS/FBP warning concepts. |
| Local stock warning | In progress | Only sold products should produce real local-stock warnings. Unsold products are forecast only. | User clarified this rule; verify implementation. |
| FBS virtual stock warning | Done | FBS virtual stock below 10 should warn. | Implemented threshold. |
| FBP real stock warning | In progress | FBP stock is special and should have its own table page. | FBP table exists, needs continued UI and sorting polish. |
| FBP table columns | In progress | Shop, SKU info, FBP available, local linked inventory, 30-day sales, 7-day trend, stock coverage/advice, actions. | Need remove duplicated trend data and keep SKU column compact. |
| FBP sorting | In progress | Sort by available stock and 30-day sales from table headers. | Verify sort state and visual indicators. |
| FBP binding edit | Next | Edit binding should open a modal on current page, not navigate away and lose pagination. | Important usability improvement. |
| SKU binding configuration | Next | Rename `库存 SKU 配置` to `库存-SKU 绑定配置`; add search by name, SKU, inventory ID, shop, date. | Add pagination and inline edit/delete/add. |
| Bound SKU editor | Next | Product inventory bound SKU list should show `去编辑`; edit page/modal should show shop, SKU, image, owner, added time. | Replace `+1` with ellipsis plus edit button. |
| Unbind inventory from order | Done | Order inventory column can delete wrong SKU binding and return order to waiting binding state. | Continue verifying recalculation after rebinding. |

## 6. Procurement System

| Item | Status | Requirement | Notes |
| --- | --- | --- | --- |
| Module naming | In progress | Procurement system contains: create procurement request, purchase list, inbound flow, purchase history. | Continue navigation cleanup. |
| Create procurement from order | In progress | Inventory column should allow creating procurement request from an order/inventory product. | Button exists for bound inventory rows. |
| Purchase request reuse | Backlog | Reuse existing procurement request modal/page for order-origin requests. | Avoid duplicate forms. |
| Inbound flow | Backlog | Keep purchase complete separate from inbound confirmation and QC. | Existing flow exists; needs UI DS migration. |

## 7. Profit, Pricing, and Fee Logic

| Item | Status | Requirement | Notes |
| --- | --- | --- | --- |
| Profit dashboard naming | Done | `利润汇总` renamed conceptually to `利润看板`. | Keep naming consistent. |
| Profit dashboard drill-down | Done | Summary cards must support traceable detail views for total sales, current profit, confirmed profit, cancelled orders, and returned/rejected orders. | Added `/api/profit-details` and card-level detail modals. Verified service totals for 2026-05-01~2026-05-13 match `profitSummary`; modal rows may be limited but totals use the full filtered set. Summary shop filter now also applies to overview cards and detail drill-down. Profit detail for current/pending/confirmed profit now also supports inventory-level aggregation with expandable order rows. |
| Profit dashboard metric definitions | In progress | Make every dashboard metric explainable and auditable. | Total sales now excludes cancelled orders in dashboard/detail SQL. Profit detail drill-down for total/current/confirmed/pending profit now also excludes return/rejection rows, and cancelled/return detail views explicitly show outcome type, reason, and accounting treatment. Cancel/return loss classification still needs continued real Ozon reason verification. |
| Order outcome classification | In progress | Unify the backend distinction between pre-fulfillment cancellation, pickup rejection/non-pickup, after-delivery return, and normal signed orders. | Added shared order outcome classification direction and switched profit analytics/snapshot aggregation to this unified outcome model first. Order profit detail now also shows outcome label/hint and uses the same outcome model to explain actual aftersale loss. Next: reuse the same outcome model in more list labels, exception center, and export fields. |
| Confirmed profit detail | Done | Confirmed profit card should open signed/accrued order detail rows for the selected date range. | Basic detail is implemented. Current local sample has no accrued rows for 2026-05-01~2026-05-13, so UI shows an empty state correctly. |
| Pending profit detail | Backlog | Pending profit can remain summary-only for now unless business review needs it. | User prefers not to prioritize pending unconfirmed order detail yet. Keep current estimated model, but ensure it is clearly labeled as not final. |
| Cancelled order detail | Done | Cancelled order card should open cancelled order rows and make it clear these are excluded from true sales. | Basic detail is implemented with order, product, shop, time, status, cancelled amount, and reason fields. Final zero-profit/loss classification remains under research. |
| Return/rejection detail | In progress | Returned/rejected order card should open detail rows separate from normal cancellations. | Basic return detail entry exists. Need classify Ozon statuses/reasons into buyer rejection, long-time non-pickup/rejection, quality issue/unsuitable, and normal pre-fulfillment cancellation. |
| Cancellation and return loss rules | In progress | Define business loss rules before changing final profit calculation. | Added shared reason-driven loss profiles and wired them into estimated profit, finance reapply, order detail, and profit dashboard detail. Current confirmed rules: pre-fulfillment cancellation / platform quality-description check / missing passport => 0 loss; buyer unclaimed / delivery failed / customs failed => product cost + collecting fee; unsuitable / wrong item / damaged => product cost + collecting fee + international freight; quality issue => commission + product cost + collecting fee + international freight. Next: continue enriching real Ozon reason samples and decide whether some finance-return rows should override or only annotate the reason-based model. |
| Order profit breakdown | In progress | Detail should show sale, purchase cost, domestic freight, international freight, packaging/handling, commission, Ozon services, return loss, other fees. | Current detail exists and now exposes order outcome type plus actual aftersale-loss explanation/detail rows. Next focus is continued official Ozon fee reconciliation and richer finance-type mapping. |
| Negative profit handling | In progress | Negative profit should route to exception center with product/SKU/inventory context and quick edit. | Inventory edit now prompts recalculation when profit-affecting fields change. |
| Negative profit Ozon actions | Done | Profit-negative rows can operate the linked Ozon online product. | Added API-backed buttons for stock zeroing, product archive, and zero-then-archive. Demo shops return simulated success. |
| Product-level recalculation | Done | Recalculate all SKU/order profits under one inventory product after weight/dimensions/cost changes. | Added `POST /api/products/:id/recalculate-profits` and Exception Center action; verified service-level recalculation locally. |
| Recalculation scope control | In progress | Batch profit recalculation should default to open/unfinal orders only. Historical finalized orders should not be rescanned unless explicitly forced. | `recalculateOrderItemsForMapping` now skips `orders.sync_state = 'final'`. Added explicit historical force-recalculate service/API for finalized orders with finance data, and added a companion cleanup service/API for delivered/accrued rows that still carried old estimated aftersale loss without any cancel reason or real finance aftersale evidence. |
| Historical profit review workflow | Done | Residual historical aftersale-loss anomalies need a dedicated review/repair workflow instead of staying mixed inside main profit results. | Added `historical_profit_reviews` persistence, `GET /api/profits/historical-review`, `POST /api/profits/historical-review/actions`, and a profit-rules-page review panel with batch keep/clear/recalculate/reset actions. Current full-database verification result: remaining review rows = 0. |
| Commission API research | Research | Investigate if Ozon API can return commission by SKU/category/sales schema. | Use official Ozon docs only for implementation decisions. |
| Official Ozon fee categories | Research | Research all Ozon platform deductions: commission, logistics, services, payment/withdrawal, return, last-mile, storage if applicable. | Build rule registry instead of hardcoding. |
| Configurable logistics fee rules | Backlog | Add UI to configure logistics providers and formulas. | Example: China Post light parcel formula, CL land/air-land, future logistics methods. |
| Rule-to-SKU mapping | Backlog | Pricing rules should map to shop/logistics method/category/SKU when possible. | Needed as logistics methods expand. |

### 7.1 Profit Dashboard Drill-Down Scope

- Total sales detail: show only valid non-cancelled sales in the selected date range. The detail table should include order number, product image, shop, order creation time, status, and sales amount.
- Current profit detail: show the same valid sales rows, plus the profit used by the dashboard. Signed/accrued rows use real profit; not-yet-confirmed rows use estimated profit.
- Confirmed profit detail: show only signed/accrued rows and their real profit/profit rate.
- Pending profit detail: lower priority for now; keep the card clear that it is not final.
- Cancelled order detail: show cancelled amount and reason separately from true sales, so users can verify cancelled orders are not counted into total sales.
- Return/rejection detail: show rejected/returned orders separately from ordinary cancellations once reason classification is verified.
- Loss classification draft: ordinary cancellation before shipment should be zero profit and excluded from sales; rejection/non-pickup after shipment should count product purchase cost loss; quality/unsuitable after receipt should count purchase cost plus relevant freight/service loss. This must be confirmed against real Ozon cancellation reason/status and finance records before final calculation changes.

## 8. Online Products

| Item | Status | Requirement | Notes |
| --- | --- | --- | --- |
| Status coverage | In progress | Online products should include all statuses: selling, ready, error, waiting edit, hidden/offline, archived. | Some statuses/tabs exist; archived/offline data completeness needs sync verification. |
| Search layout | Done | Store, product name, offer/SKU search, sync selected, sync all. | Continue DS migration. |
| Missing images | Research | Some online products have no image. Need determine whether Ozon API omits images or local mapping failed. | Inspect raw payload and image fields. |
| Sync selected products | In progress | Sync selected online products separately from full sync. | Existing button present. |
| Archive/zero-stock action | Done | Online products can be zeroed or archived from negative-profit exception rows. | Added backend service `performOnlineProductAction`, route `POST /api/online-products/action`, and local action log. Next: add warehouse selector for FBS zero-stock requests. |

## 9. Synchronization and Automation

| Item | Status | Requirement | Notes |
| --- | --- | --- | --- |
| Order pull performance | Research | Pull new orders is still slow; ensure it only pulls the intended range and not thousands unexpectedly. | Audit sync API date ranges and pagination. |
| Incremental sync | Next | Before writing many records, check whether count/status changed for the chosen range. If no changes, skip heavy writes. | Design likely: fast metadata count/checksum per shop/date range. |
| Background sync | In progress | Add backend scheduled tasks: orders, online products, stock warning. | Orders now default to hourly status sync when env does not override it. User mentioned 30s/1min/10min future intervals. |
| Order lifecycle history | Done | Track unfinished order status over time for later delivery lifecycle analysis. | Added MySQL table `order_status_history`, hourly same-state de-duplication, automatic writes from Ozon order sync, indexes for order/time/status/region queries, summary/detail APIs, and one-time backfill script. Verification on 2026-05-18: 6207 history rows, 3080 open orders, 1922 rows with customer name, 5551 rows with region/city, 6207 rows with delivery window. |
| Stock auto sync | Backlog | Opening stock alert should sync Ozon stock; later support timed refresh. | First priority was display; automation later. |
| Alert push | Backlog | Later push alerts to desktop popup, WeChat, or phone. | Requires notification channel design. |
| Remote access maintenance | Backlog | Keep current Cloudflare Tunnel + site access password deployment stable and easy to recover. | Prefer documenting domain, tunnel, startup, and password-rotation steps instead of old LAN-only access guidance. |

## 10. Data and Backup

| Item | Status | Requirement | Notes |
| --- | --- | --- | --- |
| Backup button | Done | Left sidebar has backup data action. | Runs backup script. |
| Restore button | Done | Left sidebar has restore data action. | Needs clearer risk confirmation. |
| New database initialization | Done | Fresh databases should initialize tables and seed baseline people/products after schema creation. | Fixed module-load seed guards and verified with isolated test database initialization. |
| Data integrity | Backlog | Add pre-restore backup, restore preview, and DB health check after restore. | Important before multi-user operations. |
| Audit trail | Backlog | Track manual edits: SKU binding changes, profit recalculation, inventory edits, cancellation overrides. | Needed for business accountability. |

## 10.1 Data Persistence Strategy

- Frozen fact layer: `orders`, `order_items`, `ozon_orders_raw`, `ozon_finance_items`, outbound/inventory movement records.
- Rule: once Ozon finance has been synced and an order reaches final/accrued status, the platform facts should be treated as persistent history instead of being recomputed from mutable inventory rules.
- Recalculable layer: estimated profit fields for unfinal orders, SKU binding candidates, and model-based shipping/commission assumptions.
- Mutable business inputs: product cost, domestic freight, weight, dimensions, packaging rule, logistics rule, mapping relation.
- Persistent final outputs: finalized international freight allocation, finalized platform fee allocation, finalized net profit, finalized cancellation/return loss classification after finance confirmation.
- Near-term optimization path:
- 1. Default all batch recalculation to `orders.sync_state != 'final'`.
- 2. Add dedicated historical force-recalculate tools for exceptional correction cases only.
- 3. Add analytics snapshot/materialized tables for dashboard queries by date/shop/product instead of rebuilding from item-level joins every time.
- 4. Keep raw Ozon payloads and finance lines locally for traceability and future reclassification without repeated API dependency.
- 5. Historical SQLite-to-MySQL migration planning has been archived under `docs/archive/legacy-sqlite/`; do not treat it as the current runtime plan.

## 10.2 Archived Database Migration Milestones

| Milestone | Status | Exit condition | Notes |
| --- | --- | --- | --- |
| Legacy SQLite cutover program | Archived | Retained only for historical traceability. | See `docs/archive/legacy-sqlite/README.md`. |

## 11. Documentation Rules

- Every new feature should add or update one row in this tracker.
- Every UI change should follow `docs/UI_DESIGN_SYSTEM.md`.
- Every Ozon API behavior change should cite official docs in the implementation notes or a separate research doc.
- Every backend API contract change is a T0 change: update `src/server/api-docs.js`, run `npm run docs:api`, and pass `npm run docs:api:check` in the same change set.
- When a task is completed, change status to `Done` and add a short verification note.
- Do not rely on chat history as the only source of product requirements.
