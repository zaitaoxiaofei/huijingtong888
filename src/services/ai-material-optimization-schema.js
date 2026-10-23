// A legacy writer must fail closed. Unreviewed rows are preserved but cannot
// become default-enterprise work merely because a new server starts.
export const AI_MATERIAL_REVIEW_TENANT = "legacy_review";
export const AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA = `CREATE TABLE IF NOT EXISTS ai_material_optimization_batches (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id VARCHAR(64) NOT NULL DEFAULT 'legacy_review',
  batch_no VARCHAR(64) NOT NULL,
  optimization_scope VARCHAR(32) NOT NULL DEFAULT 'main_only',
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  total_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  created_by_person_id BIGINT NULL,
  ownership_review_json LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ai_material_batch_no (tenant_id, batch_no),
  INDEX idx_ai_material_batch_owner (tenant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export const AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA = `CREATE TABLE IF NOT EXISTS ai_material_optimization_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id VARCHAR(64) NOT NULL DEFAULT 'legacy_review',
  item_no VARCHAR(64) NOT NULL,
  batch_no VARCHAR(64) NOT NULL,
  source_draft_id BIGINT NOT NULL,
  result_draft_id BIGINT NULL,
  optimizer_job_no VARCHAR(64) NOT NULL DEFAULT '',
  optimization_scope VARCHAR(32) NOT NULL DEFAULT 'main_only',
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  stage VARCHAR(64) NOT NULL DEFAULT 'queued',
  progress_percent INT NOT NULL DEFAULT 0,
  source_title VARCHAR(500) NOT NULL DEFAULT '',
  operator_facts_json LONGTEXT NULL,
  checkpoint_json LONGTEXT NULL,
  ownership_review_json LONGTEXT NULL,
  error_message TEXT NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_by_person_id BIGINT NULL,
  started_at TIMESTAMP NULL,
  finished_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ai_material_item_no (tenant_id, item_no),
  INDEX idx_ai_material_item_batch (tenant_id, batch_no, id),
  INDEX idx_ai_material_item_queue (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export async function verifyAiMaterialOptimizationSchema(query) {
  for (const [table, unique, key] of [
    ["ai_material_optimization_batches", "uq_ai_material_batch_no", "batch_no"],
    ["ai_material_optimization_items", "uq_ai_material_item_no", "item_no"]
  ]) {
    const columns = await query(`SHOW COLUMNS FROM ${table}`);
    const indexes = await query(`SHOW INDEX FROM ${table}`);
    const tenant = columns.find(row => row.Field === "tenant_id");
    const scoped = indexes.filter(row => row.Key_name === unique && Number(row.Non_unique) === 0)
      .sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(row => row.Column_name).join(",");
    const globals = indexes.filter(row => Number(row.Non_unique) === 0 && row.Key_name !== "PRIMARY")
      .reduce((map, row) => map.set(row.Key_name, [...(map.get(row.Key_name) || []), row.Column_name]), new Map());
    if (!tenant || !/^varchar\(64\)$/i.test(tenant.Type) || tenant.Null !== "NO" || tenant.Default !== AI_MATERIAL_REVIEW_TENANT
      || scoped !== `tenant_id,${key}` || [...globals.values()].some(parts => !parts.includes("tenant_id"))
      || !columns.some(row => row.Field === "ownership_review_json")
      || (table.endsWith("items") && !columns.some(row => row.Field === "checkpoint_json"))) {
      throw Object.assign(new Error(`素材优化企业隔离结构尚未迁移：${table}，请先由管理员执行已审阅迁移`), { code: "AI_MATERIAL_SCHEMA_PENDING", status: 503 });
    }
  }
  return true;
}
