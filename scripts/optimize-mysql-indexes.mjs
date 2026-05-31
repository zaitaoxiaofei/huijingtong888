import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { config } from "../src/config.js";

const tableDefinitions = [
  [`CREATE TABLE IF NOT EXISTS order_status_history (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, "order_status_history"]
];

const indexDefinitions = [
  ["orders", "idx_orders_shop_ordered_at", "CREATE INDEX idx_orders_shop_ordered_at ON orders (shop_id, ordered_at DESC, id DESC)"],
  ["orders", "idx_orders_status_ordered_desc", "CREATE INDEX idx_orders_status_ordered_desc ON orders (status, ordered_at DESC, id DESC)"],
  ["orders", "idx_orders_tracking_ordered_desc", "CREATE INDEX idx_orders_tracking_ordered_desc ON orders (tracking_stage, ordered_at DESC, id DESC)"],
  ["orders", "idx_orders_sync_state_synced", "CREATE INDEX idx_orders_sync_state_synced ON orders (sync_state, last_synced_at DESC, ordered_at DESC)"],
  ["order_status_history", "idx_order_status_history_order_time", "CREATE INDEX idx_order_status_history_order_time ON order_status_history (order_id, observed_at DESC)"],
  ["order_status_history", "idx_order_status_history_shop_time", "CREATE INDEX idx_order_status_history_shop_time ON order_status_history (shop_id, observed_at DESC)"],
  ["order_status_history", "idx_order_status_history_status_time", "CREATE INDEX idx_order_status_history_status_time ON order_status_history (status, observed_at DESC)"],
  ["order_status_history", "idx_order_status_history_region_time", "CREATE INDEX idx_order_status_history_region_time ON order_status_history (buyer_region, buyer_city, observed_at DESC)"],
  ["order_status_history", "idx_order_status_history_delivery_window", "CREATE INDEX idx_order_status_history_delivery_window ON order_status_history (delivery_date_begin, delivery_date_end)"],
  ["order_items", "idx_order_items_order_mapping", "CREATE INDEX idx_order_items_order_mapping ON order_items (order_id, sku_mapping_id)"],
  ["order_items", "idx_order_items_order_profit", "CREATE INDEX idx_order_items_order_profit ON order_items (order_id, settlement_state)"],
  ["order_marks", "idx_order_marks_order_type", "CREATE INDEX idx_order_marks_order_type ON order_marks (order_id, mark_type)"],
  ["order_label_prints", "idx_order_label_prints_order_printed", "CREATE INDEX idx_order_label_prints_order_printed ON order_label_prints (order_id, printed_at DESC)"],
  ["ozon_orders_raw", "idx_raw_orders_store_posting", "CREATE INDEX idx_raw_orders_store_posting ON ozon_orders_raw (store_id, posting_number)"],
  ["ozon_stock_snapshots", "idx_ozon_stock_sku_synced", "CREATE INDEX idx_ozon_stock_sku_synced ON ozon_stock_snapshots (shop_id, ozon_sku, stock_type, synced_at DESC)"],
  ["inbound_records", "idx_inbound_product_purchase", "CREATE INDEX idx_inbound_product_purchase ON inbound_records (product_id, purchase_order_id)"],
  ["exchange_rates", "idx_exchange_rates_pair_date", "CREATE INDEX idx_exchange_rates_pair_date ON exchange_rates (currency_from, currency_to, effective_date DESC, id DESC)"],
  ["historical_profit_reviews", "idx_historical_profit_reviews_status", "CREATE INDEX idx_historical_profit_reviews_status ON historical_profit_reviews (review_status, updated_at DESC)"],
  ["products", "idx_products_selection_list", "CREATE INDEX idx_products_selection_list ON products (active, product_type, selection_status, updated_at DESC, id DESC)"],
  ["products", "idx_products_selection_owner", "CREATE INDEX idx_products_selection_owner ON products (owner_person_id, active, product_type, selection_status)"],
  ["asset_variant_jobs", "idx_asset_variant_jobs_product_type_id", "CREATE INDEX idx_asset_variant_jobs_product_type_id ON asset_variant_jobs (product_id, job_type, id)"],
  ["ozon_stock_snapshots", "idx_ozon_stock_sku_synced_desc", "CREATE INDEX idx_ozon_stock_sku_synced_desc ON ozon_stock_snapshots (shop_id, ozon_sku, stock_type, synced_at DESC)"],
  ["order_items", "idx_order_items_sku_order_qty", "CREATE INDEX idx_order_items_sku_order_qty ON order_items (ozon_sku, order_id, quantity)"],
  ["orders", "idx_orders_status_stage_shop_ordered", "CREATE INDEX idx_orders_status_stage_shop_ordered ON orders (status, tracking_stage, shop_id, ordered_at)"],
  ["ozon_orders_raw", "idx_raw_orders_store_posting_id", "CREATE INDEX idx_raw_orders_store_posting_id ON ozon_orders_raw (store_id, posting_number, id)"]
];

async function indexExists(tableName, indexName) {
  const rows = await mysqlQuery(`
    SELECT 1
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = ?
      AND INDEX_NAME = ?
    LIMIT 1
  `, [config.dbName, tableName, indexName]);
  return rows.length > 0;
}

try {
  const results = [];
  for (const [sql, tableName] of tableDefinitions) {
    await mysqlQuery(sql);
    results.push({ table: tableName, index: "(table)", status: "ready" });
  }
  for (const [tableName, indexName, sql] of indexDefinitions) {
    if (await indexExists(tableName, indexName)) {
      results.push({ table: tableName, index: indexName, status: "exists" });
      continue;
    }
    await mysqlQuery(sql);
    results.push({ table: tableName, index: indexName, status: "created" });
  }
  console.table(results);
} finally {
  await closeMysqlPool();
}
