# MySQL Schema Draft

Last updated: 2026-05-17

## 1. Goal

This document is the first executable MySQL-facing draft for the current SQLite runtime schema.

It is intended to support:

- local dry-run migration
- table-by-table data mapping
- later MySQL DDL implementation
- row-count and aggregate verification

This draft does not mean MySQL runtime cutover is ready.

## 2. Global Defaults

Recommended defaults:

- engine: `InnoDB`
- charset: `utf8mb4`
- collation: `utf8mb4_0900_ai_ci`
- timezone handling: store runtime timestamps as UTC text-compatible `DATETIME`
- booleans: use `TINYINT(1)` with explicit defaults
- JSON payload columns: use `JSON` where the field is known to be structured payload, otherwise `LONGTEXT`

Recommended MySQL driver:

- `mysql2`

## 3. Type Mapping Rules

| SQLite intent | MySQL draft |
| --- | --- |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY` |
| integer foreign key | `BIGINT UNSIGNED` |
| `REAL` | `DECIMAL(18,4)` for money/rates, `DOUBLE` for dimensions if needed |
| `TEXT` business field | `VARCHAR(255)` when bounded, otherwise `TEXT` |
| payload json text | `JSON` |
| timestamp text | `DATETIME` |
| boolean-like integer | `TINYINT(1)` |

Money/rate guidance:

- amounts, fees, profits, rates: prefer `DECIMAL(18,4)`
- counts, quantities: prefer `INT` or `BIGINT`

## 4. Ownership Groups

### Master data

- `shops`
- `people`
- `products`
- `suppliers`
- `system_settings`
- `system_setting_changes`
- `exchange_rates`

### Mapping and catalog linkage

- `online_products`
- `sku_mappings`
- `online_product_actions`

### Procurement and stock movement

- `procurement_requests`
- `purchase_orders`
- `purchase_order_items`
- `inbound_records`
- `outbound_records`
- `inventory_movements`
- `inventory_current`
- `ozon_stock_snapshots`
- `stock_warehouse_rules`

### Order and finance facts

- `orders`
- `order_items`
- `order_profit_items`
- `ozon_orders_raw`
- `ozon_finance_items`
- `order_marks`
- `order_label_prints`
- `order_exceptions`
- `exception_task_states`
- `historical_profit_reviews`
- `order_quality_rules`
- `order_cancellation_rules`
- `sync_logs`
- `sessions`

### Analytics and cache

- `analytics_shop_daily`
- `analytics_product_profit_daily`
- `analytics_sku_profit_daily`
- `analytics_cache`

## 5. Table Drafts

### `shops`

```sql
CREATE TABLE shops (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  legal_entity VARCHAR(255) NULL,
  ozon_client_id VARCHAR(128) NULL,
  api_key_hint VARCHAR(255) NULL,
  watermark_path TEXT NULL,
  watermark_name VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  payout_rate DECIMAL(8,4) NOT NULL DEFAULT 0.3300,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `people`

```sql
CREATE TABLE people (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  username VARCHAR(255) NULL,
  role VARCHAR(64) NOT NULL DEFAULT 'operator',
  avatar_url TEXT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uk_people_name (name),
  UNIQUE KEY uk_people_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `products`

```sql
CREATE TABLE products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  selection_id VARCHAR(128) NULL,
  code VARCHAR(128) NULL,
  name VARCHAR(255) NOT NULL,
  image_url TEXT NULL,
  purchase_url TEXT NULL,
  supplier_note TEXT NULL,
  source_platform VARCHAR(64) NOT NULL DEFAULT '1688',
  shipping_method VARCHAR(64) NOT NULL DEFAULT 'air_land',
  recommended_shipping_method VARCHAR(64) NOT NULL DEFAULT 'air_land',
  purchase_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  domestic_shipping DECIMAL(18,4) NOT NULL DEFAULT 0,
  handling_fee DECIMAL(18,4) NOT NULL DEFAULT 0,
  purchase_quantity INT NOT NULL DEFAULT 1,
  package_weight_g DECIMAL(18,4) NOT NULL DEFAULT 0,
  length_cm DECIMAL(18,4) NOT NULL DEFAULT 30,
  width_cm DECIMAL(18,4) NOT NULL DEFAULT 20,
  height_cm DECIMAL(18,4) NOT NULL DEFAULT 10,
  listing_price_rub DECIMAL(18,4) NOT NULL DEFAULT 0,
  air_sale_price_rmb DECIMAL(18,4) NOT NULL DEFAULT 0,
  exchange_rate DECIMAL(18,4) NOT NULL DEFAULT 11.3200,
  target_margin DECIMAL(8,4) NOT NULL DEFAULT 0.2000,
  desired_profit_mode VARCHAR(32) NOT NULL DEFAULT 'margin',
  desired_profit_value DECIMAL(18,4) NOT NULL DEFAULT 20,
  return_rate DECIMAL(8,4) NOT NULL DEFAULT 0.0500,
  payment_fee_rate DECIMAL(8,4) NOT NULL DEFAULT 0.0130,
  withdrawal_fee_rate DECIMAL(8,4) NOT NULL DEFAULT 0.0120,
  owner_person_id BIGINT UNSIGNED NULL,
  created_by_person_id BIGINT UNSIGNED NULL,
  product_type VARCHAR(32) NOT NULL DEFAULT 'main',
  parent_product_id BIGINT UNSIGNED NULL,
  accessory_note TEXT NULL,
  selection_status VARCHAR(32) NOT NULL DEFAULT 'draft',
  alert_stock INT NOT NULL DEFAULT 5,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_products_selection_id (selection_id),
  UNIQUE KEY uk_products_code (code),
  KEY idx_products_owner (owner_person_id),
  KEY idx_products_parent (parent_product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `online_products`

```sql
CREATE TABLE online_products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT UNSIGNED NOT NULL,
  ozon_sku VARCHAR(128) NOT NULL,
  offer_id VARCHAR(255) NULL,
  ozon_product_id VARCHAR(128) NULL,
  name VARCHAR(255) NOT NULL,
  image_url TEXT NULL,
  primary_image TEXT NULL,
  sale_price DECIMAL(18,4) NOT NULL DEFAULT 0,
  currency_code VARCHAR(16) NULL,
  marketing_price DECIMAL(18,4) NOT NULL DEFAULT 0,
  old_price DECIMAL(18,4) NOT NULL DEFAULT 0,
  status VARCHAR(64) NOT NULL DEFAULT 'online',
  visibility VARCHAR(64) NULL,
  archived TINYINT(1) NOT NULL DEFAULT 0,
  is_discounted TINYINT(1) NOT NULL DEFAULT 0,
  images_json JSON NULL,
  barcodes_json JSON NULL,
  stocks_json JSON NULL,
  commissions_json JSON NULL,
  attributes_json JSON NULL,
  raw_json JSON NULL,
  ozon_updated_at DATETIME NULL,
  product_id BIGINT UNSIGNED NULL,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_online_products_shop_sku (shop_id, ozon_sku),
  KEY idx_online_products_shop_status (shop_id, status),
  KEY idx_online_products_shop_offer (shop_id, offer_id),
  KEY idx_online_products_product (product_id),
  KEY idx_online_products_synced (synced_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `sku_mappings`

```sql
CREATE TABLE sku_mappings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  person_id BIGINT UNSIGNED NULL,
  online_product_id BIGINT UNSIGNED NULL,
  ozon_sku VARCHAR(128) NOT NULL,
  offer_id VARCHAR(255) NULL,
  display_name VARCHAR(255) NULL,
  commission_low DECIMAL(8,4) NOT NULL DEFAULT 0.1200,
  commission_high DECIMAL(8,4) NOT NULL DEFAULT 0.1700,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_sku_mappings_shop_sku (shop_id, ozon_sku),
  KEY idx_sku_mappings_product_shop (product_id, shop_id),
  KEY idx_sku_mappings_shop_offer_active (shop_id, offer_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `orders`

```sql
CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT UNSIGNED NOT NULL,
  posting_number VARCHAR(128) NOT NULL,
  order_number VARCHAR(128) NULL,
  status VARCHAR(64) NOT NULL,
  logistics_status VARCHAR(64) NOT NULL DEFAULT 'created',
  tracking_stage VARCHAR(64) NOT NULL DEFAULT 'pending_stock',
  ordered_at DATETIME NOT NULL,
  delivered_at DATETIME NULL,
  accrued_at DATETIME NULL,
  buyer_region VARCHAR(255) NULL,
  tracking_number VARCHAR(255) NULL,
  external_tracking_url TEXT NULL,
  cancel_reason_id BIGINT NULL,
  cancel_reason TEXT NULL,
  cancel_initiator VARCHAR(255) NULL,
  cancel_type VARCHAR(255) NULL,
  cancelled_after_ship TINYINT(1) NOT NULL DEFAULT 0,
  cancel_loss_applies TINYINT(1) NOT NULL DEFAULT 0,
  sync_state VARCHAR(32) NULL,
  finalized_at DATETIME NULL,
  last_synced_at DATETIME NULL,
  last_status_changed_at DATETIME NULL,
  sync_note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_orders_posting_number (posting_number),
  KEY idx_orders_shop_stage (shop_id, tracking_stage),
  KEY idx_orders_sync_state_ordered_at (sync_state, ordered_at),
  KEY idx_orders_shop_status_ordered_at (shop_id, status, ordered_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `order_items`

```sql
CREATE TABLE order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  sku_mapping_id BIGINT UNSIGNED NULL,
  ozon_sku VARCHAR(128) NOT NULL,
  ozon_name VARCHAR(255) NULL,
  ozon_image_url TEXT NULL,
  ozon_product_id VARCHAR(128) NULL,
  quantity INT NOT NULL DEFAULT 1,
  sale_price DECIMAL(18,4) NOT NULL DEFAULT 0,
  frozen_purchase_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  frozen_domestic_shipping DECIMAL(18,4) NOT NULL DEFAULT 0,
  frozen_international_shipping DECIMAL(18,4) NOT NULL DEFAULT 0,
  frozen_handling_fee DECIMAL(18,4) NOT NULL DEFAULT 0,
  estimated_commission DECIMAL(18,4) NOT NULL DEFAULT 0,
  platform_fee_actual DECIMAL(18,4) NOT NULL DEFAULT 0,
  aftersale_loss DECIMAL(18,4) NOT NULL DEFAULT 0,
  estimated_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  actual_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  settlement_state VARCHAR(32) NOT NULL DEFAULT 'pending',
  KEY idx_order_items_order (order_id),
  KEY idx_order_items_order_sku (order_id, ozon_sku),
  KEY idx_order_items_mapping (sku_mapping_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `order_profit_items`

```sql
CREATE TABLE order_profit_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_item_id BIGINT UNSIGNED NOT NULL,
  sale_amount_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  purchase_cost_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  domestic_shipping_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  international_shipping_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  packaging_cost_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  commission_rate DECIMAL(8,4) NOT NULL DEFAULT 0,
  commission_fee_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  ozon_service_fee_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  return_loss_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  advertising_cost_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  other_fee_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  gross_profit_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  net_profit_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  profit_status VARCHAR(32) NOT NULL DEFAULT 'estimated',
  is_locked TINYINT(1) NOT NULL DEFAULT 0,
  locked_at DATETIME NULL,
  lock_reason VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order_profit_items_order_item (order_item_id),
  KEY idx_order_profit_items_status_locked (profit_status, is_locked, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `ozon_finance_items`

```sql
CREATE TABLE ozon_finance_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT UNSIGNED NOT NULL,
  operation_id VARCHAR(128) NOT NULL,
  posting_number VARCHAR(128) NULL,
  order_number VARCHAR(128) NULL,
  operation_type VARCHAR(128) NULL,
  operation_type_name VARCHAR(255) NULL,
  operation_date DATETIME NULL,
  service_type VARCHAR(191) NOT NULL,
  service_name VARCHAR(255) NULL,
  amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  accruals_for_sale DECIMAL(18,4) NOT NULL DEFAULT 0,
  sale_commission DECIMAL(18,4) NOT NULL DEFAULT 0,
  delivery_charge DECIMAL(18,4) NOT NULL DEFAULT 0,
  return_delivery_charge DECIMAL(18,4) NOT NULL DEFAULT 0,
  currency_code VARCHAR(16) NULL,
  raw_json JSON NULL,
  amount_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  accruals_for_sale_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  sale_commission_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  delivery_charge_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  return_delivery_charge_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  exchange_rate DECIMAL(18,4) NOT NULL DEFAULT 0,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_finance_shop_operation_service (shop_id, operation_id, service_type),
  KEY idx_finance_posting (shop_id, posting_number),
  KEY idx_finance_operation_date (operation_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### Snapshot and log tables

Apply the same rules:

- analytics tables: composite primary keys remain
- log tables: `BIGINT UNSIGNED AUTO_INCREMENT`
- cache tables: string primary or composite primary keys stay unchanged
- payload fields: `JSON` when structured, else `TEXT`

## 6. Foreign Key Direction

Recommended rule:

- keep foreign keys for master-data consistency
- avoid overly aggressive cascading on hot transactional chains unless already semantically required

Recommended cascades:

- `order_items.order_id -> orders.id`: `ON DELETE CASCADE`
- `order_profit_items.order_item_id -> order_items.id`: `ON DELETE CASCADE`
- `purchase_order_items.purchase_order_id -> purchase_orders.id`: `ON DELETE CASCADE`

Recommended non-cascade links:

- most `shop_id`, `product_id`, `person_id` references
- operational history should survive soft delete semantics in application code

## 7. Migration Notes

Recommended migration order:

1. `shops`
2. `people`
3. `suppliers`
4. `products`
5. `online_products`
6. `sku_mappings`
7. `exchange_rates`
8. `procurement_requests`
9. `purchase_orders`
10. `purchase_order_items`
11. `inbound_records`
12. `outbound_records`
13. `inventory_movements`
14. `inventory_current`
15. `orders`
16. `order_items`
17. `order_profit_items`
18. `ozon_orders_raw`
19. `ozon_finance_items`
20. support tables and logs
21. analytics snapshots last, or rebuild after import

Recommended initial dry-run shortcut:

- migrate operational source-of-truth tables first
- skip analytics snapshot import if rebuild cost is acceptable
- rebuild snapshots after import and compare aggregates

## 8. Immediate Next Files

This draft should be followed by:

- a SQLite export script
- a MySQL import script
- a row-count and aggregate verification script
