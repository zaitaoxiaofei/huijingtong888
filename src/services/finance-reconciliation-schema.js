export const FINANCE_CALIBRATION_SCHEMA = `CREATE TABLE IF NOT EXISTS finance_reconciliation_adjustments (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 tenant_id BIGINT UNSIGNED NOT NULL, company_id BIGINT UNSIGNED NOT NULL, shop_id BIGINT UNSIGNED NOT NULL,
 month_key CHAR(7) NOT NULL, row_key CHAR(64) NOT NULL, confirmation_key CHAR(64) NOT NULL,
 previous_id BIGINT UNSIGNED NULL, posting_number VARCHAR(128) NOT NULL, sku VARCHAR(64) NOT NULL,
 before_json JSON NOT NULL, after_json JSON NOT NULL, sources_json JSON NOT NULL,
 reason VARCHAR(1000) NOT NULL, created_by BIGINT UNSIGNED NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uk_finance_calibration (tenant_id,company_id,shop_id,month_key,row_key,confirmation_key),
 KEY idx_finance_calibration_period (tenant_id,company_id,shop_id,month_key,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
