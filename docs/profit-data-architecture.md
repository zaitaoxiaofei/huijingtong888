# Profit Data Architecture

Last updated: 2026-05-13

This document defines the long-term data model for Ozon order lifecycle, estimated profit, real settled profit, and large-data persistence strategy.

## 1. Goal

The system should stop treating every order as endlessly recalculable.

Business rule:

- Orders still moving through fulfillment and transport can keep using recalculable estimated profit.
- Orders that have reached real Ozon financial confirmation should become persistent fact records.
- Historical finalized orders should be query-friendly and traceable without repeated full recalculation.

## 2. Order Lifecycle Model

The order lifecycle is not just `created -> delivered`.

Recommended lifecycle stages:

1. `created`
- Order is created in Ozon.
- Seller has not prepared the goods yet.

2. `awaiting_packaging`
- Waiting for seller preparation / packing.

3. `awaiting_dispatch`
- Seller clicked prepare shipment.
- Waiting to hand over to carrier or station.

4. `in_transit_domestic_export`
- Parcel scanned into the network.
- Moving through export-side transport.

5. `customs_processing`
- At customs / under customs clearance.

6. `linehaul_to_russia`
- Customs completed.
- Moving toward Russia.

7. `arrived_city_station`
- Arrived at destination city / local station.

8. `pickup_point_ready`
- Arrived at pickup point or final delivery station.

9. `delivered_signed`
- Buyer signed and completed normal receipt.

10. `rejected_unclaimed`
- Buyer did not pick up in time or refused at pickup.

11. `after_delivery_return`
- Buyer signed first, then initiated a return because of dissatisfaction / quality / mismatch.

12. `cancelled_pre_fulfillment`
- Cancelled before meaningful fulfillment loss happened.

13. `finalized`
- Financially stable for business reporting.
- No longer part of daily recalculation scope.

The local DB does not need to expose all of these as one single column immediately.
But the architecture should allow:

- raw Ozon status persistence
- normalized business lifecycle stage
- financial finalization state

## 3. Profit Layers

### 3.1 Estimated Layer

Used for orders that are still open and not fully financially confirmed.

Main estimated components:

- product purchase cost
- domestic shipping
- international shipping by selected logistics rule
- Ozon commission estimate
- collecting fee estimate
- final-mile delivery estimate
- packaging estimate
- advertising estimate
- return-loss estimate
- withdrawal fee estimate

Characteristics:

- depends on mutable inventory bindings and rule configuration
- should be recalculable
- should not overwrite finalized real facts

### 3.2 Real Settled Layer

Used for orders with real Ozon financial data and stable completion outcome.

Main real components:

- real international shipping
- real commission
- real collecting fee
- real final-mile delivery fee
- real Ozon service fees
- real return or rejection loss
- real net profit

Characteristics:

- derived from persisted Ozon finance lines and finalized order outcome
- should become immutable by default after confirmation
- can only be corrected through explicit historical repair tools

### 3.3 Dashboard Operating Profit Layer

The profit dashboard must distinguish order-level profit from operating profit.

Order-level profit is the sum of order item profit facts:

- accrued items use settled Ozon finance profit where available
- pending items use estimated order profit
- item-level advertising allocation may already be included through `order_profit_items.advertising_cost_cny`

Operating profit is the business P&L view after applying the final store-level advertising spend from Ozon advertising reports.

Formula:

```text
operating_profit = order_profit + order_advertising_cost - advertising_report_spend
advertising_adjustment = advertising_report_spend - order_advertising_cost
operating_profit_margin = operating_profit / effective_revenue
```

Definitions:

- `order_profit`: the existing current profit field, suitable for order, SKU, and shop order performance.
- `order_advertising_cost`: advertising already allocated inside order profit items.
- `advertising_report_spend`: Ozon advertising report spend, preferred from `ozon_ad_sku_daily`.
- `advertising_adjustment`: the correction required to move from order advertising allocation to the store-level Ozon advertising report spend.
- `operating_profit`: the primary management profit after the final advertising report spend is applied once.

