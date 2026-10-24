// Points are integer units. No conversion from supplier costs or floating RMB.
export const AI_CREDIT_SCHEMAS = [
  `CREATE TABLE IF NOT EXISTS ai_credit_accounts (
    tenant_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    account_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'disabled',
    available_points BIGINT NOT NULL DEFAULT 0,
    frozen_points BIGINT NOT NULL DEFAULT 0,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_ai_credit_account_key (account_key),
    CHECK (available_points >= 0 AND frozen_points >= 0)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_credit_prices (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    price_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version INT UNSIGNED NOT NULL,
    points_per_result BIGINT NOT NULL,
    created_by_person_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_ai_credit_price_version (price_key, version),
    CHECK (points_per_result > 0)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_credit_tasks (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    created_by_person_id BIGINT UNSIGNED NOT NULL,
    idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    input_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    price_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    price_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    price_version INT UNSIGNED NOT NULL,
    points_per_result BIGINT NOT NULL,
    requested_results INT UNSIGNED NOT NULL,
    reserved_points BIGINT NOT NULL,
    charged_points BIGINT NOT NULL DEFAULT 0,
    successful_results INT UNSIGNED NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'reserved',
    result_reference VARCHAR(500) NULL,
    result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_ai_credit_task_key (tenant_id, idempotency_key),
    KEY idx_ai_credit_task_tenant_status (tenant_id, status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_credit_attempts (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attempt_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attempt_number INT UNSIGNED NOT NULL,
    provider VARCHAR(80) NOT NULL,
    model VARCHAR(160) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'submitted',
    provider_receipt VARCHAR(250) NULL,
    outcome_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    supplier_cost_micros BIGINT UNSIGNED NULL,
    supplier_currency CHAR(3) CHARACTER SET ascii NULL,
    billing_conflict TINYINT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_ai_credit_attempt_key (task_id, attempt_key),
    UNIQUE KEY uq_ai_credit_attempt_number (task_id, attempt_number),
    KEY idx_ai_credit_attempt_task_status (task_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_credit_entries (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    entry_key VARCHAR(180) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    kind VARCHAR(20) NOT NULL,
    available_delta BIGINT NOT NULL,
    frozen_delta BIGINT NOT NULL,
    available_after BIGINT NOT NULL,
    frozen_after BIGINT NOT NULL,
    created_by_person_id BIGINT UNSIGNED NOT NULL,
    reason VARCHAR(500) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_ai_credit_entry_key (tenant_id, entry_key),
    KEY idx_ai_credit_entry_tenant_id (tenant_id, id),
    KEY idx_ai_credit_entry_task (task_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

export const AI_CREDIT_TABLES = ["ai_credit_accounts", "ai_credit_prices", "ai_credit_tasks", "ai_credit_attempts", "ai_credit_entries"];
