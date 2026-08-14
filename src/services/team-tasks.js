import { isMysqlPrimaryEnabled, mysqlExecute, mysqlQuery } from "../mysql-pool.js";

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
  "warehouse"
]);
const VALID_PERIODS = new Set(["week", "month", "quarter", "year"]);
const VALID_STATUSES = new Set(["todo", "doing", "review", "done", "delayed"]);
const VALID_PRIORITIES = new Set(["high", "medium", "low"]);

let teamTasksSchemaReady = false;

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
      created_by_person_id BIGINT UNSIGNED NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_team_tasks_period_status (period, status, active),
      KEY idx_team_tasks_type_period (work_type, period, active),
      KEY idx_team_tasks_owner_period (owner_person_id, period, active),
      KEY idx_team_tasks_due (due_at, active)
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
    createdByPersonId: normalizePersonId(sessionPersonId)
  };
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

export async function teamTasksMysql(query = {}) {
  ensureMysqlEnabled();
  await ensureTeamTasksSchema();
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
  if (VALID_STATUSES.has(status)) {
    where.push("t.status = ?");
    params.push(status);
  }
  const rows = await mysqlQuery(`
    SELECT t.*, p.name AS owner_name, p.avatar_url AS owner_avatar_url
    FROM team_tasks t
    LEFT JOIN people p ON p.id = t.owner_person_id
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
  return rows.map(normalizeTeamTaskRow);
}

export async function createTeamTaskMysql(body = {}, sessionPersonId = null) {
  ensureMysqlEnabled();
  await ensureTeamTasksSchema();
  const payload = buildPayload(body, sessionPersonId);
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
  return { ok: true, id: Number(result.insertId) };
}

export async function updateTeamTaskMysql(id, body = {}) {
  ensureMysqlEnabled();
  await ensureTeamTasksSchema();
  const taskId = Number(id);
  if (!taskId) throw new Error("任务不存在");
  const existing = await mysqlQuery("SELECT id FROM team_tasks WHERE id = ? AND active = 1 LIMIT 1", [taskId]);
  if (!existing[0]) throw new Error("任务不存在");
  const payload = buildPayload(body);
  await assertActivePerson(payload.ownerPersonId, "负责人");
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