Dashboard display rule:

- Do not label `order_profit` as final net profit.
- Show `order_profit` and `operating_profit` separately.
- Replace vague reconciliation labels such as "unclassified difference" with "advertising adjustment" when the difference is caused by the advertising source mismatch.
- If `advertising_report_spend` is missing, `operating_profit` may equal order profit plus any available fallback, but the response should keep `advertising_cost_source` so the UI can show the source.

## 4. Return and Rejection Models

The system should not use one single return-loss rule for every case.

### 4.1 Normal Signed Order

- revenue recognized
- product cost recognized
- commission recognized
- collecting fee recognized
- final-mile fee recognized
- normal profit calculation applies

### 4.2 Rejected / Unclaimed at Pickup

- usually loses:
- product value
- collecting fee
- final-mile delivery fee
- may not need to lose the full post-signing service stack

### 4.3 After-Sign Return Because of Quality / Dissatisfaction

- usually loses:
- product value
- relevant transport and delivery costs
- collecting fee still applies
- commission may be reduced or adjusted depending on Ozon finance outcome

### 4.4 Pre-Fulfillment Cancellation

- should usually be excluded from true sales
- profit should usually be zero unless actual finance or inventory loss says otherwise

These rules should be mapped from:

- normalized lifecycle stage
- cancel / return reason
- Ozon finance service lines

### 4.5 Retained Revenue for Partial Refunds

Returned or rejected orders must not use the original order sale price as retained revenue.

Retained revenue exists only when Ozon finance explicitly reports positive settled sale accrual for the returned posting.

Formula:

```text
retained_revenue = max(0, settled_sale_accrual_cny)
return_loss = max(0, reason_based_loss_components + actual_aftersale_finance_fee - retained_revenue)
```

Reason-based loss components still come from the return/rejection profile:

- `none`: no local cost loss; keep only actual finance fee if present.
- `purchase_collecting`: product cost + international shipping + collecting fee.
- `purchase_collecting_international`: product cost + domestic shipping + international shipping + collecting fee.
- `commission_purchase_collecting_international`: product cost + domestic shipping + international shipping + collecting fee + commission.

Do not subtract `orders.sale_price`, `order_items.sale_price`, or original order revenue from return loss unless the settled Ozon finance rows prove retained revenue.

## 5. Persistence Strategy

### 5.1 Permanent Fact Tables

These should be treated as historical truth layers:

- `orders`
- `order_items`
- `ozon_orders_raw`
- `ozon_finance_items`
- `inventory_movements`
- `outbound_records`

For signed/accrued/finalized orders, the following should also become default persistent facts:

- `order_profit_items` real fee allocation
- final net profit
- final order outcome classification

### 5.2 Mutable Rule Tables

These remain editable:

- `products`
- `sku_mappings`
- logistics rule tables
- packaging rule settings
- commission fallback rules
- future advertising allocation rules

### 5.3 Derived Recalculable Tables

These should only drive open-order estimation:

- estimated profit fields on open orders
- estimated cost allocation for unfinalized items
- snapshot fields copied at order creation time

## 6. What Should Freeze

For finalized orders, freeze these by default:

- order sale amount
- final lifecycle timestamps
- final international shipping allocation
- final commission amount
- final collecting fee
- final final-mile delivery fee
- final service-fee allocation
- final return-loss classification
- final net profit

For open orders, these may still change:

- selected inventory binding
- cost source
- estimated logistics cost
- estimated commission logic
- estimated collecting fee
- estimated final-mile cost
- estimated return-loss model

## 7. Recommended Schema Direction

The current schema is close, but it still mixes estimated and final profit responsibilities.

Recommended next schema evolution:

### 7.1 Orders

Keep:

- raw status fields
- normalized business stage
- sync state
- finalized timestamp

Add later if needed:

- `business_stage`
- `financial_state`
- `final_outcome_type`

## 8. Current Implementation Progress

