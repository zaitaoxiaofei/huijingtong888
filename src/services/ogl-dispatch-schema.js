// All new workflow rows have explicit enterprise ownership, including defaults.
export const OGL_DISPATCH_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS ogl_dispatch_settings (
    tenant_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, default_shop_id BIGINT UNSIGNED NOT NULL,
    updated_by BIGINT UNSIGNED NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS ogl_dispatch_batches (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    batch_number VARCHAR(64) NOT NULL, client_request_id VARCHAR(128) NOT NULL,
    default_shop_id BIGINT UNSIGNED NOT NULL, containers_count INT UNSIGNED NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'preparing', note VARCHAR(1000) NOT NULL DEFAULT '',
    delivery_method_id VARCHAR(64) NULL, departure_date VARCHAR(64) NULL,
    official_carriage_id VARCHAR(64) NULL, official_status VARCHAR(32) NOT NULL DEFAULT 'not_created',
    official_result_json JSON NULL, official_operation_token VARCHAR(64) NULL,
    official_error VARCHAR(2000) NULL, last_refreshed_at DATETIME NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ogl_batch_request (tenant_id, client_request_id),
    UNIQUE KEY uk_ogl_batch_number (tenant_id, batch_number),
    UNIQUE KEY uk_ogl_official (tenant_id, default_shop_id, official_carriage_id),
    KEY idx_ogl_batch_tenant (tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS ogl_dispatch_members (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    batch_id BIGINT UNSIGNED NOT NULL, order_id BIGINT UNSIGNED NOT NULL,
    active_order_id BIGINT UNSIGNED NULL, shop_id BIGINT UNSIGNED NOT NULL,
    posting_number VARCHAR(128) NOT NULL, container_no INT UNSIGNED NULL,
    dispatched_at DATETIME NULL, dispatched_by BIGINT UNSIGNED NULL,
    withdrawn_at DATETIME NULL, withdrawn_by BIGINT UNSIGNED NULL,
    exception_code VARCHAR(64) NULL, exception_note VARCHAR(1000) NULL,
    official_member TINYINT(1) NOT NULL DEFAULT 0,
    last_synced_at DATETIME NULL, last_refresh_attempt_at DATETIME NULL, sync_error VARCHAR(2000) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ogl_active_order (tenant_id, active_order_id),
    UNIQUE KEY uk_ogl_batch_order (tenant_id, batch_id, order_id),
    KEY idx_ogl_member_batch (tenant_id, batch_id, id),
    KEY idx_ogl_member_order (order_id, tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS ogl_dispatch_official_locks (
    tenant_id BIGINT UNSIGNED NOT NULL, default_shop_id BIGINT UNSIGNED NOT NULL,
    delivery_method_id VARCHAR(64) NOT NULL, batch_id BIGINT UNSIGNED NOT NULL,
    operation_token VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, default_shop_id, delivery_method_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS ogl_dispatch_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    batch_id BIGINT UNSIGNED NOT NULL, member_id BIGINT UNSIGNED NULL,
    action VARCHAR(64) NOT NULL, reason VARCHAR(1000) NOT NULL DEFAULT '',
    detail_json JSON NULL, person_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_ogl_event_batch (tenant_id, batch_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];

export async function ensureOglDispatchSchema(execute) {
  const run = typeof execute === 'function' ? execute : (sql) => execute.query(sql);
  for (const sql of OGL_DISPATCH_SCHEMA_SQL) await run(sql);
}

export const ensureSchema = ensureOglDispatchSchema;
