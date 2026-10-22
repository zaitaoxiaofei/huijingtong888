export const TENANT_PRIVATE_FILES_SCHEMA = `CREATE TABLE IF NOT EXISTS tenant_private_files (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  storage_name VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  purpose VARCHAR(24) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  uploaded_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_private_file_storage (storage_name),
  KEY idx_private_file_tenant_purpose (tenant_id, purpose, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
