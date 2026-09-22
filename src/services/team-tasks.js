import { isMysqlPrimaryEnabled, mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { aiVehicleCatalog } from "./ai-vehicle-catalog.js";
import { inventoryProductNamingOptions } from "./inventory-product-naming.js";
import { readDevelopmentPlan, normalizeDevelopmentPlan, developmentPlanProgress, developmentPlanDeliverable } from "./development-task-plan.js";
import { procurementRealOrderShortageMysql } from "./mysql-procurement-list.js";

const VALID_TYPES = new Set([
  "collection",
  "selection",
  "fission",
  "draft",
  "listing",
  "vehicle_sales",
  "order_review",
  "procurement",
  "optimization",
  "advertising",
  "finance_tax",
  "warehouse",
  "product_development",
  "procurement_daily",
  "shipping_daily",
  "custom"
]);
const VALID_PERIODS = new Set(["week", "month", "quarter", "year"]);
const VALID_STATUSES = new Set(["todo", "doing", "review", "done", "delayed"]);
const VALID_PRIORITIES = new Set(["high", "medium", "low"]);
const VALID_PROJECT_STATUSES = new Set(["planning", "approved", "active", "review", "done", "paused", "cancelled"]);
const VALID_CANDIDATE_STATUSES = new Set([
  "idea", "pending_review", "research", "costing", "approved", "supplier", "sample",
  "sample_review", "procurement", "content", "listing", "listed", "validation_7d",
  "validation_30d", "scale", "optimize", "paused", "rejected"
]);

let teamTasksSchemaReady = false;
let operationalTasksRefreshedAt = 0;
let operationalTasksRefreshPromise = null;
const OPERATIONAL_TASK_REFRESH_INTERVAL_MS = 30_000;

function ensureMysqlEnabled() {
  if (!isMysqlPrimaryEnabled()) {
    throw new Error("MySQL primary mode is not enabled");
  }
}

async function ensureTeamTasksSchema() {
  if (teamTasksSchemaReady) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS team_tasks (
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
      created_by_person_id BIGINT UNSIGNED NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_team_tasks_automation_key (automation_key),
      KEY idx_team_tasks_period_status (period, status, active),
      KEY idx_team_tasks_type_period (work_type, period, active),
      KEY idx_team_tasks_owner_period (owner_person_id, period, active),
      KEY idx_team_tasks_due (due_at, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`CREATE TABLE IF NOT EXISTS team_operational_owners (
      work_type VARCHAR(64) NOT NULL PRIMARY KEY,
      owner_person_id BIGINT UNSIGNED NULL,
      term_until DATE NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  await mysqlExecute("INSERT IGNORE INTO team_operational_owners (work_type) VALUES ('procurement_daily'), ('shipping_daily')");
  for (const sql of [
    "ALTER TABLE team_operational_owners ADD COLUMN term_until DATE NULL",
    "ALTER TABLE team_tasks ADD COLUMN owner_manually_assigned TINYINT(1) NOT NULL DEFAULT 0",
    "ALTER TABLE team_tasks ADD COLUMN automation_key VARCHAR(128) NULL AFTER quality_score",
    "CREATE UNIQUE INDEX uk_team_tasks_automation_key ON team_tasks (automation_key)"
  ]) {
    try { await mysqlExecute(sql); } catch (error) { if (!/Duplicate column|Duplicate key name/i.test(String(error?.message || error))) throw error; }
  }
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS product_development_projects (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS product_development_candidates (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS product_development_ideas (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL, image_url TEXT NULL, source_url TEXT NULL, note TEXT NULL,
      urgency TINYINT UNSIGNED NOT NULL DEFAULT 5, importance TINYINT UNSIGNED NOT NULL DEFAULT 5,
      created_by_person_id BIGINT UNSIGNED NULL, product_id BIGINT UNSIGNED NULL, candidate_id BIGINT UNSIGNED NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'idea', active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_dev_ideas_status (status, active), KEY idx_dev_ideas_product (product_id, active),
      KEY idx_dev_ideas_priority (urgency, importance, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  const ideaColumns = await mysqlQuery("SHOW COLUMNS FROM product_development_ideas");
  for (const field of ["development_brand", "development_category"]) {
    if (!ideaColumns.some((column) => column.Field === field)) {
      await mysqlExecute(`ALTER TABLE product_development_ideas ADD COLUMN ${field} VARCHAR(255) NOT NULL DEFAULT ''`);
    }
  }
  if (!ideaColumns.some((column) => column.Field === "development_matrix_enabled")) {
    await mysqlExecute("ALTER TABLE product_development_ideas ADD COLUMN development_matrix_enabled TINYINT(1) NOT NULL DEFAULT 0");
  }
  if (!ideaColumns.some((column) => column.Field === "assignee_person_id")) {
    await mysqlExecute(`ALTER TABLE product_development_ideas
      ADD COLUMN assignee_person_id BIGINT UNSIGNED NULL AFTER created_by_person_id,
      ADD COLUMN target_product_count INT NOT NULL DEFAULT 0 AFTER assignee_person_id,
      ADD COLUMN development_due_at DATE NULL AFTER target_product_count,
      ADD COLUMN development_started_at DATETIME NULL AFTER development_due_at,
      ADD COLUMN claimed_at DATETIME NULL AFTER development_started_at,
      ADD KEY idx_dev_ideas_assignee (assignee_person_id, status, active),
      ADD KEY idx_dev_ideas_due (development_due_at, status, active)`);
  }
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS product_development_idea_products (
      idea_id BIGINT UNSIGNED NOT NULL,
      product_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (idea_id, product_id),
      KEY idx_dev_idea_products_product (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`INSERT IGNORE INTO product_development_idea_products (idea_id,product_id)
    SELECT id,product_id FROM product_development_ideas WHERE active=1 AND product_id IS NOT NULL`);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS product_development_idea_drafts (
      idea_id BIGINT UNSIGNED NOT NULL,
      draft_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (idea_id, draft_id),
      KEY idx_dev_idea_drafts_draft (draft_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`INSERT IGNORE INTO product_development_idea_drafts (idea_id,draft_id)
    SELECT idea_product.idea_id,draft.id
    FROM product_development_idea_products idea_product
    JOIN listing_drafts draft ON draft.source_product_id=idea_product.product_id AND draft.status<>'deleted'`);
  const candidateColumns = await mysqlQuery("SHOW COLUMNS FROM product_development_candidates");
  if (!candidateColumns.some((column) => column.Field === "product_id")) {
    await mysqlExecute("ALTER TABLE product_development_candidates ADD COLUMN product_id BIGINT UNSIGNED NULL AFTER id, ADD KEY idx_dev_candidates_product (product_id, active)");
  }
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS product_development_task_links (
      task_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      project_id BIGINT UNSIGNED NULL,
      candidate_id BIGINT UNSIGNED NULL,
      stage VARCHAR(32) NOT NULL DEFAULT '',
      deliverable TEXT NULL,
      reviewer_person_id BIGINT UNSIGNED NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_dev_task_links_project (project_id),
      KEY idx_dev_task_links_candidate (candidate_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  teamTasksSchemaReady = true;
}

function normalizeChoice(value, fallback, allowed) {
  const text = String(value || "").trim();
  return allowed.has(text) ? text : fallback;
}

function normalizeText(value, maxLength = 255) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function normalizeScore(value, fallback = 5) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(10, Math.round(number))) : fallback;
}

function normalizeHttpUrl(value, fieldLabel) {
  const text = normalizeText(value, 5000);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    return text;
  } catch { throw new Error(`${fieldLabel}必须是完整的 http 或 https 链接`); }
}

function normalizeImageUrl(value) {
  const text = normalizeText(value, 5000);
  if (!text || text.startsWith("/")) return text;
  return normalizeHttpUrl(text, "主图");
}

function normalizePersonId(value) {
  const id = Number(value || 0);
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
}

function normalizeCollaborators(value) {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw.map(normalizePersonId).filter(Boolean))];
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dateOnly(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

function normalizeTeamTaskRow(row = {}) {
  const collaboratorIds = parseJsonArray(row.collaborator_person_ids_json).map(normalizePersonId).filter(Boolean);
  return {
    id: Number(row.id),
    title: row.title || "",
    type: row.work_type || "selection",
    owner_person_id: row.owner_person_id ? Number(row.owner_person_id) : null,
    owner_name: row.owner_name || "",
    owner_avatar_url: row.owner_avatar_url || "",
    collaborator_person_ids: collaboratorIds,
    period: row.period || "week",
    status: row.status || "todo",
    priority: row.priority || "medium",
    target: Number(row.target_count || 0),
    done: Number(row.done_count || 0),
    unit: row.unit || "项",
    start_at: dateOnly(row.start_at),
    due_at: dateOnly(row.due_at),
    related: row.related_object || "",
    result: row.result_note || "",
    quality: Number(row.quality_score || 0),
    automation_key: row.automation_key || "",
    project_id: row.project_id ? Number(row.project_id) : null,
    project_name: row.project_name || "",
    candidate_id: row.candidate_id ? Number(row.candidate_id) : null,
    candidate_title: row.candidate_title || "",
    stage: row.development_stage || "",
    deliverable: readDevelopmentPlan(row.related_object) ? developmentPlanDeliverable(readDevelopmentPlan(row.related_object)) : row.deliverable || "",
    reviewer_person_id: row.reviewer_person_id ? Number(row.reviewer_person_id) : null,
    created_at: row.created_at || "",
    updated_at: row.updated_at || ""
  };
}

function buildPayload(body = {}, sessionPersonId = null) {
  const title = normalizeText(body.title, 255);
  if (!title) throw new Error("请填写任务名称");
  const target = normalizeNumber(body.target ?? body.target_count, 1);
  const done = Math.min(normalizeNumber(body.done ?? body.done_count, 0), target || 0);
  return {
    title,
    workType: normalizeChoice(body.type || body.work_type, "selection", VALID_TYPES),
    ownerPersonId: normalizePersonId(body.owner_person_id ?? body.ownerPersonId),
    collaboratorIds: normalizeCollaborators(body.collaborator_person_ids || body.collaboratorPersonIds),
    period: normalizeChoice(body.period, "week", VALID_PERIODS),
    status: normalizeChoice(body.status, "todo", VALID_STATUSES),
    priority: normalizeChoice(body.priority, "medium", VALID_PRIORITIES),
    target,
    done,
    unit: normalizeText(body.unit, 32) || "项",
    startAt: normalizeDate(body.start_at || body.startAt),
    dueAt: normalizeDate(body.due_at || body.dueAt),
    related: normalizeText(body.related || body.related_object, 2000),
    result: normalizeText(body.result || body.result_note, 2000) || "待执行",
    quality: Math.min(100, normalizeNumber(body.quality || body.quality_score, 0)),
    projectId: normalizePersonId(body.project_id || body.projectId),
    candidateId: normalizePersonId(body.candidate_id || body.candidateId),
    stage: normalizeText(body.stage || body.development_stage, 32),
    deliverable: normalizeText(body.deliverable, 2000),
    reviewerPersonId: normalizePersonId(body.reviewer_person_id || body.reviewerPersonId),
    createdByPersonId: normalizePersonId(sessionPersonId)
  };
}

async function loadDevelopmentPlanDrafts(ids) {
  if (!ids.length) return [];
  return mysqlQuery(`SELECT id, product_name, created_by_person_id, created_at, status,
    GREATEST(1, COALESCE(
      CASE WHEN JSON_VALID(template_payload_json) THEN JSON_LENGTH(JSON_EXTRACT(template_payload_json,'$.editable_payload.variants')) END,
      CASE WHEN JSON_VALID(template_payload_json) THEN JSON_LENGTH(JSON_EXTRACT(template_payload_json,'$.variants')) END,
      CASE WHEN JSON_VALID(manual_facts_json) THEN JSON_LENGTH(JSON_EXTRACT(manual_facts_json,'$.variants')) END, 1
    )) AS sku_count
    FROM listing_drafts WHERE id IN (${ids.map(() => "?").join(",")}) AND status<>'deleted'`, ids);
}

async function applyDevelopmentPlanPayload(payload, body, options = {}) {
  const plan = normalizeDevelopmentPlan(body.related ?? body.related_object, body, options);
  if (!plan) return false;
  const [catalog, categories] = options.catalogs || await Promise.all([aiVehicleCatalog(), inventoryProductNamingOptions({ type: "category" })]);
  for (const row of plan.models) {
    const rowBrand = row.brand || plan.brand; const rowCategory = row.category || plan.category;
    const brand = catalog.brands.find((item) => item.name === rowBrand);
    if (!brand && (row.scope || plan.scope) !== "non_automotive") throw new Error("任务品牌（brand）不在当前车型目录中，请返回表格重新选择品牌。");
    const categoryAvailable = categories.rows.some((item) => item.value === rowCategory);
    const legacyCategoryAllowed = options.allowedLegacyCategoryKeys?.has(`${rowBrand}\n${rowCategory}`);
    if (!categoryAvailable && !legacyCategoryAllowed) throw new Error("任务核心品名（category）不可用，请返回表格选择已审核的核心品名。");
    if ((row.scope || plan.scope) === "non_automotive") continue;
    const model = brand.models.find((item) => Number(item.id) === row.model_id);
    if (!model) throw new Error("任务车型（model_id）不属于所选品牌，请在车型明细中重新选择。");
    row.model = model.name;
  }
  const ids = [...plan.models.flatMap((row) => row.draft_ids), ...(plan.unallocated_draft_ids || [])];
  const drafts = await loadDevelopmentPlanDrafts(ids);
  if (!options.preserveHistoricalDrafts && ids.some(id => !drafts.some(row => Number(row.id) === id) && !options.historicalDraftIds?.has(id))) throw new Error("关联草稿（draft_ids）已删除或不存在，请在车型明细中移除后重新关联。");
  if (!options.preserveHistoricalDrafts && drafts.some((row) => Number(row.created_by_person_id) !== payload.ownerPersonId && !options.historicalDraftIds?.has(Number(row.id)))) throw new Error("只能关联任务负责人创建的草稿（created_by_person_id），请检查负责人或移除不属于该人员的草稿。");
  const progress = developmentPlanProgress(plan, drafts);
  Object.assign(payload, { related: JSON.stringify(plan), target: progress.target, done: progress.done,
    status: progress.status, unit: "SKU", deliverable: developmentPlanDeliverable(plan) });
  return true;
}

async function saveTaskLink(taskId, payload) {
  await mysqlExecute(`
    INSERT INTO product_development_task_links
      (task_id, project_id, candidate_id, stage, deliverable, reviewer_person_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      project_id = VALUES(project_id), candidate_id = VALUES(candidate_id), stage = VALUES(stage),
      deliverable = VALUES(deliverable), reviewer_person_id = VALUES(reviewer_person_id), updated_at = CURRENT_TIMESTAMP
  `, [taskId, payload.projectId, payload.candidateId, payload.stage, payload.deliverable, payload.reviewerPersonId]);
}

async function assertActivePerson(personId, label) {
  if (!personId) return;
  const rows = await mysqlQuery("SELECT id FROM people WHERE id = ? AND active != 0 LIMIT 1", [personId]);
  if (!rows[0]) throw new Error(`${label}不存在或已停用`);
}

async function assertCollaborators(collaboratorIds = []) {
  if (!collaboratorIds.length) return;
  const placeholders = collaboratorIds.map(() => "?").join(",");
  const rows = await mysqlQuery(`SELECT id FROM people WHERE active != 0 AND id IN (${placeholders})`, collaboratorIds);
  if (rows.length !== collaboratorIds.length) throw new Error("协作人包含不存在或已停用的人员");
}

export async function teamOperationalOwnersMysql() {
  ensureMysqlEnabled();
  await ensureTeamTasksSchema();
  return { rows: await mysqlQuery(`SELECT settings.work_type AS type, settings.owner_person_id, person.name AS owner_name,
      DATE_FORMAT(settings.term_until, '%Y-%m-%d') AS term_until,
      COALESCE(settings.term_until < DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR)), 0) AS term_expired
    FROM team_operational_owners settings LEFT JOIN people person ON person.id=settings.owner_person_id`) };
}

export async function setTeamOperationalOwnerMysql(body = {}) {
  ensureMysqlEnabled();
  await ensureTeamTasksSchema();
  if (!["procurement_daily", "shipping_daily"].includes(body.type)) throw new Error("请选择采购任务或每日发货任务类型");
  const ownerId = normalizePersonId(body.owner_person_id);
  if (!ownerId) throw new Error("缺少固定负责人（owner_person_id），无法自动分配每日任务。请在新增任务中选择该类任务的负责人后保存。");
  const termUntil = body.term_until == null || body.term_until === "" ? null : body.term_until;
  if (termUntil !== null) {
    const parsed = typeof termUntil === "string" && /^\d{4}-\d{2}-\d{2}$/.test(termUntil) ? new Date(`${termUntil}T00:00:00Z`) : null;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== termUntil || termUntil < today) {
      throw new Error("负责截止日期（term_until）必须是今天或之后的有效日期。请在固定负责人设置中重新选择截止日期（北京时间），或清空日期以长期沿用。");
    }
  }
  await assertActivePerson(ownerId, "固定负责人");
  await withMysqlTransaction(async (connection) => {
    await connection.execute("UPDATE team_operational_owners SET owner_person_id=?, term_until=IF(?, ?, term_until) WHERE work_type=?", [ownerId, body.term_until !== undefined, termUntil, body.type]);
    await connection.execute(`UPDATE team_tasks SET owner_person_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE work_type=? AND automation_key LIKE CONCAT(?, ':%') AND active=1 AND owner_manually_assigned=0
        AND due_at >= DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))`, [ownerId, body.type, body.type]);
  });
  return { ok: true };
}

async function upsertAutomatedTask({ key, title, type, ownerId = null, target = 0, done = 0, unit = "单", date, status = "doing", related = "" }) {
  await withMysqlTransaction(async (connection) => {
    const [owners] = await connection.execute("SELECT owner_person_id FROM team_operational_owners WHERE work_type=? FOR UPDATE", [type]);
    await connection.execute(`
    INSERT INTO team_tasks
      (title, work_type, owner_person_id, period, status, priority, target_count, done_count, unit, start_at, due_at, related_object, result_note, automation_key)
    VALUES (?, ?, ?, 'week', ?, 'medium', ?, ?, ?, ?, ?, ?, '系统按业务数据自动更新', ?)
    ON DUPLICATE KEY UPDATE title=VALUES(title), status=VALUES(status),
      owner_person_id=IF(owner_manually_assigned=1 OR ? IS NULL, owner_person_id, VALUES(owner_person_id)),
      target_count=VALUES(target_count), done_count=VALUES(done_count), unit=VALUES(unit), start_at=VALUES(start_at),
      due_at=VALUES(due_at), related_object=VALUES(related_object), active=1, updated_at=CURRENT_TIMESTAMP
  `, [title, type, owners[0]?.owner_person_id ?? ownerId, status, target, done, unit, date, date, related, key, owners[0]?.owner_person_id ?? null]);
  });
}

async function syncDevelopmentIdeaTasks() {
  await mysqlExecute(`
    INSERT INTO team_tasks
      (title, work_type, owner_person_id, period, status, priority, target_count, done_count, unit, start_at, due_at, related_object, result_note, automation_key)
    SELECT idea.title, 'product_development', idea.assignee_person_id, 'week',
      CASE WHEN idea.target_product_count>0 AND COALESCE(MAX(draft_stats.output_count),0) >= idea.target_product_count THEN 'done'
        WHEN idea.status='idea' OR idea.assignee_person_id IS NULL THEN 'todo'
        WHEN DATE(idea.development_due_at) < DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR)) THEN 'delayed' ELSE 'doing' END,
      'medium', idea.target_product_count, COALESCE(MAX(draft_stats.output_count),0), '个产品',
      DATE(COALESCE(idea.development_started_at, idea.created_at)), DATE(idea.development_due_at),
      JSON_OBJECT('kind','product_development','idea_id',idea.id,'brand',idea.development_brand,'category',idea.development_category,'route','/team-plan'), '按任务关联草稿内的变体数量自动计算，店铺副本不重复计数',
      CONCAT('development_idea:', idea.id)
    FROM product_development_ideas idea
    LEFT JOIN product_development_idea_products idea_product ON idea_product.idea_id=idea.id
    LEFT JOIN (
      SELECT idea_draft.idea_id, SUM(GREATEST(1,
        COALESCE(
          CASE WHEN JSON_VALID(draft.template_payload_json) THEN JSON_LENGTH(JSON_EXTRACT(draft.template_payload_json,'$.editable_payload.variants')) END,
          CASE WHEN JSON_VALID(draft.template_payload_json) THEN JSON_LENGTH(JSON_EXTRACT(draft.template_payload_json,'$.variants')) END,
          CASE WHEN JSON_VALID(draft.manual_facts_json) THEN JSON_LENGTH(JSON_EXTRACT(draft.manual_facts_json,'$.variants')) END,
          1
        ))) AS output_count
      FROM product_development_idea_drafts idea_draft
      JOIN listing_drafts draft ON draft.id=idea_draft.draft_id AND draft.status<>'deleted'
      GROUP BY idea_draft.idea_id
    ) draft_stats ON draft_stats.idea_id=idea.id
    WHERE idea.active=1 AND idea.development_matrix_enabled=0
    GROUP BY idea.id
    ON DUPLICATE KEY UPDATE title=VALUES(title), owner_person_id=VALUES(owner_person_id), status=VALUES(status),
      target_count=VALUES(target_count), done_count=VALUES(done_count), start_at=VALUES(start_at), due_at=VALUES(due_at),
      related_object=VALUES(related_object), active=1, updated_at=CURRENT_TIMESTAMP
  `);
  await mysqlExecute(`UPDATE team_tasks task JOIN product_development_ideas idea
    ON task.automation_key=CONCAT('development_idea:',idea.id)
    SET task.active=0 WHERE (idea.active=0 OR idea.development_matrix_enabled=1) AND task.active=1`);
  await mysqlExecute(`UPDATE team_tasks task JOIN product_development_ideas idea
    ON task.automation_key LIKE CONCAT('idea_scope:',idea.id,':%')
    SET task.active=0 WHERE idea.active=0 AND task.active=1`);
}

async function ensureOperationalTeamTasks() {
  await syncDevelopmentIdeaTasks();
  const [{ beijing_date: beijingDate, statistics_date: statisticsDate }] = await mysqlQuery(`SELECT
    DATE_FORMAT(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR), '%Y-%m-%d') AS beijing_date,
    DATE_FORMAT(DATE_SUB(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR), INTERVAL 1 DAY), '%Y-%m-%d') AS statistics_date`);


  const [procurement] = await mysqlQuery(`SELECT COUNT(*) AS target_count, COALESCE(SUM(order_request.completed),0) AS done_count
    FROM (SELECT request.source_order_id,
        MIN(CASE WHEN request.status IN ('done','purchased','partial_inbound','inbound_done') THEN 1 ELSE 0 END) AS completed
      FROM procurement_requests request
      JOIN orders source_order ON source_order.id=request.source_order_id
      WHERE request.status<>'cancelled' AND request.source_order_id IS NOT NULL
        AND DATE(DATE_ADD(source_order.ordered_at, INTERVAL 8 HOUR))=?
      GROUP BY request.source_order_id) order_request`, [statisticsDate]);
  const procurementTarget = Number(procurement?.target_count || 0); const procurementDone = Number(procurement?.done_count || 0);
  await upsertAutomatedTask({ key: `procurement_daily:${beijingDate}`, title: `${beijingDate} 采购任务`, type: "procurement_daily",
    target: procurementTarget, done: procurementDone, unit: "单", date: beijingDate, status: procurementDone >= procurementTarget ? "done" : "doing",
    related: JSON.stringify({ kind: "procurement_daily", date: beijingDate, statistics_date: statisticsDate,
      timezone: "Asia/Shanghai", window: `${statisticsDate} 00:00–24:00`, route: "/procurement/workspace",
      total: procurementTarget, completed: procurementDone }) });

  const [shipping] = await mysqlQuery(`SELECT COUNT(DISTINCT orders.id) AS target_count,
      COUNT(DISTINCT labels.order_id) AS printed_count,
      COUNT(DISTINCT CASE WHEN LOWER(CONCAT_WS(' ',orders.status,orders.tracking_stage,orders.logistics_status)) REGEXP 'delivering|delivered|posting_received' THEN orders.id END) AS transported_count
    FROM orders LEFT JOIN order_label_prints labels ON labels.order_id=orders.id
    WHERE LOWER(CONCAT_WS(' ',orders.status,orders.tracking_stage,orders.logistics_status)) NOT REGEXP 'cancel|return|reject'
      AND DATE(DATE_ADD(orders.ordered_at, INTERVAL 8 HOUR))=?`, [statisticsDate]);
  const shippingTarget = Number(shipping?.target_count || 0); const printed = Number(shipping?.printed_count || 0); const transported = Number(shipping?.transported_count || 0);
  const shippingDone = shippingTarget ? Math.min(shippingTarget, (Math.min(printed, shippingTarget) + Math.min(transported, shippingTarget)) / 2) : 0;
  await upsertAutomatedTask({ key: `shipping_daily:${beijingDate}`, title: `${beijingDate} 每日发货任务`, type: "shipping_daily",
    target: shippingTarget, done: shippingDone, unit: "单", date: beijingDate, status: transported >= shippingTarget ? "done" : "doing",
    related: JSON.stringify({ kind: "shipping_daily", date: beijingDate, statistics_date: statisticsDate,
      timezone: "Asia/Shanghai", window: `${statisticsDate} 00:00–24:00`, route: "/orders",
      total: shippingTarget, printed, transported }) });
}

async function refreshOperationalTeamTasks() {
  if (Date.now() - operationalTasksRefreshedAt < OPERATIONAL_TASK_REFRESH_INTERVAL_MS) return;
  if (!operationalTasksRefreshPromise) {
    operationalTasksRefreshPromise = ensureOperationalTeamTasks()
      .then(() => { operationalTasksRefreshedAt = Date.now(); })
      .finally(() => { operationalTasksRefreshPromise = null; });
  }
  await operationalTasksRefreshPromise;
}

export async function teamTasksMysql(query = {}) {
  ensureMysqlEnabled();
  await ensureTeamTasksSchema();
  await refreshOperationalTeamTasks();
  const where = ["t.active = 1"];
  const params = [];
  const period = String(query.period || "").trim();
  const type = String(query.type || "").trim();
  const ownerId = normalizePersonId(query.owner_person_id || query.ownerPersonId);
  const status = String(query.status || "").trim();
  if (VALID_PERIODS.has(period)) {
    where.push("t.period = ?");
    params.push(period);
  }
  if (VALID_TYPES.has(type)) {
    where.push("t.work_type = ?");
    params.push(type);
  }
  if (ownerId) {
    where.push("t.owner_person_id = ?");
    params.push(ownerId);
  }
  const rows = await mysqlQuery(`
    SELECT t.*, p.name AS owner_name, p.avatar_url AS owner_avatar_url,
      link.project_id, project.name AS project_name, link.candidate_id, candidate.title AS candidate_title,
      link.stage AS development_stage, link.deliverable, link.reviewer_person_id
    FROM team_tasks t
    LEFT JOIN people p ON p.id = t.owner_person_id
    LEFT JOIN product_development_task_links link ON link.task_id = t.id
    LEFT JOIN product_development_projects project ON project.id = link.project_id AND project.active = 1
    LEFT JOIN product_development_candidates candidate ON candidate.id = link.candidate_id AND candidate.active = 1
    WHERE ${where.join(" AND ")}
    ORDER BY
      CASE t.status
        WHEN 'delayed' THEN 1
        WHEN 'doing' THEN 2
        WHEN 'review' THEN 3
        WHEN 'todo' THEN 4
        ELSE 5
      END,
      COALESCE(t.due_at, '9999-12-31') ASC,
      t.updated_at DESC,
      t.id DESC
  `, params);
  const plans = rows.map((row) => readDevelopmentPlan(row.related_object)).filter(Boolean);
  const ideaIds = rows.flatMap((row) => {
    try { const related = JSON.parse(row.related_object || "{}"); return related.kind === "product_development" && Number(related.idea_id) > 0 ? [Number(related.idea_id)] : []; } catch { return []; }
  });
  const ideaDraftLinks = ideaIds.length ? await mysqlQuery(`SELECT link.idea_id, link.draft_id, idea.created_at AS idea_created_at
    FROM product_development_ideas idea LEFT JOIN product_development_idea_drafts link ON link.idea_id=idea.id
    WHERE idea.id IN (${ideaIds.map(() => "?").join(",")})`, ideaIds) : [];
  const draftIds = [...new Set([...plans.flatMap((plan) => [...plan.models.flatMap((row) => row.draft_ids), ...(plan.unallocated_draft_ids || [])]), ...ideaDraftLinks.map(row => Number(row.draft_id)).filter(Boolean)])];
  const drafts = await loadDevelopmentPlanDrafts(draftIds);
  const draftsById = new Map(drafts.map(row => [Number(row.id), row]));
  return rows.map((row) => {
    const task = normalizeTeamTaskRow(row);
    try {
      const related = JSON.parse(row.related_object || "{}");
      if (["development_matrix", "product_development"].includes(related.kind)) {
        task.development_brand = related.brand || "";
        task.development_category = related.category || "";
        task.idea_id = Number(related.idea_id || 0) || null;
        if (task.idea_id) {
          const links = ideaDraftLinks.filter(link => Number(link.idea_id) === task.idea_id);
          task.development_created_at = links[0]?.idea_created_at || task.created_at;
          task.development_drafts = links.map(link => draftsById.get(Number(link.draft_id))).filter(Boolean)
            .map(draft => ({ id: Number(draft.id), title: draft.product_name, count: Number(draft.sku_count), created_at: draft.created_at }));
        }
      }
    } catch {}
    const plan = readDevelopmentPlan(row.related_object);
    if (plan) {
      const progress = developmentPlanProgress(plan, drafts);
      task.development_brand = [...new Set(plan.models.map(model => model.brand || plan.brand))].join('、');
      task.development_category = [...new Set(plan.models.map(model => model.category || plan.category))].join('、');
      Object.assign(task, { target: progress.target, done: progress.done, status: progress.status,
        source_idea_id: plan.source_idea_id || null,
        development_scopes: plan.models.map(model => ({ brand: model.brand || plan.brand, category: model.category || plan.category })),
        development_plan: { ...plan, models: progress.models, unallocated_drafts: progress.unallocated_drafts } });
    }
    return task;
  }).filter((row) => !VALID_STATUSES.has(status) || row.status === status);
}

export async function teamTaskOperationalDetailsMysql(id) {
  ensureMysqlEnabled();
  await ensureTeamTasksSchema();
  const taskId = Number(id);
  const [task] = await mysqlQuery("SELECT id, work_type, related_object, target_count FROM team_tasks WHERE id = ? AND active = 1 LIMIT 1", [taskId]);
  if (!task) throw new Error("任务不存在");
  let related = {};
  try { related = JSON.parse(task.related_object || "{}"); } catch {}
  const statisticsDate = String(related.statistics_date || "").slice(0, 10);
  if (!statisticsDate || !["procurement_daily", "shipping_daily"].includes(task.work_type)) return { rows: [], summary: {} };

  if (task.work_type === "procurement_daily") {
    const rows = await mysqlQuery(`SELECT
        COALESCE(request.source_order_id, request.id) AS row_id, request.source_order_id AS order_id,
        CASE WHEN request.source_order_id IS NULL THEN CONCAT('采购请求 #', MIN(request.id))
          ELSE COALESCE(MAX(source_order.posting_number), MAX(source_order.order_number), CONCAT('订单 #', request.source_order_id)) END AS order_number,
        MAX(shop.name) AS shop_name, MAX(source_item.ozon_image_url) AS image_url, MAX(source_order.ordered_at) AS ordered_at,
        GROUP_CONCAT(DISTINCT COALESCE(source_item.ozon_name, request.raw_name, product.name) ORDER BY request.id SEPARATOR '；') AS product_names,
        SUM(request.quantity) AS quantity, GROUP_CONCAT(DISTINCT request.status ORDER BY request.status) AS procurement_status,
        MAX(request.created_at) AS created_at, MAX(active_demand.order_demand_quantity) AS order_demand_quantity,
        MAX(stock.stock) AS stock, MAX(incoming.incoming_stock) AS incoming_stock,
        MAX(component_supply.component_count) AS component_count,
        MAX(component_supply.component_local_stock) AS component_local_stock,
        MAX(component_supply.component_incoming_stock) AS component_incoming_stock
      FROM procurement_requests request
      LEFT JOIN orders source_order ON source_order.id=request.source_order_id
      LEFT JOIN shops shop ON shop.id=source_order.shop_id
      LEFT JOIN order_items source_item ON source_item.id=request.source_order_item_id
      LEFT JOIN products product ON product.id=request.product_id
      LEFT JOIN (
        SELECT product_id, SUM(quantity_delta) AS stock
        FROM inventory_movements
        WHERE status='posted' AND COALESCE(NULLIF(stock_location, ''), 'LOCAL') != 'FBP'
        GROUP BY product_id
      ) stock ON stock.product_id=request.product_id
      LEFT JOIN (
        SELECT product_id, SUM(quantity) AS incoming_stock
        FROM inbound_records WHERE status='pending_arrival' GROUP BY product_id
      ) incoming ON incoming.product_id=request.product_id
      LEFT JOIN (
        SELECT pc.product_id, COUNT(*) AS component_count,
          MIN(FLOOR(COALESCE(component_stock.local_stock,0)/NULLIF(pc.quantity,0))) AS component_local_stock,
          GREATEST(0,
            MIN(FLOOR((COALESCE(component_stock.local_stock,0)+COALESCE(component_incoming.incoming_stock,0))/NULLIF(pc.quantity,0)))
            - MIN(FLOOR(COALESCE(component_stock.local_stock,0)/NULLIF(pc.quantity,0)))
          ) AS component_incoming_stock
        FROM product_components pc
        JOIN products component_product ON component_product.id=pc.component_product_id AND component_product.active=1
        LEFT JOIN (
          SELECT product_id, SUM(quantity_delta) AS local_stock FROM inventory_movements
          WHERE status='posted' AND COALESCE(NULLIF(stock_location, ''), 'LOCAL') != 'FBP' GROUP BY product_id
        ) component_stock ON component_stock.product_id=pc.component_product_id
        LEFT JOIN (
          SELECT product_id, SUM(quantity) AS incoming_stock FROM inbound_records
          WHERE status='pending_arrival' GROUP BY product_id
        ) component_incoming ON component_incoming.product_id=pc.component_product_id
        GROUP BY pc.product_id
      ) component_supply ON component_supply.product_id=request.product_id
      LEFT JOIN (
        SELECT product_id, SUM(quantity) AS order_demand_quantity
        FROM procurement_requests
        WHERE status IN ('pending','suggested','submitted') AND source_order_id IS NOT NULL
        GROUP BY product_id
      ) active_demand ON active_demand.product_id=request.product_id
      WHERE request.status<>'cancelled' AND request.source_order_id IS NOT NULL
        AND DATE(DATE_ADD(source_order.ordered_at, INTERVAL 8 HOUR))=?
      GROUP BY COALESCE(request.source_order_id, request.id), request.source_order_id,
        request.product_id, stock.stock, incoming.incoming_stock, component_supply.component_count,
        component_supply.component_local_stock, component_supply.component_incoming_stock, active_demand.order_demand_quantity
      HAVING MIN(CASE WHEN request.status IN ('done','purchased','partial_inbound','inbound_done') THEN 1 ELSE 0 END)=0
      ORDER BY MAX(request.created_at) ASC LIMIT 500`, [statisticsDate]);
    const actionableByOrder = new Map();
    for (const row of rows.filter((item) => procurementRealOrderShortageMysql(item) > 0)) {
      const key = Number(row.order_id || row.row_id);
      const existing = actionableByOrder.get(key);
      if (!existing) { actionableByOrder.set(key, row); continue; }
      existing.quantity = Number(existing.quantity || 0) + Number(row.quantity || 0);
      existing.product_names = [existing.product_names, row.product_names].filter(Boolean).join("；");
      existing.procurement_status = [...new Set(`${existing.procurement_status || ""},${row.procurement_status || ""}`.split(",").filter(Boolean))].join(",");
    }
    const actionableRows = [...actionableByOrder.values()];
    const done = Math.max(0, Number(task.target_count || 0) - actionableRows.length);
    const status = done >= Number(task.target_count || 0) ? "done" : "doing";
    await mysqlExecute("UPDATE team_tasks SET done_count=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1", [done, status, taskId]);
    return { rows: actionableRows.map((row) => ({ ...row, reason: "not_procured", reason_label: "尚未采购", warning: true })),
      summary: { total: actionableRows.length, not_procured: actionableRows.length }, progress: { done, status } };
  }

  const rows = await mysqlQuery(`SELECT o.id AS row_id, o.id AS order_id, o.posting_number AS order_number, shop.name AS shop_name,
      MAX(item.ozon_image_url) AS image_url,
      GROUP_CONCAT(DISTINCT COALESCE(item.ozon_name, mapping.display_name, item.ozon_sku) ORDER BY item.id SEPARATOR '；') AS product_names,
      SUM(item.quantity) AS quantity, MAX(CASE WHEN label.order_id IS NOT NULL THEN 1 ELSE 0 END) AS printed,
      MAX(CASE WHEN procurement.has_pending=1 THEN 1 ELSE 0 END) AS has_pending_procurement,
      MAX(CASE WHEN procurement.has_in_transit=1 THEN 1 ELSE 0 END) AS has_in_transit_procurement,
      MAX(CASE WHEN COALESCE(stock.available_stock,0) < item.quantity THEN 1 ELSE 0 END) AS has_stock_shortage,
      GROUP_CONCAT(DISTINCT CONCAT(item.ozon_sku, ' ×', item.quantity) ORDER BY item.id SEPARATOR '；') AS sku_summary,
      o.status, o.tracking_stage, o.logistics_status, o.ordered_at
    FROM orders o
    LEFT JOIN shops shop ON shop.id=o.shop_id
    JOIN order_items item ON item.order_id=o.id
    LEFT JOIN sku_mappings mapping ON mapping.id=item.sku_mapping_id AND mapping.active=1
    LEFT JOIN inventory_current stock ON stock.real_product_id=mapping.product_id
    LEFT JOIN order_label_prints label ON label.order_id=o.id
    LEFT JOIN (SELECT source_order_item_id,
        MAX(CASE WHEN status IN ('pending','suggested','approved','pending_purchase') THEN 1 ELSE 0 END) AS has_pending,
        MAX(CASE WHEN status IN ('purchased','partial_inbound') THEN 1 ELSE 0 END) AS has_in_transit
      FROM procurement_requests WHERE status<>'cancelled' AND source_order_item_id IS NOT NULL GROUP BY source_order_item_id) procurement
      ON procurement.source_order_item_id=item.id
    WHERE DATE(DATE_ADD(o.ordered_at, INTERVAL 8 HOUR))=?
      AND LOWER(CONCAT_WS(' ',o.status,o.tracking_stage,o.logistics_status)) NOT REGEXP 'cancel|return|reject|delivering|delivered|posting_received'
    GROUP BY o.id ORDER BY o.ordered_at ASC LIMIT 500`, [statisticsDate]);
  const normalized = rows.map((row) => {
    let reason = "printed_not_transported";
    if (Number(row.has_pending_procurement)) reason = "not_procured";
    else if (Number(row.has_in_transit_procurement)) reason = "procurement_in_transit";
    else if (Number(row.has_stock_shortage)) reason = "insufficient_stock";
    else if (!Number(row.printed)) reason = "stock_ready_unprinted";
    const labels = { not_procured: "尚未采购", procurement_in_transit: "采购在途", insufficient_stock: "库存不足", stock_ready_unprinted: "有库存但未打印", printed_not_transported: "已打印但未运输" };
    return { ...row, reason, reason_label: labels[reason], warning: ["stock_ready_unprinted", "printed_not_transported"].includes(reason) };
  });
  const summary = normalized.reduce((result, row) => { result.total += 1; result[row.reason] = (result[row.reason] || 0) + 1; if (row.warning) result.warning += 1; return result; }, { total: 0, warning: 0 });
  const done = Math.max(0, Number(task.target_count || 0) - normalized.length);
  const status = done >= Number(task.target_count || 0) ? "done" : "doing";
  await mysqlExecute("UPDATE team_tasks SET done_count=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1", [done, status, taskId]);
  return { rows: normalized, summary, progress: { done, status } };
}

export async function createTeamTaskMysql(body = {}, sessionPersonId = null) {
  ensureMysqlEnabled();
  await ensureTeamTasksSchema();
  const payload = buildPayload(body, sessionPersonId);
  const isDevelopmentPlan = await applyDevelopmentPlanPayload(payload, body);
  await assertActivePerson(payload.ownerPersonId, "负责人");
  await assertCollaborators(payload.collaboratorIds);
  const result = await mysqlExecute(`
    INSERT INTO team_tasks (
      title, work_type, owner_person_id, collaborator_person_ids_json, period,
      status, priority, target_count, done_count, unit, start_at, due_at,
      related_object, result_note, quality_score, created_by_person_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    payload.title,
    payload.workType,
    payload.ownerPersonId,
    JSON.stringify(payload.collaboratorIds),
    payload.period,
    payload.status,
    payload.priority,
    payload.target,
    payload.done,
    payload.unit,
    payload.startAt,
    payload.dueAt,
    payload.related,
    payload.result,
    payload.quality,
    payload.createdByPersonId
  ]);
  if (!isDevelopmentPlan) await saveTaskLink(Number(result.insertId), payload);
  return { ok: true, id: Number(result.insertId) };
}

