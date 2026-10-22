// Canonical fresh-database schema. Legacy upgrades use migrate-tenant-team-tasks.mjs.
export const TEAM_TASKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS team_tasks (
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      work_type VARCHAR(64) NOT NULL,
      owner_person_id BIGINT UNSIGNED NULL,
      collaborator_person_ids_json LONGTEXT NULL,
      period VARCHAR(32) NOT NULL DEFAULT 'week',
      status VARCHAR(32) NOT NULL DEFAULT 'todo',
      priority VARCHAR(32) NOT NULL DEFAULT 'medium',
      target_count DECIMAL(18,4) NOT NULL DEFAULT 1,
      done_count DECIMAL(18,4) NOT NULL DEFAULT 0,
      unit VARCHAR(32) NOT NULL DEFAULT '项',
      start_at DATE NULL,
      due_at DATE NULL,
      related_object TEXT NULL,
      result_note TEXT NULL,
      quality_score DECIMAL(8,2) NOT NULL DEFAULT 0,
      automation_key VARCHAR(128) NULL,
      owner_manually_assigned TINYINT(1) NOT NULL DEFAULT 0,
      created_by_person_id BIGINT UNSIGNED NULL,
      completed_at DATETIME NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_team_tasks_automation_key (tenant_id, automation_key),
      KEY idx_team_tasks_period_status (period, status, active),
      KEY idx_team_tasks_type_period (work_type, period, active),
      KEY idx_team_tasks_owner_period (owner_person_id, period, active),
      KEY idx_team_tasks_due (due_at, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS team_operational_owners (
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      work_type VARCHAR(64) NOT NULL, PRIMARY KEY (tenant_id, work_type),
      owner_person_id BIGINT UNSIGNED NULL,
      term_until DATE NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_development_projects (
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      code VARCHAR(64) NOT NULL DEFAULT '',
      category VARCHAR(128) NOT NULL DEFAULT '',
      owner_person_id BIGINT UNSIGNED NULL,
      participant_person_ids_json LONGTEXT NULL,
      market VARCHAR(128) NOT NULL DEFAULT 'Ozon 俄罗斯',
      status VARCHAR(32) NOT NULL DEFAULT 'planning',
      priority VARCHAR(32) NOT NULL DEFAULT 'medium',
      start_at DATE NULL,
      due_at DATE NULL,
      target_development_count INT NOT NULL DEFAULT 0,
      target_listing_count INT NOT NULL DEFAULT 0,
      target_success_count INT NOT NULL DEFAULT 0,
      target_revenue DECIMAL(18,2) NOT NULL DEFAULT 0,
      description TEXT NULL,
      risk_note TEXT NULL,
      created_by_person_id BIGINT UNSIGNED NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_dev_projects_status (status, active),
      KEY idx_dev_projects_owner (owner_person_id, active),
      KEY idx_dev_projects_due (due_at, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_development_candidates (
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      product_id BIGINT UNSIGNED NULL,
      project_id BIGINT UNSIGNED NULL,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(128) NOT NULL DEFAULT '',
      brand VARCHAR(128) NOT NULL DEFAULT '',
      vehicle_model VARCHAR(255) NOT NULL DEFAULT '',
      owner_person_id BIGINT UNSIGNED NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'idea',
      priority VARCHAR(32) NOT NULL DEFAULT 'medium',
      image_url TEXT NULL,
      source_url TEXT NULL,
      source_kind VARCHAR(32) NOT NULL DEFAULT 'manual',
      source_id VARCHAR(128) NOT NULL DEFAULT '',
      supplier_url TEXT NULL,
      expected_price DECIMAL(18,2) NOT NULL DEFAULT 0,
      expected_cost DECIMAL(18,2) NOT NULL DEFAULT 0,
      expected_margin_rate DECIMAL(8,2) NOT NULL DEFAULT 0,
      ip_risk VARCHAR(32) NOT NULL DEFAULT 'unknown',
      planned_listing_at DATE NULL,
      note TEXT NULL,
      decision_note TEXT NULL,
      created_by_person_id BIGINT UNSIGNED NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_dev_candidates_project (project_id, status, active),
      KEY idx_dev_candidates_product (product_id, active),
      KEY idx_dev_candidates_owner (owner_person_id, status, active),
      KEY idx_dev_candidates_status (status, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_development_ideas (
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL, image_url TEXT NULL, source_url TEXT NULL, note TEXT NULL,
      urgency TINYINT UNSIGNED NOT NULL DEFAULT 5, importance TINYINT UNSIGNED NOT NULL DEFAULT 5,
      created_by_person_id BIGINT UNSIGNED NULL, product_id BIGINT UNSIGNED NULL, candidate_id BIGINT UNSIGNED NULL,
      assignee_person_id BIGINT UNSIGNED NULL,
      target_product_count INT NOT NULL DEFAULT 0, development_due_at DATE NULL,
      development_started_at DATETIME NULL, claimed_at DATETIME NULL,
      development_brand VARCHAR(255) NOT NULL DEFAULT '', development_category VARCHAR(255) NOT NULL DEFAULT '',
      development_matrix_enabled TINYINT(1) NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'idea', active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_dev_ideas_status (status, active), KEY idx_dev_ideas_product (product_id, active),
      KEY idx_dev_ideas_priority (urgency, importance, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_development_idea_products (
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      idea_id BIGINT UNSIGNED NOT NULL,
      product_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, idea_id, product_id),
      KEY idx_dev_idea_products_product (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_development_idea_drafts (
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      idea_id BIGINT UNSIGNED NOT NULL,
      draft_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, idea_id, draft_id),
      KEY idx_dev_idea_drafts_draft (draft_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_development_task_links (
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      task_id BIGINT UNSIGNED NOT NULL, PRIMARY KEY (tenant_id, task_id),
      project_id BIGINT UNSIGNED NULL,
      candidate_id BIGINT UNSIGNED NULL,
      stage VARCHAR(32) NOT NULL DEFAULT '',
      deliverable TEXT NULL,
      reviewer_person_id BIGINT UNSIGNED NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_dev_task_links_project (project_id),
      KEY idx_dev_task_links_candidate (candidate_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_development_heatmap_orders (
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',
    period_key VARCHAR(64) NOT NULL,
    dimension VARCHAR(16) NOT NULL,
    coordinate_hash CHAR(64) NOT NULL,
    coordinate_json TEXT NOT NULL,
    sequence_number INT UNSIGNED NULL,
    is_marked TINYINT(1) NOT NULL DEFAULT 0,
    updated_by_person_id BIGINT UNSIGNED NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, period_key, dimension, coordinate_hash),
    KEY idx_dev_heatmap_period (period_key, dimension, sequence_number)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
`;
