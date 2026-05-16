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

Explicit historical correction:

- manual and scoped
- by one order, one product, one shop/date range, or one finance reconciliation job
- must leave audit traces

## 9. Performance Strategy

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

## 10. Implementation Order

1. keep `sync_state != 'final'` as the default batch recalculation boundary
2. add explicit force-recalculate path for historical correction
3. add normalized lifecycle classification
4. add finalized profit freeze semantics
5. add analytics snapshot tables for dashboard and drill-down performance
6. then design MySQL + TypeORM migration on top of the layered model
