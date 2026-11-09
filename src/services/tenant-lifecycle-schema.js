export const TENANT_PURGE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tenant_purge_audit (
    tenant_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    reason VARCHAR(32) NOT NULL, actor_person_id BIGINT UNSIGNED NULL,
    row_counts_json JSON NOT NULL, purged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS tenant_purge_files (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    kind VARCHAR(32) NOT NULL, storage_name VARCHAR(255) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'pending', last_error VARCHAR(500) NULL, last_attempt_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_tenant_purge_file (tenant_id, kind, storage_name), KEY idx_tenant_purge_pending (status,id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