export async function updateTeamTaskMysql(id, body = {}) {
  ensureMysqlEnabled();
  await ensureTeamTasksSchema();
  const taskId = Number(id);
  if (!taskId) throw new Error("任务不存在");
  const existing = await mysqlQuery("SELECT id, automation_key FROM team_tasks WHERE id = ? AND active = 1 LIMIT 1", [taskId]);
  if (!existing[0]) throw new Error("任务不存在");
  const payload = buildPayload(body);
  await assertActivePerson(payload.ownerPersonId, "负责人");
  if (String(existing[0].automation_key || "").startsWith("development_idea:")) {
    const ideaId = Number(existing[0].automation_key.split(":")[1]);
    await mysqlExecute("UPDATE product_development_ideas SET claimed_at=IF(assignee_person_id <=> ?,claimed_at,NULL),assignee_person_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1", [payload.ownerPersonId, payload.ownerPersonId, ideaId]);
    await syncDevelopmentIdeaTasks();
    return { ok: true };
  }
  if (/^(procurement_daily|shipping_daily):/.test(String(existing[0].automation_key || ""))) {
    if (!payload.ownerPersonId) throw new Error("缺少当前任务负责人（owner_person_id），请在任务详情中选择人员后点击“保存负责人”。");
    await mysqlExecute("UPDATE team_tasks SET owner_person_id=?,owner_manually_assigned=1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1", [payload.ownerPersonId, taskId]);
    return { ok: true };
  }
  if (existing[0].automation_key && !String(existing[0].automation_key).startsWith("idea_scope:")) {
    await mysqlExecute("UPDATE team_tasks SET owner_person_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1", [payload.ownerPersonId, taskId]);
    return { ok: true };
  }
  const storedRows = await mysqlQuery("SELECT related_object FROM team_tasks WHERE id = ? AND active = 1", [taskId]);
  if (readDevelopmentPlan(storedRows[0]?.related_object) && !readDevelopmentPlan(body.related ?? body.related_object)) {
    throw new Error("车型开发任务缺少车型明细（related.models），请从任务中心打开任务后编辑，不能覆盖为普通任务。");
  }
  const storedPlan = readDevelopmentPlan(storedRows[0]?.related_object);
  if (storedPlan?.source_idea_id) {
    const incoming = readDevelopmentPlan(body.related ?? body.related_object);
    body = { ...body, related: { ...incoming, source_idea_id: storedPlan.source_idea_id, group_key: storedPlan.group_key } };
  }
  const historicalDraftIds = new Set(storedPlan ? [...storedPlan.models.flatMap(row => row.draft_ids), ...(storedPlan.unallocated_draft_ids || [])] : []);
  const allowedLegacyCategoryKeys = new Set((storedPlan?.models || []).map((row) => `${row.brand || storedPlan.brand}\n${row.category || storedPlan.category}`));
  const isDevelopmentPlan = await applyDevelopmentPlanPayload(payload, body, { historicalDraftIds, allowedLegacyCategoryKeys });
  await assertCollaborators(payload.collaboratorIds);
  await mysqlExecute(`
    UPDATE team_tasks SET
      title = ?,
      work_type = ?,
      owner_person_id = ?,
      collaborator_person_ids_json = ?,
      period = ?,
      status = ?,
      priority = ?,
      target_count = ?,
      done_count = ?,
      unit = ?,
      start_at = ?,
      due_at = ?,
      related_object = ?,
      result_note = ?,
      quality_score = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND active = 1
  `, [
    payload.title,
    payload.workType,
    payload.ownerPersonId,
    JSON.stringify(payload.collaboratorIds),
    payload.period,
    payload.status,
    payload.priority,
    payload.target,
    payload.done,
    payload.unit,
    payload.startAt,
    payload.dueAt,
    payload.related,
    payload.result,
    payload.quality,
    taskId
  ]);
  if (!isDevelopmentPlan) await saveTaskLink(taskId, payload);
  return { ok: true };
}

