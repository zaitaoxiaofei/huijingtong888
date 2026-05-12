# ozon ERP Development Tracker

Last updated: 2026-05-12

This document is the single tracking entry for system-level work, cross-page UI rules, and feature backlog. When a feature is started or finished, update the status here first.

Status legend:

- `Done`: implemented and verified locally.
- `In progress`: partially implemented; needs more work or review.
- `Next`: approved direction, should be implemented soon.
- `Backlog`: important but not the immediate development focus.
- `Research`: needs API or business verification before implementation.

## 0. Current Refactor Snapshot

- `In progress`: backend entry layer has been split from the monolithic server entry into dedicated HTTP/session/maintenance modules.
- `In progress`: order domain now has its own real service module for order list, paging, detail, marking, quality rules, and exception workbench logic.
- `In progress`: inventory domain now has its own real service module for stock alerts, warehouse stock rules, and Ozon stock sync.
- `In progress`: frontend shared layer has started extracting reusable UI infrastructure through `public/ui.js` and `public/ui-shared.css`.
- `Next`: continue replacing duplicated pagination, table rendering, dialog, toast, and motion logic inside the runtime frontend entry with shared helpers, then split the runtime entry by major business views.
- `Backlog`: after structural refactor stabilizes, start MySQL migration design and TypeORM evaluation as a separate phase.

## 1. System-Level Standards

| Area | Status | Requirement | Notes |
| --- | --- | --- | --- |
| UI Design System | In progress | All new UI must reuse `public/design-system.css`, `public/ui.js`, and documented DS classes. | Reference: `docs/UI_DESIGN_SYSTEM.md`. Legacy CSS still has known warnings from `npm run check:ui`. |
| Page structure | In progress | Toolbars, filters, page headers, table headers, modal headers must be sticky where the page scrolls. | Apply first to orders, stock, FBP, procurement, exception center, profit pages. |
| Visual state rules | Done | Do not paint whole rows/cards with saturated red/orange. Use neutral row background and semantic color only on labels/values/badges. | Added to UI docs and `ozon-ui-standard` skill. |
| Table controls | In progress | Search, tabs, page-size selector, and pagination must follow one unified table-control layout. | Pagination should sit at table footer/right side unless page design has a documented exception. |
| Inventory action placement | Done | Inventory actions in order rows belong in the inventory column, not the order operation column. | `去绑定库存`, `创建库存`, `删除绑定`, `创建采购请求` are inventory-column actions. |
| Naming/branding | Done | Use `OZON ERP`; do not use `Ozone` for the product name. | Left nav brand updated. |
| Data safety | Backlog | Add clearer backup/restore UX and safeguards. | Backup/restore buttons exist; still need progress, confirmation copy, and restore risk warning. |
| Backend modularization | In progress | Continue lowering coupling in `server.js`, `services.js`, and the runtime frontend entry through phased module boundaries. | First backend entry split is done. Next step is moving real domain implementations out of the giant files. |
| Frontend modularization | In progress | Break `public/app.repair.js` by large module boundaries first, then converge shared UI behaviors into reusable helpers and styles. | Priority is common pagination, table rendering, dialog/toast interaction, motion, and shared style tokens before fine-grained page refactors. |
| Future database evolution | Backlog | Keep SQLite stable now, then design a later migration path to MySQL with TypeORM after code modularization is mature. | This is a post-optimization phase, not the current refactor phase. |

## 2. Current Priority Queue

1. Exception Task Center cleanup and business correctness.
2. Order sync performance and incremental/background sync.
3. Order profit recalculation and inventory-bound recalculation.
4. Inventory/FBP/FBS stock warning improvements.
5. Configurable pricing/logistics fee rules.
6. Cross-page Design System migration.
7. Backend decoupling and phased service/domain split.
8. Frontend runtime entry split and shared UI layer extraction.
9. After structural refactor is stable, start MySQL migration design and TypeORM evaluation.

## 3. Exception Task Center

