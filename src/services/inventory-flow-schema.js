import { INVENTORY_DEMAND_SNAPSHOT_SCHEMA } from './inventory-demand-snapshot.js';
export const INVENTORY_FLOW_SCHEMA = [
  INVENTORY_DEMAND_SNAPSHOT_SCHEMA,
  `CREATE TABLE IF NOT EXISTS inventory_flow_settings (
    tenant_id BIGINT UNSIGNED NOT NULL, product_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    settings_json JSON NOT NULL, revision INT NOT NULL DEFAULT 1,
    updated_by BIGINT UNSIGNED NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, product_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS inventory_flow_tasks (
    order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    request_key VARCHAR(96) NOT NULL, revision INT NOT NULL DEFAULT 1,
    locked TINYINT NOT NULL DEFAULT 0, snapshot_json JSON NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_flow_task_request (tenant_id, request_key), KEY idx_flow_task_tenant (tenant_id, order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS inventory_flow_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    order_id BIGINT UNSIGNED NULL, product_id BIGINT UNSIGNED NULL, person_id BIGINT UNSIGNED NULL,
    action VARCHAR(64) NOT NULL, detail_json JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_flow_event_tenant (tenant_id, id), KEY idx_flow_event_order (tenant_id, order_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