export async function deleteTeamTaskMysql(id) {
  ensureMysqlEnabled();
  await ensureTeamTasksSchema();
  const taskId = Number(id);
  if (!taskId) throw new Error("任务不存在");
  await mysqlExecute("UPDATE team_tasks SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [taskId]);
  return { ok: true };
}

function normalizeProjectRow(row = {}) {
  return {
    id: Number(row.id), name: row.name || "", code: row.code || "", category: row.category || "",
    owner_person_id: row.owner_person_id ? Number(row.owner_person_id) : null,
    owner_name: row.owner_name || "", participant_person_ids: parseJsonArray(row.participant_person_ids_json),
    market: row.market || "", status: row.status || "planning", priority: row.priority || "medium",
    start_at: dateOnly(row.start_at), due_at: dateOnly(row.due_at),
    target_development_count: Number(row.target_development_count || 0),
    target_listing_count: Number(row.target_listing_count || 0), target_success_count: Number(row.target_success_count || 0),
    target_revenue: Number(row.target_revenue || 0), description: row.description || "", risk_note: row.risk_note || "",
    candidate_count: Number(row.candidate_count || 0), listed_count: Number(row.listed_count || 0),
    task_count: Number(row.task_count || 0), done_task_count: Number(row.done_task_count || 0),
    created_at: row.created_at || "", updated_at: row.updated_at || ""
  };
}

function buildProjectPayload(body = {}, sessionPersonId = null) {
  const name = normalizeText(body.name, 255);
  if (!name) throw new Error("请填写项目名称");
  return {
    name, code: normalizeText(body.code, 64), category: normalizeText(body.category, 128),
    ownerPersonId: normalizePersonId(body.owner_person_id), participantIds: normalizeCollaborators(body.participant_person_ids),
    market: normalizeText(body.market, 128) || "Ozon 俄罗斯",
    status: normalizeChoice(body.status, "planning", VALID_PROJECT_STATUSES),
    priority: normalizeChoice(body.priority, "medium", VALID_PRIORITIES),
    startAt: normalizeDate(body.start_at), dueAt: normalizeDate(body.due_at),
    targetDevelopmentCount: Math.trunc(normalizeNumber(body.target_development_count)),
    targetListingCount: Math.trunc(normalizeNumber(body.target_listing_count)),
    targetSuccessCount: Math.trunc(normalizeNumber(body.target_success_count)), targetRevenue: normalizeNumber(body.target_revenue),
    description: normalizeText(body.description, 5000), riskNote: normalizeText(body.risk_note, 5000),
    createdByPersonId: normalizePersonId(sessionPersonId)
  };
}

export async function developmentProjectsMysql() {
  ensureMysqlEnabled(); await ensureTeamTasksSchema();
  const rows = await mysqlQuery(`
    SELECT project.*, person.name AS owner_name,
      COUNT(DISTINCT candidate.id) AS candidate_count,
      COUNT(DISTINCT CASE WHEN candidate.status IN ('listed','validation_7d','validation_30d','scale','optimize') THEN candidate.id END) AS listed_count,
      COUNT(DISTINCT link.task_id) AS task_count,
      COUNT(DISTINCT CASE WHEN task.status = 'done' THEN task.id END) AS done_task_count
    FROM product_development_projects project
    LEFT JOIN people person ON person.id = project.owner_person_id
    LEFT JOIN product_development_candidates candidate ON candidate.project_id = project.id AND candidate.active = 1
    LEFT JOIN product_development_task_links link ON link.project_id = project.id
    LEFT JOIN team_tasks task ON task.id = link.task_id AND task.active = 1
    WHERE project.active = 1 GROUP BY project.id ORDER BY project.updated_at DESC, project.id DESC
  `);
  return rows.map(normalizeProjectRow);
}

export async function developmentIdeasMysql() {
  ensureMysqlEnabled(); await ensureTeamTasksSchema();
  const rows = await mysqlQuery(`SELECT idea.*,
      COALESCE(idea.development_started_at,
        CASE WHEN idea.status<>'idea' AND idea.assignee_person_id IS NOT NULL AND idea.target_product_count>0 AND idea.development_due_at IS NOT NULL THEN idea.updated_at END
      ) AS effective_development_started_at,
      person.name AS created_by_name, assignee.name AS assignee_name, product.name AS product_name,
      COUNT(DISTINCT idea_product.product_id) AS linked_product_count,
      COALESCE(MAX(draft_stats.draft_count),0) AS draft_count,
      COALESCE(MAX(draft_stats.output_count),0) AS output_count
    FROM product_development_ideas idea LEFT JOIN people person ON person.id=idea.created_by_person_id
    LEFT JOIN people assignee ON assignee.id=idea.assignee_person_id
    LEFT JOIN products product ON product.id=idea.product_id AND product.active=1
    LEFT JOIN product_development_idea_products idea_product ON idea_product.idea_id=idea.id
    LEFT JOIN (
      SELECT idea_draft.idea_id, COUNT(DISTINCT draft.id) AS draft_count,
        SUM(GREATEST(1,
        COALESCE(
          CASE WHEN JSON_VALID(draft.template_payload_json) THEN JSON_LENGTH(JSON_EXTRACT(draft.template_payload_json,'$.editable_payload.variants')) END,
          CASE WHEN JSON_VALID(draft.template_payload_json) THEN JSON_LENGTH(JSON_EXTRACT(draft.template_payload_json,'$.variants')) END,
          CASE WHEN JSON_VALID(draft.manual_facts_json) THEN JSON_LENGTH(JSON_EXTRACT(draft.manual_facts_json,'$.variants')) END,
          1
        ))) AS output_count
      FROM product_development_idea_drafts idea_draft
      JOIN listing_drafts draft ON draft.id=idea_draft.draft_id AND draft.status<>'deleted'
      GROUP BY idea_draft.idea_id
    ) draft_stats ON draft_stats.idea_id=idea.id
    WHERE idea.active=1 GROUP BY idea.id
    ORDER BY idea.created_at DESC, idea.id DESC`);
  const ideaIds = rows.map((row) => Number(row.id)).filter(Boolean);
  const draftRows = ideaIds.length ? await mysqlQuery(`SELECT idea_draft.idea_id, draft.id, draft.product_name, draft.status,
      draft.development_type, draft.parent_draft_id, draft.updated_at
    FROM product_development_idea_drafts idea_draft
    JOIN listing_drafts draft ON draft.id=idea_draft.draft_id AND draft.status<>'deleted'
    WHERE idea_draft.idea_id IN (${ideaIds.map(() => "?").join(",")})
    ORDER BY draft.updated_at DESC, draft.id DESC`, ideaIds) : [];
  const draftsByIdea = new Map();
  for (const draft of draftRows) {
    const key = Number(draft.idea_id); const list = draftsByIdea.get(key) || [];
    if (list.length < 5) list.push({ ...draft, id: Number(draft.id), parent_draft_id: draft.parent_draft_id ? Number(draft.parent_draft_id) : null });
    draftsByIdea.set(key, list);
  }
  const ideaRows = rows.map((row) => ({ ...row, id: Number(row.id), urgency: Number(row.urgency), importance: Number(row.importance),
    product_id: row.product_id ? Number(row.product_id) : null, candidate_id: row.candidate_id ? Number(row.candidate_id) : null,
    created_by_person_id: row.created_by_person_id ? Number(row.created_by_person_id) : null,
    assignee_person_id: row.assignee_person_id ? Number(row.assignee_person_id) : null,
    target_product_count: Number(row.target_product_count || 0), linked_product_count: Number(row.linked_product_count || 0),
    development_started_at: row.effective_development_started_at || row.development_started_at || null,
    draft_count: Number(row.draft_count || 0), output_count: Number(row.output_count || 0), drafts: draftsByIdea.get(Number(row.id)) || [], order_count: 0 }));
  const tasks = await teamTasksMysql({ type: "product_development" });
  for (const idea of ideaRows) {
    const children = tasks.filter(task => task.source_idea_id === idea.id);
    if (!children.length) continue;
    idea.development_tasks = children.map(task => ({ key: task.development_plan.group_key, task_id: task.id, models: task.development_plan.models }));
    idea.tasks = children;
    idea.development_scopes = children.flatMap(task => task.development_scopes);
    idea.development_brand = [...new Set(idea.development_scopes.map(row => row.brand))].join('、');
    idea.development_category = [...new Set(idea.development_scopes.map(row => row.category))].join('、');
    idea.target_product_count = children.reduce((sum, task) => sum + task.target, 0);
    idea.output_count = children.reduce((sum, task) => sum + task.done, 0);
  }
  const taskIdeas = tasks.filter((task) => task.development_plan && !task.source_idea_id).map((task) => ({
    id: `task:${task.id}`, task_id: task.id, task, title: task.title, note: task.development_plan.notes,
    development_scopes: task.development_scopes, development_brand: task.development_plan.brand, development_category: task.development_plan.category,
    assignee_person_id: task.owner_person_id, assignee_name: task.owner_name,
    target_product_count: task.target, output_count: task.done, development_due_at: task.due_at,
    created_at: task.created_at, status: task.status, urgency: 5, importance: 5
  }));
  return [...ideaRows, ...taskIdeas].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)
    || Number(b.task_id || b.id) - Number(a.task_id || a.id));
}

