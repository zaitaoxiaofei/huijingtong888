export const OZON_RETURN_SCHEMA = `CREATE TABLE IF NOT EXISTS ozon_return_observations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NULL,
  source_endpoint VARCHAR(64) NOT NULL,
  return_id VARCHAR(64) NOT NULL,
  posting_number VARCHAR(128) NOT NULL,
  official_state VARCHAR(128) NOT NULL,
  state_json JSON NOT NULL,
  request_created_at DATETIME NULL,
  observed_at DATETIME NOT NULL,
  UNIQUE KEY uk_ozon_return_source (tenant_id,shop_id,source_endpoint,return_id),
  KEY idx_ozon_return_order (tenant_id,order_id),
  KEY idx_ozon_return_posting (tenant_id,shop_id,posting_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ozon_return_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  observation_id BIGINT UNSIGNED NOT NULL,
  official_state VARCHAR(128) NOT NULL,
  state_json JSON NOT NULL,
  observed_at DATETIME NOT NULL,
  KEY idx_ozon_return_history (tenant_id,observation_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