| Item | Status | Requirement | Notes |
| --- | --- | --- | --- |
| Business tabs | Done | Only show mutually exclusive tabs: `利润为负`, `订单超时`, `库存不足`, `未绑定库存`. | Removed `全部`, `高优先级`, `打印`. |
| Current title | Done | Internal section title should be `当前异常`, not duplicate `异常任务中心`. | Done in `public/index.html`. |
| Search and paging | Done | Search by order number, SKU, inventory ID, product name. Pagination follows unified table footer style. | Default page size is 50. Pagination is fixed at the bottom-right of the exception panel with first/previous/next/last controls. |
| Full-height layout | Done | Exception center should use the available viewport height and keep pagination at the page bottom. | `exception-workbench-panel` is now a full-height flex layout; task list scrolls independently above the footer pager. |
| Row hover | Done | Hover must stay neutral and readable. | Final override added in `public/design-system.css`. |
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
| Order profit breakdown | In progress | Detail should show sale, purchase cost, domestic freight, international freight, packaging/handling, commission, Ozon services, return loss, other fees. | Current detail exists, needs official Ozon fee reconciliation. |
| Negative profit handling | In progress | Negative profit should route to exception center with product/SKU/inventory context and quick edit. | Inventory edit now prompts recalculation when profit-affecting fields change. |
| Negative profit Ozon actions | Done | Profit-negative rows can operate the linked Ozon online product. | Added API-backed buttons for stock zeroing, product archive, and zero-then-archive. Demo shops return simulated success. |
| Product-level recalculation | Done | Recalculate all SKU/order profits under one inventory product after weight/dimensions/cost changes. | Added `POST /api/products/:id/recalculate-profits` and Exception Center action; verified service-level recalculation locally. |
| Commission API research | Research | Investigate if Ozon API can return commission by SKU/category/sales schema. | Use official Ozon docs only for implementation decisions. |
| Official Ozon fee categories | Research | Research all Ozon platform deductions: commission, logistics, services, payment/withdrawal, return, last-mile, storage if applicable. | Build rule registry instead of hardcoding. |
| Configurable logistics fee rules | Backlog | Add UI to configure logistics providers and formulas. | Example: China Post light parcel formula, CL land/air-land, future logistics methods. |
| Rule-to-SKU mapping | Backlog | Pricing rules should map to shop/logistics method/category/SKU when possible. | Needed as logistics methods expand. |

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
| Background sync | Backlog | Add backend scheduled tasks: orders, online products, stock warning. | User mentioned 30s/1min/10min future intervals. |
| Stock auto sync | Backlog | Opening stock alert should sync Ozon stock; later support timed refresh. | First priority was display; automation later. |
| Alert push | Backlog | Later push alerts to desktop popup, WeChat, or phone. | Requires notification channel design. |
| Fixed LAN IP | Backlog | Make local service easier for 3 users to access. | User’s current address was `http://192.168.71.66:8787`; should document router/static DHCP or Windows IP reservation steps if needed. |

## 10. Data and Backup

| Item | Status | Requirement | Notes |
| --- | --- | --- | --- |
| Backup button | Done | Left sidebar has backup data action. | Runs backup script. |
| Restore button | Done | Left sidebar has restore data action. | Needs clearer risk confirmation. |
| New database initialization | Done | Fresh databases should initialize tables and seed baseline people/products after schema creation. | Fixed module-load seed guards; verified with `DATABASE_PATH=':memory:'`. |
| Data integrity | Backlog | Add pre-restore backup, restore preview, and DB health check after restore. | Important before multi-user operations. |
| Audit trail | Backlog | Track manual edits: SKU binding changes, profit recalculation, inventory edits, cancellation overrides. | Needed for business accountability. |

## 11. Documentation Rules

- Every new feature should add or update one row in this tracker.
- Every UI change should follow `docs/UI_DESIGN_SYSTEM.md`.
- Every Ozon API behavior change should cite official docs in the implementation notes or a separate research doc.
- When a task is completed, change status to `Done` and add a short verification note.
- Do not rely on chat history as the only source of product requirements.