export async function linkDevelopmentIdeaDraftMysql(id, body = {}) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema();
  const ideaId = normalizePersonId(id);
  const draftIds = Array.from(new Set([...(Array.isArray(body.draft_ids) ? body.draft_ids : []), body.draft_id || body.draftId]
    .map(normalizePersonId).filter(Boolean)));
  if (!ideaId || !draftIds.length) throw new Error("请选择要关联的草稿");
  const ideas = await mysqlQuery("SELECT id,assignee_person_id FROM product_development_ideas WHERE id=? AND active=1 LIMIT 1", [ideaId]);
  if (!ideas.length) throw new Error("产品开发任务不存在");
  const assigneePersonId = normalizePersonId(ideas[0].assignee_person_id);
  if (!assigneePersonId) throw new Error("请先为产品开发任务指定负责人");
  const placeholders = draftIds.map(() => "?").join(",");
  const drafts = await mysqlQuery(`SELECT id,created_by_person_id FROM listing_drafts WHERE id IN (${placeholders}) AND status<>'deleted'`, draftIds);
  if (drafts.length !== draftIds.length) throw new Error("选中的草稿不存在或已删除");
  if (drafts.some((draft) => normalizePersonId(draft.created_by_person_id) !== assigneePersonId)) {
    throw new Error("只能关联当前任务指定人员创建的草稿");
  }
  const values = draftIds.map(() => "(?,?)").join(",");
  await mysqlExecute(`INSERT IGNORE INTO product_development_idea_drafts (idea_id,draft_id) VALUES ${values}`,
    draftIds.flatMap((draftId) => [ideaId, draftId]));
  operationalTasksRefreshedAt = 0;
  return { ok: true, idea_id: ideaId, draft_id: draftIds.length === 1 ? draftIds[0] : null, draft_ids: draftIds, linked_count: draftIds.length };
}

