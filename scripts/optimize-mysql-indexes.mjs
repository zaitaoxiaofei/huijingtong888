import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { config } from "../src/config.js";

const dropRedundant = process.argv.includes("--drop-redundant");

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
  ["order_status_history", "idx_order_status_history_order_id", "CREATE INDEX idx_order_status_history_order_id ON order_status_history (order_id, id DESC)"],
  ["order_status_history", "idx_order_status_history_shop_time", "CREATE INDEX idx_order_status_history_shop_time ON order_status_history (shop_id, observed_at DESC)"],
  ["order_status_history", "idx_order_status_history_status_time", "CREATE INDEX idx_order_status_history_status_time ON order_status_history (status, observed_at DESC)"],
  ["order_status_history", "idx_order_status_history_region_time", "CREATE INDEX idx_order_status_history_region_time ON order_status_history (buyer_region, buyer_city, observed_at DESC)"],
  ["order_status_history", "idx_order_status_history_delivery_window", "CREATE INDEX idx_order_status_history_delivery_window ON order_status_history (delivery_date_begin, delivery_date_end)"],
  ["order_items", "idx_order_items_order_mapping", "CREATE INDEX idx_order_items_order_mapping ON order_items (order_id, sku_mapping_id)"],
  ["order_items", "idx_order_items_order_profit", "CREATE INDEX idx_order_items_order_profit ON order_items (order_id, settlement_state)"],
  ["order_profit_items", "idx_order_profit_items_item_status", "CREATE INDEX idx_order_profit_items_item_status ON order_profit_items (order_item_id, profit_status, updated_at)"],
  ["order_marks", "idx_order_marks_order_type", "CREATE INDEX idx_order_marks_order_type ON order_marks (order_id, mark_type)"],
  ["order_label_prints", "idx_order_label_prints_order_printed", "CREATE INDEX idx_order_label_prints_order_printed ON order_label_prints (order_id, printed_at DESC)"],
  ["ozon_orders_raw", "idx_raw_orders_store_posting", "CREATE INDEX idx_raw_orders_store_posting ON ozon_orders_raw (store_id, posting_number)"],
  ["ozon_stock_snapshots", "idx_ozon_stock_sku_synced", "CREATE INDEX idx_ozon_stock_sku_synced ON ozon_stock_snapshots (shop_id, ozon_sku, stock_type, synced_at DESC)"],
  ["inbound_records", "idx_inbound_product_purchase", "CREATE INDEX idx_inbound_product_purchase ON inbound_records (product_id, purchase_order_id)"],
  ["inventory_movements", "idx_inventory_product_location_status_created", "CREATE INDEX idx_inventory_product_location_status_created ON inventory_movements (product_id, stock_location, status, created_at)"],
  ["sku_mappings", "idx_sku_mappings_sku_active_product", "CREATE INDEX idx_sku_mappings_sku_active_product ON sku_mappings (ozon_sku, active, product_id)"],
  ["sku_mappings", "idx_sku_mappings_offer_active_product", "CREATE INDEX idx_sku_mappings_offer_active_product ON sku_mappings (offer_id, active, product_id)"],
  ["outbound_records", "idx_outbound_product_status_item", "CREATE INDEX idx_outbound_product_status_item ON outbound_records (product_id, status, order_item_id)"],
  ["inbound_records", "idx_inbound_product_status", "CREATE INDEX idx_inbound_product_status ON inbound_records (product_id, status)"],
  ["fbp_transfer_records", "idx_fbp_transfer_product_status", "CREATE INDEX idx_fbp_transfer_product_status ON fbp_transfer_records (product_id, status)"],
  ["exchange_rates", "idx_exchange_rates_pair_date", "CREATE INDEX idx_exchange_rates_pair_date ON exchange_rates (currency_from, currency_to, effective_date DESC, id DESC)"],
  ["historical_profit_reviews", "idx_historical_profit_reviews_status", "CREATE INDEX idx_historical_profit_reviews_status ON historical_profit_reviews (review_status, updated_at DESC)"],
  ["products", "idx_products_selection_list", "CREATE INDEX idx_products_selection_list ON products (active, product_type, selection_status, updated_at DESC, id DESC)"],
  ["products", "idx_products_selection_owner", "CREATE INDEX idx_products_selection_owner ON products (owner_person_id, active, product_type, selection_status)"],
  ["asset_variant_jobs", "idx_asset_variant_jobs_product_type_id", "CREATE INDEX idx_asset_variant_jobs_product_type_id ON asset_variant_jobs (product_id, job_type, id)"],
  ["ozon_stock_snapshots", "idx_ozon_stock_sku_synced_desc", "CREATE INDEX idx_ozon_stock_sku_synced_desc ON ozon_stock_snapshots (shop_id, ozon_sku, stock_type, synced_at DESC)"],
  ["order_items", "idx_order_items_sku_order_qty", "CREATE INDEX idx_order_items_sku_order_qty ON order_items (ozon_sku, order_id, quantity)"],
  ["orders", "idx_orders_status_stage_shop_ordered", "CREATE INDEX idx_orders_status_stage_shop_ordered ON orders (status, tracking_stage, shop_id, ordered_at)"],
  ["ozon_orders_raw", "idx_raw_orders_store_posting_id", "CREATE INDEX idx_raw_orders_store_posting_id ON ozon_orders_raw (store_id, posting_number, id)"],
  ["online_products", "idx_online_products_shop_state_updated", "CREATE INDEX idx_online_products_shop_state_updated ON online_products (shop_id, archived, status, visibility, updated_at, id)"],
  ["procurement_requests", "idx_procurement_status_order_created_product", "CREATE INDEX idx_procurement_status_order_created_product ON procurement_requests (status, purchase_order_id, created_at, product_id)"],
  ["ozon_finance_items", "idx_finance_posting_date", "CREATE INDEX idx_finance_posting_date ON ozon_finance_items (shop_id, posting_number, operation_date)"],
  ["order_item_procurement_marks", "idx_order_item_procurement_marks_item_status", "CREATE INDEX idx_order_item_procurement_marks_item_status ON order_item_procurement_marks (order_item_id, status)"],
  ["ozon_plugin_collected_products", "idx_ozon_plugin_tenant_status_updated", "CREATE INDEX idx_ozon_plugin_tenant_status_updated ON ozon_plugin_collected_products (tenant_id, status, updated_at DESC)"]
];

const redundantIndexDefinitions = [
  ["ozon_stock_snapshots", "idx_ozon_stock_sku_type", "duplicate of idx_ozon_stock_sku"],
  ["ozon_stock_snapshots", "idx_ozon_stock_sku_synced_desc", "duplicate of idx_ozon_stock_sku_synced"],
  ["ozon_orders_raw", "idx_raw_orders_store_posting", "covered by idx_raw_orders_store_posting_id"],
  ["online_products", "idx_online_products_shop_sku", "covered by uk_online_products_shop_sku"]
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
  for (const [tableName, indexName, reason] of redundantIndexDefinitions) {
    if (!await indexExists(tableName, indexName)) continue;
    if (!dropRedundant) {
      results.push({ table: tableName, index: indexName, status: `redundant: ${reason}` });
      continue;
    }
    await mysqlQuery(`ALTER TABLE \`${tableName}\` DROP INDEX \`${indexName}\``);
    results.push({ table: tableName, index: indexName, status: `dropped: ${reason}` });
  }
  console.table(results);
} finally {
  await closeMysqlPool();
}
