export const FINANCE_SUBMISSIONS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS finance_submissions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL, applicant_id BIGINT UNSIGNED NOT NULL,
    applicant_name VARCHAR(128) NOT NULL, kind VARCHAR(24) NOT NULL,
    source_hash CHAR(64) NOT NULL, file_name VARCHAR(255) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'pending', total_amount DECIMAL(18,2) NOT NULL,
    item_count INT NOT NULL, reviewed_by BIGINT UNSIGNED NULL, review_note VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at DATETIME NULL,
    UNIQUE KEY uk_submission_file (tenant_id, applicant_id, kind, source_hash),
    KEY idx_submission_tenant_applicant (tenant_id, applicant_id, id),
    KEY idx_submission_tenant_kind (tenant_id, kind, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS finance_submission_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL, submission_id BIGINT UNSIGNED NOT NULL,
    company_id BIGINT UNSIGNED NOT NULL, expense_date DATE NOT NULL,
    amount DECIMAL(18,2) NOT NULL, detail_json MEDIUMTEXT NOT NULL,
    KEY idx_submission_item_parent (tenant_id, submission_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS finance_imported_payroll_periods (
    tenant_id BIGINT UNSIGNED NOT NULL, company_id BIGINT UNSIGNED NOT NULL,
    month_key CHAR(7) NOT NULL, submission_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, company_id, month_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS finance_payroll_payment_updates (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL, item_id BIGINT UNSIGNED NOT NULL,
    paid_amount DECIMAL(18,2) NOT NULL,
    recorded_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_payroll_paid_tenant_item (tenant_id, item_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