export async function developmentInventoryCategoriesMysql() {
  ensureMysqlEnabled(); await ensureTeamTasksSchema();
  const rows = await mysqlQuery(`SELECT TRIM(p.inventory_category) AS category,
      COUNT(*) AS product_count, COUNT(DISTINCT NULLIF(TRIM(p.vehicle_brand), '')) AS brand_count,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM sku_mappings sm WHERE sm.product_id=p.id AND sm.active=1) THEN 1 ELSE 0 END) AS listed_count
    FROM products p
    WHERE p.active=1 AND TRIM(COALESCE(p.inventory_category, ''))<>'' AND (
      COALESCE(p.product_type, 'main')<>'selection' OR COALESCE(p.selection_status, 'draft')='listed'
      OR EXISTS (SELECT 1 FROM sku_mappings inventory_sm WHERE inventory_sm.product_id=p.id AND inventory_sm.active=1)
      OR EXISTS (SELECT 1 FROM inventory_movements inventory_im WHERE inventory_im.product_id=p.id)
    )
    GROUP BY TRIM(p.inventory_category)
    ORDER BY product_count DESC, category ASC`);
  return rows.map((row) => ({ id: `category:${row.category}`, name: row.category, category: row.category, virtual: true,
    candidate_count: Number(row.product_count || 0), product_count: Number(row.product_count || 0),
    brand_count: Number(row.brand_count || 0), listed_count: Number(row.listed_count || 0) }));
}