- `analytics_shop_daily`: implemented for daily shop-level revenue/profit/cancel/return snapshots.
- `analytics_product_profit_daily`: implemented for daily product-level revenue/profit snapshots.
- `analytics_sku_profit_daily`: implemented for daily SKU-level revenue/profit/cancel/return snapshots.
- Profit dashboard read path: `summary`, `byShop`, `bySku`, and `byProduct` now prefer local snapshot tables when the selected date range already has snapshot rows.
- Manual rebuild: profit page supports rebuilding snapshots for the current active date range, so historical windows can be refreshed after a repair or recalculation.
- Locked fact protection: accrued `order_profit_items` are protected from normal estimated recalculation overwrite.

### 7.2 Order Profit Items

Split conceptually into:

- estimated fields
- actual finalized fields
- freeze flag / finalized version marker

Possible future columns:

- `estimate_version`
- `actual_locked_at`
- `actual_source`
- `repair_reason`

### 7.3 Analytics Snapshot Tables

Add materialized tables instead of rebuilding all dashboard queries from item joins:

- `analytics_order_daily`
- `analytics_shop_daily`
- `analytics_product_profit_daily`
- `analytics_order_profit_snapshot`

These tables should store pre-aggregated metrics by:

- day
- shop
- product
- lifecycle bucket
- financial state

## 8. Recalculation Policy

Default recalculation:

- only `sync_state != 'final'`
- only open / exception orders
- only estimated layer
- profit stage is now split conceptually into:
  - `estimated_open`: order is still open, use estimated profit.
  - `delivered_waiting_finance`: order is delivered or closed, but no Ozon finance rows are attached yet, so keep using estimated profit.
  - `finance_partial`: Ozon finance rows exist, such as parent-order acquiring fee or partial fee rows, but the complete sale-accrual/commission/delivery basis is not ready yet.
  - `finance_accrued`: Ozon finance rows include sale accrual and core fee rows and have been applied/locked, so actual profit is ready.
- normal estimated recalculation must not write estimated values into `actual_profit`; actual profit is owned by finance application or explicit finance repair.
- Ozon finance completeness must check both full posting number rows and parent order-number rows, because some acquiring/payment fees are attached to the parent number without the `-1` posting suffix.

Explicit historical correction:

- manual and scoped
- by one order, one product, one shop/date range, or one finance reconciliation job
- must leave audit traces

## 9. Finance Fact Repair Workflow

Historical finance-profit repair must be dry-run first.

Use:

```bash
npm run repair:finance-profit -- --from 2026-03-01 --to 2026-04-30 --limit 100
```

This lists candidate orders where Ozon finance rows are complete enough for actual profit but local facts are stale, not fully locked, or need parent-order acquiring fee inclusion.

To inspect one posting:

```bash
npm run repair:finance-profit -- --posting=34643432-2450-1 --limit 10
```

Only after reviewing the dry-run output, apply with:

```bash
npm run repair:finance-profit -- --from 2026-03-01 --to 2026-04-30 --limit 100 --write
```

The write path reuses the Ozon finance application logic, including parent-order acquiring fee allocation. It must not be used for orders still in `delivered_waiting_finance` or `finance_partial`.

## 10. Performance Strategy

### Near-term

- keep raw Ozon order and finance payloads persisted locally
- restrict batch recalculation to open orders
- add missing indexes for hot query paths
- gradually move dashboards to snapshot tables

### Mid-term

- separate write-heavy sync paths from read-heavy analytics tables
- add nightly or incremental aggregation jobs
- store historical finalized profit as query-ready facts

### Long-term

- migrate this layered model to MySQL with TypeORM
- do not migrate the current mixed recalculation model directly

## 11. Implementation Order

1. keep `sync_state != 'final'` as the default batch recalculation boundary
2. add explicit force-recalculate path for historical correction
3. add normalized lifecycle classification
4. add finalized profit freeze semantics
5. add analytics snapshot tables for dashboard and drill-down performance
6. then design MySQL + TypeORM migration on top of the layered model
