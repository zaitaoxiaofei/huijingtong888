import { createMysqlConnection, closeMysqlConnection } from "./mysql-runtime.mjs";

const mysqlSchemaSql = `
CREATE TABLE IF NOT EXISTS shops (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  legal_entity VARCHAR(255) NULL,
  ozon_client_id VARCHAR(128) NULL,
  api_key_hint VARCHAR(255) NULL,
  performance_client_id VARCHAR(128) NULL,
  performance_client_secret TEXT NULL,
  performance_client_secret_hint VARCHAR(255) NULL,
  watermark_path TEXT NULL,
  watermark_name VARCHAR(255) NULL,
  watermark_position VARCHAR(32) NOT NULL DEFAULT 'bottom-right',
  watermark_x_percent DECIMAL(8,4) NOT NULL DEFAULT 75.0000,
  watermark_y_percent DECIMAL(8,4) NOT NULL DEFAULT 75.0000,
  watermark_scale_percent DECIMAL(8,4) NOT NULL DEFAULT 22.0000,
  watermark_opacity_percent DECIMAL(8,4) NOT NULL DEFAULT 82.0000,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  payout_rate DECIMAL(8,4) NOT NULL DEFAULT 0.3300,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS people (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  username VARCHAR(255) NULL,
  role VARCHAR(64) NOT NULL DEFAULT 'operator',
  avatar_url TEXT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  password_hash TEXT NULL,
  UNIQUE KEY uk_people_name (name),
  UNIQUE KEY uk_people_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS suppliers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_person VARCHAR(255) NULL,
  contact_phone VARCHAR(255) NULL,
  wechat_id VARCHAR(255) NULL,
  business_note TEXT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS system_settings (
  \`key\` VARCHAR(191) NOT NULL PRIMARY KEY,
  value_json LONGTEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS system_setting_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(191) NOT NULL,
  old_value_json LONGTEXT NULL,
  new_value_json LONGTEXT NOT NULL,
  updated_by_person_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS exchange_rates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  currency_from VARCHAR(16) NOT NULL DEFAULT 'CNY',
  currency_to VARCHAR(16) NOT NULL DEFAULT 'RUB',
  rate DECIMAL(18,4) NOT NULL,
  source VARCHAR(64) NOT NULL DEFAULT 'manual',
  effective_date VARCHAR(32) NOT NULL,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  selection_id VARCHAR(128) NULL,
  code VARCHAR(128) NULL,
  name VARCHAR(255) NOT NULL,
  image_url LONGTEXT NULL,
  detail_image_urls LONGTEXT NULL,
  material VARCHAR(255) NULL,
  color VARCHAR(255) NULL,
  selling_points TEXT NULL,
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
  supplier_id BIGINT UNSIGNED NULL,
  UNIQUE KEY uk_products_selection_id (selection_id),
  UNIQUE KEY uk_products_code (code),
  KEY idx_products_owner (owner_person_id),
  KEY idx_products_parent (parent_product_id),
  KEY idx_products_active_id (active, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS online_products (
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
  images_json LONGTEXT NULL,
  barcodes_json LONGTEXT NULL,
  stocks_json LONGTEXT NULL,
  commissions_json LONGTEXT NULL,
  attributes_json LONGTEXT NULL,
  raw_json LONGTEXT NULL,
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

CREATE TABLE IF NOT EXISTS sku_mappings (
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
  KEY idx_sku_mappings_shop_sku_active (shop_id, ozon_sku, active),
  KEY idx_sku_mappings_shop_offer_active (shop_id, offer_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS procurement_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  person_id BIGINT UNSIGNED NULL,
  quantity INT NOT NULL,
  amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  shipping_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  purchase_url TEXT NULL,
  source_type VARCHAR(64) NOT NULL DEFAULT '1688',
  supplier_id BIGINT UNSIGNED NULL,
  approval_status VARCHAR(32) NOT NULL DEFAULT 'draft',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  needed_by VARCHAR(64) NULL,
  note TEXT NULL,
  purchase_order_id BIGINT UNSIGNED NULL,
  source_order_id BIGINT UNSIGNED NULL,
  source_order_item_id BIGINT UNSIGNED NULL,
  source_ozon_sku VARCHAR(128) NULL,
  merged_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  urgency VARCHAR(32) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_procurement_status (status, purchase_order_id),
  KEY idx_procurement_status_created (status, created_at),
  KEY idx_procurement_product_status (product_id, status),
  KEY idx_procurement_source_order_item (source_order_item_id),
  KEY idx_procurement_source_order (source_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(128) NOT NULL,
  created_by_person_id BIGINT UNSIGNED NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending_purchase',
  total_quantity INT NOT NULL DEFAULT 0,
  total_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  purchased_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  UNIQUE KEY uk_purchase_orders_order_no (order_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  requested_quantity INT NOT NULL DEFAULT 0,
  actual_quantity INT NOT NULL DEFAULT 0,
  unit_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  shipping_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  purchase_url TEXT NULL,
  inbound_quantity INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'pending_purchase',
  note TEXT NULL,
  KEY idx_purchase_order_items_order (purchase_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_item_procurement_marks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_item_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'handled',
  handling_type VARCHAR(32) NOT NULL DEFAULT 'procurement_request',
  note TEXT NULL,
  created_by_person_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order_item_procurement_marks_item (order_item_id),
  KEY idx_order_item_procurement_marks_order (order_id),
  KEY idx_order_item_procurement_marks_product (product_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS inbound_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  person_id BIGINT UNSIGNED NULL,
  quantity INT NOT NULL,
  amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  unit_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  shipping_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  purchase_url TEXT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending_arrival',
  note TEXT NULL,
  purchase_order_id BIGINT UNSIGNED NULL,
  purchase_order_item_id BIGINT UNSIGNED NULL,
  qc_status VARCHAR(32) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME NULL,
  KEY idx_inbound_purchase_item (purchase_order_item_id, status),
  KEY idx_inbound_product_status (product_id, status),
  KEY idx_inbound_status_created (status, created_at),
  KEY idx_inbound_product_purchase (product_id, purchase_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS outbound_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  shop_id BIGINT UNSIGNED NULL,
  online_product_id BIGINT UNSIGNED NULL,
  order_ref VARCHAR(128) NULL,
  order_item_id BIGINT UNSIGNED NULL,
  ozon_sku VARCHAR(128) NULL,
  person_id BIGINT UNSIGNED NULL,
  quantity INT NOT NULL,
  reason VARCHAR(64) NOT NULL DEFAULT 'order',
  status VARCHAR(32) NOT NULL DEFAULT 'deducted',
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_outbound_order_item (order_item_id),
  KEY idx_outbound_order_sku (order_ref, product_id, ozon_sku),
  KEY idx_outbound_status_created (status, created_at),
  KEY idx_outbound_shop_created (shop_id, created_at),
  KEY idx_outbound_created (created_at, id),
  KEY idx_outbound_order_ref (order_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  shop_id BIGINT UNSIGNED NULL,
  sku_mapping_id BIGINT UNSIGNED NULL,
  owner_person_id BIGINT UNSIGNED NULL,
  source_type VARCHAR(64) NOT NULL,
  source_ref VARCHAR(255) NULL,
  quantity_delta INT NOT NULL,
  unit_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  movement_type VARCHAR(64) NULL,
  related_posting_number VARCHAR(128) NULL,
  related_order_item_id BIGINT UNSIGNED NULL,
  operator VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'posted',
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_inventory_product_status (product_id, status),
  KEY idx_inventory_related_order_item (related_order_item_id),
  KEY idx_inventory_source_ref (source_type, source_ref(128)),
  KEY idx_inventory_related_posting (related_posting_number, product_id, source_type, status),
  KEY idx_inventory_created (created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS inventory_current (
  real_product_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  available_stock INT NOT NULL DEFAULT 0,
  reserved_stock INT NOT NULL DEFAULT 0,
  damaged_stock INT NOT NULL DEFAULT 0,
  in_transit_stock INT NOT NULL DEFAULT 0,
  last_updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS orders (
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
  KEY idx_orders_shop_status_ordered_at (shop_id, status, ordered_at),
  KEY idx_orders_ordered_at (ordered_at, id),
  KEY idx_orders_stage_ordered_at (tracking_stage, ordered_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_items (
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
  KEY idx_order_items_sku_order (ozon_sku, order_id),
  KEY idx_order_items_mapping (sku_mapping_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_status_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  posting_number VARCHAR(128) NOT NULL,
  order_number VARCHAR(128) NULL,
  status VARCHAR(64) NOT NULL,
  substatus VARCHAR(128) NULL,
  logistics_status VARCHAR(64) NOT NULL DEFAULT '',
  tracking_stage VARCHAR(64) NOT NULL DEFAULT '',
  sync_state VARCHAR(32) NOT NULL DEFAULT '',
  ordered_at DATETIME NULL,
  delivered_at DATETIME NULL,
  last_status_changed_at DATETIME NULL,
  customer_id VARCHAR(128) NULL,
  customer_name VARCHAR(255) NULL,
  buyer_city VARCHAR(255) NULL,
  buyer_region VARCHAR(255) NULL,
  buyer_country VARCHAR(255) NULL,
  buyer_district VARCHAR(255) NULL,
  buyer_zip_code VARCHAR(64) NULL,
  buyer_address_tail VARCHAR(512) NULL,
  delivery_type VARCHAR(128) NULL,
  delivery_city VARCHAR(255) NULL,
  delivery_region VARCHAR(255) NULL,
  delivery_date_begin DATETIME NULL,
  delivery_date_end DATETIME NULL,
  warehouse_name VARCHAR(255) NULL,
  tpl_provider VARCHAR(255) NULL,
  cluster_to VARCHAR(255) NULL,
  snapshot_source VARCHAR(32) NOT NULL DEFAULT 'sync',
  observed_at DATETIME NOT NULL,
  observed_hour DATETIME NOT NULL,
  raw_status_json LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order_status_history_hour_state (order_id, observed_hour, status, logistics_status, tracking_stage, sync_state),
  KEY idx_order_status_history_order_time (order_id, observed_at DESC),
  KEY idx_order_status_history_shop_time (shop_id, observed_at DESC),
  KEY idx_order_status_history_status_time (status, observed_at DESC),
  KEY idx_order_status_history_region_time (buyer_region, buyer_city, observed_at DESC),
  KEY idx_order_status_history_delivery_window (delivery_date_begin, delivery_date_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_profit_items (
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

CREATE TABLE IF NOT EXISTS ozon_orders_raw (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_id BIGINT UNSIGNED NOT NULL,
  posting_number VARCHAR(128) NOT NULL,
  order_id VARCHAR(128) NULL,
  status VARCHAR(64) NULL,
  substatus VARCHAR(128) NULL,
  raw_json LONGTEXT NOT NULL,
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ozon_orders_raw_store_posting (store_id, posting_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS ozon_finance_items (
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
  raw_json LONGTEXT NULL,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  amount_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  accruals_for_sale_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  sale_commission_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  delivery_charge_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  return_delivery_charge_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  exchange_rate DECIMAL(18,4) NOT NULL DEFAULT 0,
  UNIQUE KEY uk_finance_shop_operation_service (shop_id, operation_id, service_type),
  KEY idx_finance_posting (shop_id, posting_number),
  KEY idx_finance_operation_date (operation_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS analytics_shop_daily (
  date_key VARCHAR(32) NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  order_count INT NOT NULL DEFAULT 0,
  item_quantity INT NOT NULL DEFAULT 0,
  revenue DECIMAL(18,4) NOT NULL DEFAULT 0,
  estimated_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  confirmed_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  current_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  cancelled_orders INT NOT NULL DEFAULT 0,
  cancelled_revenue DECIMAL(18,4) NOT NULL DEFAULT 0,
  return_orders INT NOT NULL DEFAULT 0,
  return_quantity INT NOT NULL DEFAULT 0,
  return_revenue DECIMAL(18,4) NOT NULL DEFAULT 0,
  refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (date_key, shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS analytics_product_profit_daily (
  date_key VARCHAR(32) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  order_count INT NOT NULL DEFAULT 0,
  item_quantity INT NOT NULL DEFAULT 0,
  revenue DECIMAL(18,4) NOT NULL DEFAULT 0,
  estimated_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  confirmed_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  current_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (date_key, product_id, shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS analytics_sku_profit_daily (
  date_key VARCHAR(32) NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  ozon_sku VARCHAR(128) NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  order_count INT NOT NULL DEFAULT 0,
  item_quantity INT NOT NULL DEFAULT 0,
  revenue DECIMAL(18,4) NOT NULL DEFAULT 0,
  estimated_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  confirmed_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  current_profit DECIMAL(18,4) NOT NULL DEFAULT 0,
  cancelled_orders INT NOT NULL DEFAULT 0,
  cancelled_quantity INT NOT NULL DEFAULT 0,
  cancelled_revenue DECIMAL(18,4) NOT NULL DEFAULT 0,
  return_orders INT NOT NULL DEFAULT 0,
  return_quantity INT NOT NULL DEFAULT 0,
  return_revenue DECIMAL(18,4) NOT NULL DEFAULT 0,
  refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (date_key, shop_id, ozon_sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS ozon_ad_sku_daily (
  date_key VARCHAR(32) NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  ozon_sku VARCHAR(128) NOT NULL,
  campaign_id VARCHAR(128) NOT NULL DEFAULT '',
  campaign_name VARCHAR(255) NULL,
  ad_type VARCHAR(64) NOT NULL DEFAULT 'unknown',
  product_id BIGINT UNSIGNED NULL,
  offer_id VARCHAR(255) NULL,
  product_name VARCHAR(255) NULL,
  spend_rub DECIMAL(18,4) NOT NULL DEFAULT 0,
  spend_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  impressions INT NOT NULL DEFAULT 0,
  clicks INT NOT NULL DEFAULT 0,
  orders INT NOT NULL DEFAULT 0,
  units INT NOT NULL DEFAULT 0,
  revenue_rub DECIMAL(18,4) NOT NULL DEFAULT 0,
  revenue_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  source VARCHAR(64) NOT NULL DEFAULT 'manual',
  raw_json LONGTEXT NULL,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (date_key, shop_id, ozon_sku, campaign_id, ad_type),
  KEY idx_ozon_ad_sku_daily_shop_date (shop_id, date_key),
  KEY idx_ozon_ad_sku_daily_sku_date (shop_id, ozon_sku, date_key),
  KEY idx_ozon_ad_sku_daily_product (product_id, date_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS analytics_cache (
  cache_type VARCHAR(128) NOT NULL,
  cache_key VARCHAR(191) NOT NULL,
  payload LONGTEXT NOT NULL,
  refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cache_type, cache_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_profit_detail_snapshots (
  order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  shop_id BIGINT UNSIGNED NOT NULL,
  posting_number VARCHAR(128) NOT NULL,
  order_status VARCHAR(64) NULL,
  outcome_type VARCHAR(64) NULL,
  sale_amount_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  estimated_profit_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  estimated_cost_total_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  actual_profit_cny DECIMAL(18,4) NULL,
  actual_profit_rate DECIMAL(18,6) NULL,
  actual_cost_total_cny DECIMAL(18,4) NULL,
  finance_match_status VARCHAR(32) NOT NULL DEFAULT 'unmatched',
  finance_rows INT NOT NULL DEFAULT 0,
  actual_profit_ready TINYINT(1) NOT NULL DEFAULT 0,
  summary_json LONGTEXT NOT NULL,
  detail_rows_json LONGTEXT NOT NULL,
  finance_totals_json LONGTEXT NOT NULL,
  refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_updated_at DATETIME NULL,
  KEY idx_order_profit_detail_snapshots_posting (shop_id, posting_number),
  KEY idx_order_profit_detail_snapshots_status (finance_match_status, refreshed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_exceptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_id BIGINT UNSIGNED NULL,
  order_item_id BIGINT UNSIGNED NULL,
  posting_number VARCHAR(128) NULL,
  ozon_sku VARCHAR(128) NULL,
  exception_type VARCHAR(128) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  UNIQUE KEY uk_order_exceptions_scope (store_id, posting_number, ozon_sku, exception_type),
  KEY idx_order_exceptions_status (status, exception_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS exception_task_states (
  task_id VARCHAR(191) NOT NULL PRIMARY KEY,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  note TEXT NULL,
  updated_by_person_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_exception_task_states_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS historical_profit_reviews (
  order_item_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  review_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  note TEXT NULL,
  updated_by_person_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS online_product_actions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  online_product_id BIGINT UNSIGNED NULL,
  shop_id BIGINT UNSIGNED NULL,
  action_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  request_json LONGTEXT NULL,
  response_json LONGTEXT NULL,
  error_message TEXT NULL,
  created_by_person_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_online_product_actions_product (online_product_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_marks (
  order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  mark_type VARCHAR(64) NOT NULL DEFAULT '',
  note TEXT NULL,
  updated_by_person_id BIGINT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_order_marks_type_order (mark_type, order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_label_prints (
  order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  printed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  print_batch_id VARCHAR(64) NULL,
  print_sequence INT NULL,
  printed_by_person_id BIGINT UNSIGNED NULL,
  KEY idx_order_label_prints_printed (printed_at, order_id),
  KEY idx_order_label_prints_sequence (printed_at, print_batch_id, print_sequence, order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_package_label_cache (
  order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  shop_id BIGINT UNSIGNED NOT NULL,
  posting_number VARCHAR(128) NOT NULL,
  label_pdf LONGBLOB NOT NULL,
  label_size INT NOT NULL DEFAULT 0,
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fetch_source VARCHAR(32) NOT NULL DEFAULT 'ozon',
  KEY idx_order_package_label_cache_posting (shop_id, posting_number),
  KEY idx_order_package_label_cache_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_quality_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  prefix VARCHAR(128) NOT NULL,
  label VARCHAR(255) NOT NULL DEFAULT '',
  note TEXT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order_quality_rules_prefix (prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sync_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token VARCHAR(191) NOT NULL PRIMARY KEY,
  person_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(64) NOT NULL,
  username VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS logistics_fee_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  carrier VARCHAR(64) NOT NULL DEFAULT 'CEL',
  channel VARCHAR(64) NOT NULL DEFAULT 'standard',
  mode VARCHAR(64) NOT NULL DEFAULT 'per_gram',
  min_weight_g DECIMAL(18,4) NOT NULL DEFAULT 0,
  max_weight_g DECIMAL(18,4) NOT NULL DEFAULT 999999,
  min_price_rub DECIMAL(18,4) NOT NULL DEFAULT 0,
  max_price_rub DECIMAL(18,4) NOT NULL DEFAULT 999999999,
  base_fee_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  per_gram_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  per_ticket_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  filter_keywords TEXT NULL,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS ozon_stock_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT UNSIGNED NOT NULL,
  online_product_id BIGINT UNSIGNED NULL,
  product_id BIGINT UNSIGNED NULL,
  ozon_product_id VARCHAR(128) NULL,
  ozon_sku VARCHAR(128) NOT NULL,
  offer_id VARCHAR(255) NULL,
  warehouse_id VARCHAR(128) NULL,
  warehouse_name VARCHAR(255) NULL,
  stock_type VARCHAR(64) NOT NULL DEFAULT 'unknown',
  present INT NOT NULL DEFAULT 0,
  reserved INT NOT NULL DEFAULT 0,
  available INT NOT NULL DEFAULT 0,
  raw_json LONGTEXT NULL,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_stock_snapshot_scope (shop_id, ozon_sku, warehouse_id, stock_type),
  KEY idx_ozon_stock_sku (shop_id, ozon_sku, stock_type),
  KEY idx_ozon_stock_sku_type (shop_id, ozon_sku, stock_type),
  KEY idx_ozon_stock_product (product_id, synced_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS stock_warehouse_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  pattern VARCHAR(191) NOT NULL,
  stock_type VARCHAR(64) NOT NULL DEFAULT 'unknown',
  priority INT NOT NULL DEFAULT 100,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_stock_warehouse_rules_pattern (pattern),
  KEY idx_stock_warehouse_rules (enabled, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_cancellation_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  match_text TEXT NOT NULL,
  match_mode VARCHAR(64) NOT NULL DEFAULT 'contains',
  initiator_label VARCHAR(255) NOT NULL DEFAULT '',
  reason_label VARCHAR(255) NOT NULL DEFAULT '',
  reason_code VARCHAR(128) NOT NULL DEFAULT 'other',
  reason_group_label VARCHAR(255) NOT NULL DEFAULT '',
  accounting_hint TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_order_cancellation_rules_enabled (enabled, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

const connection = await createMysqlConnection();

try {
  await connection.query(mysqlSchemaSql);
  const alterStatements = [
    "ALTER TABLE shops ADD COLUMN watermark_path TEXT NULL",
    "ALTER TABLE shops ADD COLUMN watermark_name VARCHAR(255) NULL",
    "ALTER TABLE shops ADD COLUMN watermark_position VARCHAR(32) NOT NULL DEFAULT 'bottom-right'",
    "ALTER TABLE shops ADD COLUMN watermark_x_percent DECIMAL(8,4) NOT NULL DEFAULT 75.0000",
    "ALTER TABLE shops ADD COLUMN watermark_y_percent DECIMAL(8,4) NOT NULL DEFAULT 75.0000",
    "ALTER TABLE shops ADD COLUMN watermark_scale_percent DECIMAL(8,4) NOT NULL DEFAULT 22.0000",
    "ALTER TABLE shops ADD COLUMN watermark_opacity_percent DECIMAL(8,4) NOT NULL DEFAULT 82.0000",
    "ALTER TABLE people ADD COLUMN password_hash TEXT NULL",
    "ALTER TABLE products ADD COLUMN supplier_id BIGINT UNSIGNED NULL",
    "ALTER TABLE procurement_requests ADD COLUMN cancelled_at DATETIME NULL",
    "ALTER TABLE inventory_movements ADD COLUMN movement_type VARCHAR(64) NULL",
    "ALTER TABLE inventory_movements ADD COLUMN operator VARCHAR(255) NULL",
    "ALTER TABLE order_label_prints ADD COLUMN print_batch_id VARCHAR(64) NULL",
    "ALTER TABLE order_label_prints ADD COLUMN print_sequence INT NULL"
  ];
  for (const sql of alterStatements) {
    try {
      await connection.query(sql);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    }
  }
  const modifyStatements = [
    "ALTER TABLE products MODIFY COLUMN image_url LONGTEXT NULL"
  ];
  for (const sql of modifyStatements) {
    await connection.query(sql);
  }
  const indexStatements = [
    "CREATE INDEX idx_outbound_shop_created ON outbound_records (shop_id, created_at)",
    "CREATE INDEX idx_order_label_prints_sequence ON order_label_prints (printed_at, print_batch_id, print_sequence, order_id)"
  ];
  for (const sql of indexStatements) {
    try {
      await connection.query(sql);
    } catch (error) {
      if (error?.code !== "ER_DUP_KEYNAME") throw error;
    }
  }
  console.log("MySQL schema initialization completed.");
} finally {
  await closeMysqlConnection(connection);
}
