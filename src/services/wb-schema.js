export const WB_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS wb_shop_credentials (
    shop_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    token TEXT NOT NULL, environment VARCHAR(16) NOT NULL DEFAULT 'production', seller_id VARCHAR(128) NULL,
    handover_mode VARCHAR(32) NOT NULL DEFAULT 'unverified',
    local_warehouse_id BIGINT UNSIGNED NULL, wb_warehouse_id BIGINT UNSIGNED NULL,
    checked_at DATETIME NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_wb_credentials_tenant (tenant_id, shop_id), UNIQUE KEY uk_wb_seller_identity (tenant_id,environment,seller_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS wb_order_details (
    order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    shop_id BIGINT UNSIGNED NOT NULL, wb_order_id BIGINT UNSIGNED NOT NULL,
    supplier_status VARCHAR(40) NOT NULL DEFAULT '', wb_status VARCHAR(64) NOT NULL DEFAULT '',
    supply_id VARCHAR(128) NULL, handover_at DATETIME NULL, raw_json JSON NOT NULL, synced_at DATETIME NOT NULL,
    UNIQUE KEY uk_wb_order_shop (shop_id, wb_order_id), KEY idx_wb_orders_tenant (tenant_id, shop_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS wb_product_cards (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    shop_id BIGINT UNSIGNED NOT NULL, nm_id BIGINT UNSIGNED NOT NULL, vendor_code VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL DEFAULT '', raw_json JSON NOT NULL, synced_at DATETIME NOT NULL,
    UNIQUE KEY uk_wb_card_shop (shop_id, nm_id), KEY idx_wb_cards_tenant (tenant_id, shop_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS wb_supplies (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    shop_id BIGINT UNSIGNED NOT NULL, supply_id VARCHAR(128) NULL, operation_key VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL, order_ids_json JSON NOT NULL, last_error VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_wb_supply_operation (tenant_id, operation_key), UNIQUE KEY uk_wb_supply_shop (shop_id, supply_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