// Coordinates survive regrouping; task keys survive ordinary edits.
async function saveDevelopmentIdeaMatrix(ideaId, body, sessionPersonId = null) {
  const groups = body.development_tasks;
  if (!groups.length || groups.length > 100) throw new Error("请选择 1–100 个开发任务（development_tasks），在开发坐标表中选择品牌、类目和车型。");
  const owner = normalizePersonId(body.assignee_person_id);
  await assertActivePerson(owner, "开发负责人");
  const keys = new Set(); const coordinates = new Set(); const cells = new Map();
  const coordinate = (row, plan) => JSON.stringify([row.brand || plan.brand, row.category || plan.category, Number(row.model_id)]);
  const prepared = [];
  const catalogs = await Promise.all([aiVehicleCatalog(), inventoryProductNamingOptions({ type: "category" })]);
  for (const group of groups) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(group.key || "") || keys.has(group.key)) throw new Error("任务分组标识（key）无效或重复，请重新打开灵感编辑。");
    keys.add(group.key);
    const first = group.models?.[0];
    const related = { kind: "development_matrix", brand: first?.brand, category: first?.category, scope: first?.scope,
      group_key: group.key, notes: normalizeText(body.note, 2000), models: (group.models || []).map(row => ({ ...row, draft_ids: [] })) };
    const payload = { ownerPersonId: owner };
    await applyDevelopmentPlanPayload(payload, { type: "product_development", owner_person_id: owner, due_at: body.development_due_at || "", related }, { allowUnassigned: true, catalogs });
    const plan = JSON.parse(payload.related);
    for (const row of plan.models) {
      const key = coordinate(row, plan); const cell = JSON.stringify([row.brand || plan.brand, row.category || plan.category]);
      if (coordinates.has(key) || (cells.has(cell) && cells.get(cell) !== group.key)) throw new Error("同一品牌＋类目（brand/category）不能拆进多个任务，请在坐标表合并该交叉格的车型。");
      coordinates.add(key); cells.set(cell, group.key);
    }
    prepared.push(plan);
  }
  const total = prepared.reduce((sum, plan) => sum + plan.models.reduce((n, row) => n + row.target, 0), 0);
  const values = [normalizeText(body.title, 255), normalizeImageUrl(body.image_url), normalizeHttpUrl(body.source_url, "参考链接"), normalizeText(body.note, 5000),
    normalizeScore(body.urgency), normalizeScore(body.importance), owner, total, normalizeDate(body.development_due_at), prepared[0].brand, prepared[0].category];
  await withMysqlTransaction(async connection => {
    let previousIdea = null;
    if (ideaId) {
      const [ideas] = await connection.execute("SELECT id,development_matrix_enabled,assignee_person_id,development_due_at,created_by_person_id FROM product_development_ideas WHERE id=? AND active=1 FOR UPDATE", [ideaId]);
      if (!ideas.length) throw new Error("灵感不存在或已停用");
      previousIdea = ideas[0];
    } else {
      const [result] = await connection.execute("INSERT INTO product_development_ideas (title,created_by_person_id) VALUES (?,?)", [values[0], normalizePersonId(sessionPersonId)]);
      ideaId = Number(result.insertId);
    }
    const [existing] = await connection.execute(`SELECT id,automation_key,related_object,active,owner_person_id,due_at FROM team_tasks
      WHERE automation_key LIKE CONCAT('idea_scope:',?,':%') OR automation_key=CONCAT('development_idea:',?) FOR UPDATE`, [ideaId, ideaId]);
    const byCoordinate = new Map(); const pending = new Set();
    for (const task of existing) {
      if (Number(task.active) === 0) continue;
      const plan = readDevelopmentPlan(task.related_object);
      if (!plan) continue;
      for (const row of plan.models) byCoordinate.set(coordinate(row, plan), row.draft_ids || []);
      for (const id of plan.unallocated_draft_ids || []) pending.add(id);
    }
    const [legacyDrafts] = previousIdea?.development_matrix_enabled ? [[]] : await connection.execute("SELECT draft_id FROM product_development_idea_drafts WHERE idea_id=?", [ideaId]);
    for (const draft of legacyDrafts) pending.add(Number(draft.draft_id));
    const allocated = new Set();
    for (const plan of prepared) {
      plan.source_idea_id = ideaId;
      for (const row of plan.models) {
        row.draft_ids = byCoordinate.get(coordinate(row, plan)) || [];
        for (const id of row.draft_ids) allocated.add(id);
      }
    }
    // Removed coordinates retain their results in the explicit allocation tray.
    for (const ids of byCoordinate.values()) for (const id of ids) if (!allocated.has(id)) pending.add(id);
    for (const id of allocated) pending.delete(id);
    if (pending.size) prepared[0].unallocated_draft_ids = [...pending];
    const retained = new Set();
    for (const [index, plan] of prepared.entries()) {
      const key = `idea_scope:${ideaId}:${plan.group_key}`;
      const previous = existing.find(task => task.automation_key === key)
        || (index === 0 ? existing.find(task => task.automation_key === `development_idea:${ideaId}`) : null);
      const taskOwner = previous && normalizePersonId(previousIdea?.assignee_person_id) === owner ? normalizePersonId(previous.owner_person_id) : owner;
      const taskDue = previous && (dateOnly(previousIdea?.development_due_at) || null) === values[8] ? (dateOnly(previous.due_at) || null) : values[8];
      const payload = { ownerPersonId: taskOwner };
      await applyDevelopmentPlanPayload(payload, { type: "product_development", owner_person_id: taskOwner, due_at: taskDue || "", related: plan }, { allowUnassigned: true, preserveHistoricalDrafts: true, catalogs });
      const scopes = [...new Set(plan.models.map(row => `${row.brand || plan.brand} · ${row.category || plan.category}`))];
      const title = normalizeText(`${values[0]} · ${scopes.join(' / ')}`, 255);
      const params = [title, taskOwner, payload.target, payload.done, payload.status, taskDue, payload.related, payload.deliverable, key];
      if (previous) {
        await connection.execute(`UPDATE team_tasks SET title=?,owner_person_id=?,target_count=?,done_count=?,status=?,due_at=?,related_object=?,result_note=?,automation_key=?,unit='SKU',active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`, [...params, previous.id]);
        retained.add(Number(previous.id));
      } else {
        const [result] = await connection.execute(`INSERT INTO team_tasks (title,owner_person_id,target_count,done_count,status,due_at,related_object,result_note,automation_key,work_type,unit,period,created_by_person_id)
          VALUES (?,?,?,?,?,?,?,?,?,'product_development','SKU','week',?)`, [...params, normalizePersonId(previousIdea?.created_by_person_id || sessionPersonId)]);
        retained.add(Number(result.insertId));
      }
    }
    for (const task of existing) if (!retained.has(Number(task.id))) await connection.execute("UPDATE team_tasks SET active=0 WHERE id=?", [task.id]);
    await connection.execute(`UPDATE product_development_ideas SET title=?,image_url=?,source_url=?,note=?,urgency=?,importance=?,
      assignee_person_id=?,target_product_count=?,development_due_at=?,development_brand=?,development_category=?,development_matrix_enabled=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`, [...values, ideaId]);
  });
  operationalTasksRefreshedAt = 0;
  return { ok: true, id: ideaId, task_count: prepared.length };
}

