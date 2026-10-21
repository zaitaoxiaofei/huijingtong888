export const ORDER_PROFIT_CALCULATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS order_profit_calc_state (
    tenant_key VARCHAR(128) NOT NULL,
    order_item_id BIGINT UNSIGNED NOT NULL,
    order_id BIGINT UNSIGNED NOT NULL,
    formula_version VARCHAR(32) NOT NULL DEFAULT 'V1',
    legacy_baseline TINYINT(1) NOT NULL DEFAULT 0,
    current_estimate_revision_id BIGINT UNSIGNED NULL,
    current_actual_revision_id BIGINT UNSIGNED NULL,
    revision_count INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_key, order_item_id),
    KEY idx_profit_calc_state_order (tenant_key, order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS order_profit_calc_revisions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_key VARCHAR(128) NOT NULL,
    order_item_id BIGINT UNSIGNED NOT NULL,
    order_id BIGINT UNSIGNED NOT NULL,
    revision_no INT UNSIGNED NOT NULL,
    layer VARCHAR(16) NOT NULL,
    formula_version VARCHAR(32) NOT NULL,
    legacy_baseline TINYINT(1) NOT NULL DEFAULT 0,
    input_completeness VARCHAR(32) NOT NULL DEFAULT 'complete',
    input_hash CHAR(64) NOT NULL,
    output_hash CHAR(64) NOT NULL,
    idempotency_key CHAR(64) NOT NULL,
    rate_version_json LONGTEXT NULL,
    cost_version_json LONGTEXT NULL,
    inputs_json LONGTEXT NOT NULL,
    outputs_json LONGTEXT NOT NULL,
    parent_revision_id BIGINT UNSIGNED NULL,
    source VARCHAR(64) NOT NULL,
    reason VARCHAR(1000) NOT NULL DEFAULT '',
    actor_id BIGINT UNSIGNED NULL,
    command_id VARCHAR(128) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_profit_calc_revision_no (tenant_key, order_item_id, revision_no),
    UNIQUE KEY uk_profit_calc_revision_key (tenant_key, order_item_id, layer, idempotency_key),
    KEY idx_profit_calc_revision_order (tenant_key, order_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];

// DDL must run before business transactions: MySQL DDL implicitly commits.
export async function createOrderProfitCalculationTables(connection) {
  for (const statement of ORDER_PROFIT_CALCULATION_SCHEMA) await connection.query(statement);
}