async function developmentIdeaScope(body) {
  const brand = normalizeText(body.development_brand, 255);
  const category = normalizeText(body.development_category, 255);
  if (!brand || !category) throw new Error("灵感开发任务缺少汽车品牌或开发类目（development_brand/development_category），请在灵感编辑中选择品牌和类目后保存；非汽车产品请选择“非汽车”。");
  const [catalog, categories] = await Promise.all([aiVehicleCatalog(), inventoryProductNamingOptions({ type: "category" })]);
  if (brand !== "非汽车" && !catalog.brands.some((row) => row.name === brand)) throw new Error("灵感汽车品牌（development_brand）不在车型目录中，请在灵感编辑中重新选择。");
  if (!categories.rows.some((row) => row.value === category)) throw new Error("灵感开发类目（development_category）不在已审核核心品名中，请在灵感编辑中重新选择。");
  return { brand, category };
}

export async function createDevelopmentIdeaMysql(body = {}, sessionPersonId = null) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema(); const title = normalizeText(body.title, 255);
  if (!title) throw new Error("请填写灵感标题");
  if (Array.isArray(body.development_tasks)) return saveDevelopmentIdeaMatrix(null, body, sessionPersonId);
  const scope = await developmentIdeaScope(body);
  const assigneePersonId = normalizePersonId(body.assignee_person_id);
  if (assigneePersonId) await assertActivePerson(assigneePersonId, "开发负责人");
  const targetProductCount = Math.max(0, Math.floor(Number(body.target_product_count || 0)));
  const developmentDueAt = normalizeDate(body.development_due_at);
  const result = await mysqlExecute(`INSERT INTO product_development_ideas
    (title,image_url,source_url,note,urgency,importance,created_by_person_id,assignee_person_id,target_product_count,development_due_at,development_brand,development_category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [title, normalizeImageUrl(body.image_url), normalizeHttpUrl(body.source_url, "参考链接"), normalizeText(body.note, 5000),
    normalizeScore(body.urgency), normalizeScore(body.importance), normalizePersonId(sessionPersonId), assigneePersonId, targetProductCount, developmentDueAt, scope.brand, scope.category]);
  operationalTasksRefreshedAt = 0;
  return { ok: true, id: Number(result.insertId) };
}

export async function updateDevelopmentIdeaMysql(id, body = {}) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema(); const ideaId = normalizePersonId(id);
  const title = normalizeText(body.title, 255); if (!ideaId) throw new Error("灵感不存在"); if (!title) throw new Error("请填写灵感标题");
  if (Array.isArray(body.development_tasks)) return saveDevelopmentIdeaMatrix(ideaId, body);
  const scope = await developmentIdeaScope(body);
  const assigneePersonId = normalizePersonId(body.assignee_person_id);
  if (assigneePersonId) await assertActivePerson(assigneePersonId, "开发负责人");
  const targetProductCount = Math.max(0, Math.floor(Number(body.target_product_count || 0)));
  const developmentDueAt = normalizeDate(body.development_due_at);
  await mysqlExecute(`UPDATE product_development_ideas SET title=?,image_url=?,source_url=?,note=?,urgency=?,importance=?,
      assignee_person_id=?,target_product_count=?,development_due_at=?,development_brand=?,development_category=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`,
    [title, normalizeImageUrl(body.image_url), normalizeHttpUrl(body.source_url, "参考链接"), normalizeText(body.note, 5000), normalizeScore(body.urgency), normalizeScore(body.importance),
      assigneePersonId, targetProductCount, developmentDueAt, scope.brand, scope.category, ideaId]);
  operationalTasksRefreshedAt = 0;
  return { ok: true };
}

export async function startDevelopmentIdeaMysql(id) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema(); const ideaId = normalizePersonId(id);
  const rows = await mysqlQuery("SELECT * FROM product_development_ideas WHERE id=? AND active=1 LIMIT 1", [ideaId]);
  const idea = rows[0]; if (!idea) throw new Error("灵感不存在或已停用");
  const missing = [];
  if (!idea.assignee_person_id) missing.push("指定人员");
  if (Number(idea.target_product_count || 0) < 1) missing.push("产品数量");
  if (!idea.development_due_at) missing.push("截止时间");
  if (missing.length) throw new Error(`请先填写${missing.join("、")}，再进入产品开发`);
  await mysqlExecute("UPDATE product_development_ideas SET status=CASE WHEN claimed_at IS NOT NULL THEN 'developing' ELSE 'assigned' END,development_started_at=COALESCE(development_started_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?", [ideaId]);
  operationalTasksRefreshedAt = 0;
  return { ok: true, id: ideaId };
}

export async function claimDevelopmentIdeaMysql(id, sessionPersonId = null) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema(); const ideaId = normalizePersonId(id); const personId = normalizePersonId(sessionPersonId);
  if (!personId) throw new Error("当前登录账号未关联人员，无法认领任务");
  const rows = await mysqlQuery("SELECT assignee_person_id,status FROM product_development_ideas WHERE id=? AND active=1 LIMIT 1", [ideaId]);
  const idea = rows[0];
  if (!idea || !["idea", "assigned", "developing"].includes(String(idea.status || ""))) throw new Error("灵感任务不存在或当前状态不支持认领");
  if (idea.assignee_person_id && Number(idea.assignee_person_id) !== personId) throw new Error("该任务已指定给其他人员，只有指定负责人本人可以认领");
  await withMysqlTransaction(async connection => {
    const [result] = await connection.execute(`UPDATE product_development_ideas
    SET assignee_person_id=?,status=CASE WHEN status='idea' THEN 'idea' ELSE 'developing' END,
      claimed_at=COALESCE(claimed_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND active=1 AND status IN ('idea','assigned','developing')
      AND (assignee_person_id IS NULL OR assignee_person_id=?)`, [personId, ideaId, personId]);
    if (!result.affectedRows) throw new Error("任务已被其他人员认领或状态已变化，请刷新灵感列表");
    await connection.execute("UPDATE team_tasks SET owner_person_id=? WHERE automation_key LIKE CONCAT('idea_scope:',?,':%') AND active=1 AND owner_person_id IS NULL", [personId, ideaId]);
  });
  operationalTasksRefreshedAt = 0;
  return { ok: true, id: ideaId };
}

export async function linkDevelopmentIdeaMysql(id, body = {}, sessionPersonId = null) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema(); const ideaId = normalizePersonId(id); const productId = normalizePersonId(body.product_id);
  if (!ideaId || !productId) throw new Error("灵感或库存产品不存在");
  const ideas = await mysqlQuery("SELECT * FROM product_development_ideas WHERE id=? AND active=1 LIMIT 1", [ideaId]);
  if (!ideas[0]) throw new Error("灵感不存在或已停用");
  const candidate = await createDevelopmentCandidateMysql({ product_id: productId, title: ideas[0].title, image_url: ideas[0].image_url,
    source_url: ideas[0].source_url, note: ideas[0].note, source_kind: "inspiration", source_id: String(ideaId), status: "idea" }, sessionPersonId);
  await mysqlExecute("UPDATE product_development_ideas SET product_id=?,candidate_id=?,status='developing',updated_at=CURRENT_TIMESTAMP WHERE id=?", [productId, candidate.id, ideaId]);
  await mysqlExecute("INSERT IGNORE INTO product_development_idea_products (idea_id,product_id) VALUES (?,?)", [ideaId, productId]);
  await mysqlExecute(`INSERT IGNORE INTO product_development_idea_drafts (idea_id,draft_id)
    SELECT ?,id FROM listing_drafts WHERE source_product_id=? AND status<>'deleted'`, [ideaId, productId]);
  return { ok: true, product_id: productId, candidate_id: Number(candidate.id) };
}

export async function deleteDevelopmentIdeaMysql(id) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema();
  await mysqlExecute("UPDATE product_development_ideas SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?", [Number(id)]);
  operationalTasksRefreshedAt = 0;
  return { ok: true };
}

export async function createDevelopmentProjectMysql(body = {}, sessionPersonId = null) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema(); const p = buildProjectPayload(body, sessionPersonId);
  await assertActivePerson(p.ownerPersonId, "项目负责人"); await assertCollaborators(p.participantIds);
  const result = await mysqlExecute(`INSERT INTO product_development_projects
    (name, code, category, owner_person_id, participant_person_ids_json, market, status, priority, start_at, due_at,
     target_development_count, target_listing_count, target_success_count, target_revenue, description, risk_note, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [p.name, p.code, p.category, p.ownerPersonId, JSON.stringify(p.participantIds), p.market, p.status, p.priority, p.startAt, p.dueAt,
    p.targetDevelopmentCount, p.targetListingCount, p.targetSuccessCount, p.targetRevenue, p.description, p.riskNote, p.createdByPersonId]);
  return { ok: true, id: Number(result.insertId) };
}

export async function updateDevelopmentProjectMysql(id, body = {}) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema(); const projectId = normalizePersonId(id); const p = buildProjectPayload(body);
  if (!projectId) throw new Error("项目不存在"); await assertActivePerson(p.ownerPersonId, "项目负责人");
  await mysqlExecute(`UPDATE product_development_projects SET name=?, code=?, category=?, owner_person_id=?, participant_person_ids_json=?, market=?,
    status=?, priority=?, start_at=?, due_at=?, target_development_count=?, target_listing_count=?, target_success_count=?, target_revenue=?,
    description=?, risk_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`,
  [p.name, p.code, p.category, p.ownerPersonId, JSON.stringify(p.participantIds), p.market, p.status, p.priority, p.startAt, p.dueAt,
    p.targetDevelopmentCount, p.targetListingCount, p.targetSuccessCount, p.targetRevenue, p.description, p.riskNote, projectId]);
  return { ok: true };
}

export async function deleteDevelopmentProjectMysql(id) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema();
  await mysqlExecute("UPDATE product_development_projects SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?", [Number(id)]);
  return { ok: true };
}

function normalizeCandidateRow(row = {}) {
  return {
    id: Number(row.id), product_id: row.product_id ? Number(row.product_id) : null,
    project_id: row.project_id ? Number(row.project_id) : null, project_name: row.project_name || "",
    title: row.product_name || row.title || "", category: row.inventory_category || row.category || "",
    brand: row.product_brand || row.brand || "", vehicle_model: row.product_vehicle_model || row.vehicle_model || "",
    owner_person_id: row.product_owner_person_id ? Number(row.product_owner_person_id) : (row.owner_person_id ? Number(row.owner_person_id) : null),
    owner_name: row.product_owner_name || row.owner_name || "",
    status: row.status || "idea", priority: row.priority || "medium", image_url: row.product_image_url || row.image_url || "",
    source_url: row.purchase_url || row.source_url || "",
    product_code: row.product_code || "", stock: Number(row.stock || 0), sku_count: Number(row.sku_count || 0),
    source_kind: row.source_kind || "manual", source_id: row.source_id || "", supplier_url: row.supplier_url || "",
    expected_price: Number(row.expected_price || 0), expected_cost: Number(row.expected_cost || 0),
    expected_margin_rate: Number(row.expected_margin_rate || 0), ip_risk: row.ip_risk || "unknown",
    planned_listing_at: dateOnly(row.planned_listing_at), note: row.note || "", decision_note: row.decision_note || "",
    task_count: Number(row.task_count || 0), done_task_count: Number(row.done_task_count || 0),
    created_at: row.created_at || "", updated_at: row.updated_at || ""
  };
}

function buildCandidatePayload(body = {}, sessionPersonId = null) {
  const title = normalizeText(body.title, 255); if (!title) throw new Error("请填写产品想法或名称");
  const price = normalizeNumber(body.expected_price); const cost = normalizeNumber(body.expected_cost);
  return {
    productId: normalizePersonId(body.product_id), projectId: normalizePersonId(body.project_id), title, category: normalizeText(body.category, 128), brand: normalizeText(body.brand, 128),
    vehicleModel: normalizeText(body.vehicle_model, 255), ownerPersonId: normalizePersonId(body.owner_person_id),
    status: normalizeChoice(body.status, "idea", VALID_CANDIDATE_STATUSES), priority: normalizeChoice(body.priority, "medium", VALID_PRIORITIES),
    imageUrl: normalizeText(body.image_url, 5000), sourceUrl: normalizeText(body.source_url, 5000),
    sourceKind: normalizeText(body.source_kind, 32) || "manual", sourceId: normalizeText(body.source_id, 128),
    supplierUrl: normalizeText(body.supplier_url, 5000), expectedPrice: price, expectedCost: cost,
    expectedMarginRate: price > 0 ? Math.max(0, Math.min(100, Number(body.expected_margin_rate ?? ((price - cost) / price * 100)))) : 0,
    ipRisk: normalizeText(body.ip_risk, 32) || "unknown", plannedListingAt: normalizeDate(body.planned_listing_at),
    note: normalizeText(body.note, 5000), decisionNote: normalizeText(body.decision_note, 5000), createdByPersonId: normalizePersonId(sessionPersonId)
  };
}

export async function developmentCandidatesMysql(query = {}) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema(); const where = ["candidate.active=1", "candidate.product_id IS NOT NULL"]; const params = [];
  const projectId = normalizePersonId(query.project_id); if (projectId) { where.push("candidate.project_id=?"); params.push(projectId); }
  const status = String(query.status || "").trim(); if (VALID_CANDIDATE_STATUSES.has(status)) { where.push("candidate.status=?"); params.push(status); }
  const rows = await mysqlQuery(`SELECT candidate.*, project.name AS project_name, person.name AS owner_name,
    product.name AS product_name, product.code AS product_code, product.image_url AS product_image_url,
    product.inventory_category, product.vehicle_brand AS product_brand, product.vehicle_model AS product_vehicle_model,
    product.owner_person_id AS product_owner_person_id, product_owner.name AS product_owner_name, product.purchase_url,
    COALESCE(stock.stock, 0) AS stock, COALESCE(skus.sku_count, 0) AS sku_count,
    COUNT(DISTINCT link.task_id) AS task_count, COUNT(DISTINCT CASE WHEN task.status='done' THEN task.id END) AS done_task_count
    FROM product_development_candidates candidate
    LEFT JOIN products product ON product.id=candidate.product_id AND product.active=1
    LEFT JOIN people product_owner ON product_owner.id=product.owner_person_id
    LEFT JOIN (SELECT product_id, SUM(quantity_delta) AS stock FROM inventory_movements GROUP BY product_id) stock ON stock.product_id=product.id
    LEFT JOIN (SELECT product_id, COUNT(*) AS sku_count FROM sku_mappings WHERE active=1 GROUP BY product_id) skus ON skus.product_id=product.id
    LEFT JOIN product_development_projects project ON project.id=candidate.project_id AND project.active=1
    LEFT JOIN people person ON person.id=candidate.owner_person_id
    LEFT JOIN product_development_task_links link ON link.candidate_id=candidate.id
    LEFT JOIN team_tasks task ON task.id=link.task_id AND task.active=1
    WHERE ${where.join(" AND ")} GROUP BY candidate.id ORDER BY candidate.updated_at DESC, candidate.id DESC`, params);
  return rows.map(normalizeCandidateRow);
}

export async function createDevelopmentCandidateMysql(body = {}, sessionPersonId = null) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema(); const p = buildCandidatePayload(body, sessionPersonId); await assertActivePerson(p.ownerPersonId, "产品负责人");
  if (p.productId) {
    const product = await mysqlQuery("SELECT id FROM products WHERE id=? AND active=1 LIMIT 1", [p.productId]);
    if (!product[0]) throw new Error("库存产品不存在或已停用");
    const existing = await mysqlQuery("SELECT id FROM product_development_candidates WHERE product_id=? AND active=1 LIMIT 1", [p.productId]);
    if (existing[0]) return { ok: true, id: Number(existing[0].id), existing: true };
  }
  const result = await mysqlExecute(`INSERT INTO product_development_candidates
    (product_id,project_id,title,category,brand,vehicle_model,owner_person_id,status,priority,image_url,source_url,source_kind,source_id,supplier_url,
     expected_price,expected_cost,expected_margin_rate,ip_risk,planned_listing_at,note,decision_note,created_by_person_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [p.productId,p.projectId,p.title,p.category,p.brand,p.vehicleModel,p.ownerPersonId,p.status,p.priority,p.imageUrl,p.sourceUrl,p.sourceKind,p.sourceId,
    p.supplierUrl,p.expectedPrice,p.expectedCost,p.expectedMarginRate,p.ipRisk,p.plannedListingAt,p.note,p.decisionNote,p.createdByPersonId]);
  return { ok: true, id: Number(result.insertId) };
}

export async function updateDevelopmentCandidateMysql(id, body = {}) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema(); const candidateId = normalizePersonId(id); const p = buildCandidatePayload(body); if (!candidateId) throw new Error("开发产品不存在");
  await assertActivePerson(p.ownerPersonId, "产品负责人");
  await mysqlExecute(`UPDATE product_development_candidates SET product_id=?,project_id=?,title=?,category=?,brand=?,vehicle_model=?,owner_person_id=?,status=?,priority=?,
    image_url=?,source_url=?,source_kind=?,source_id=?,supplier_url=?,expected_price=?,expected_cost=?,expected_margin_rate=?,ip_risk=?,planned_listing_at=?,
    note=?,decision_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`,
  [p.productId,p.projectId,p.title,p.category,p.brand,p.vehicleModel,p.ownerPersonId,p.status,p.priority,p.imageUrl,p.sourceUrl,p.sourceKind,p.sourceId,p.supplierUrl,
    p.expectedPrice,p.expectedCost,p.expectedMarginRate,p.ipRisk,p.plannedListingAt,p.note,p.decisionNote,candidateId]); return { ok: true };
}

export async function deleteDevelopmentCandidateMysql(id) {
  ensureMysqlEnabled(); await ensureTeamTasksSchema();
  await mysqlExecute("UPDATE product_development_candidates SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?", [Number(id)]); return { ok: true };
}
