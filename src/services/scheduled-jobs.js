import { randomUUID } from "node:crypto";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";

const DEFAULT_LOCK_TTL_MINUTES = 120;
const MAX_RESULT_STRING_LENGTH = 500;
const MAX_RESULT_ERRORS = 20;

function sqlDate(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function fromSqlDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  return new Date(String(value).replace(" ", "T") + "Z");
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + Math.max(1, Number(minutes || 1)) * 60 * 1000);
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function compactError(error) {
  return String(error?.message || error || "Unknown scheduled job error").slice(0, 4000);
}

function truncateText(value, maxLength = MAX_RESULT_STRING_LENGTH) {
  return String(value || "").slice(0, Math.max(1, Number(maxLength || MAX_RESULT_STRING_LENGTH)));
}

function summarizeAlertCollection(alerts) {
  if (Array.isArray(alerts)) return { count: alerts.length };
  if (!alerts || typeof alerts !== "object") return { count: 0 };
  const summary = {};
  for (const [key, value] of Object.entries(alerts)) {
    if (Array.isArray(value)) summary[key] = value.length;
    else if (value && typeof value === "object") {
      if (Array.isArray(value.rows)) summary[key] = value.rows.length;
      else if (Number.isFinite(Number(value.total))) summary[key] = Number(value.total);
      else if (Number.isFinite(Number(value.count))) summary[key] = Number(value.count);
    }
  }
  return summary;
}

function summarizeScheduledJobResult(jobKey, resultPayload = {}) {
  const payload = resultPayload && typeof resultPayload === "object" ? resultPayload : { value: resultPayload };
  if (jobKey === "advertising_sync" || jobKey === "advertising_today_sync") {
    return {
      status: String(payload.status || "success"),
      warning: truncateText(payload.warning || "", 1000),
      from: payload.from || "",
      to: payload.to || "",
      date: payload.date || "",
      imported: Number(payload.imported || 0),
      totalRows: Number(payload.total_rows || payload.totalRows || 0),
      okShops: Number(payload.okShops || 0),
      nonOkShops: Number(payload.nonOkShops || 0),
      hardErrors: Number(payload.hardErrors || 0),
      shopIds: Array.isArray(payload.shopIds) ? payload.shopIds.slice(0, 10) : [],
      errors: Array.isArray(payload.errors) ? payload.errors.slice(0, MAX_RESULT_ERRORS).map((item) => truncateText(item, 400)) : [],
      results: Array.isArray(payload.results)
        ? payload.results.slice(0, 10).map((item) => ({
            shop_id: Number(item?.shop_id || 0),
            shop_name: truncateText(item?.shop_name || "", 120),
            status: String(item?.status || ""),
            campaigns: Number(item?.campaigns || 0),
            fetched: Number(item?.fetched || 0),
            imported: Number(item?.imported || 0),
            error_code: item?.error_code ? String(item.error_code) : "",
            error: item?.error ? truncateText(item.error, 300) : ""
          }))
        : [],
      summaryTruncated: Array.isArray(payload.results) && payload.results.length > 10
    };
  }
  if (jobKey === "ozon_stock_sync") {
    return {
      status: String(payload.status || "success"),
      fetched: Number(payload.fetched || 0),
      upserted: Number(payload.upserted || 0),
      message: truncateText(payload.message || ""),
      errorCount: Array.isArray(payload.errors) ? payload.errors.length : 0,
      errors: Array.isArray(payload.errors) ? payload.errors.slice(0, MAX_RESULT_ERRORS).map((item) => truncateText(item, 300)) : [],
      alerts: summarizeAlertCollection(payload.alerts),
      summaryTruncated: true
    };
  }
  if (jobKey === "ozon_action_cleanup") {
    return {
      status: String(payload.status || "success"),
      stores: Number(payload.stores || 0),
      removed: Number(payload.removed || 0),
      failed: Number(payload.failed || 0),
      results: Array.isArray(payload.results)
        ? payload.results.slice(0, 20).map((item) => ({
            storeId: item?.storeId,
            storeName: truncateText(item?.storeName || "", 120),
            status: String(item?.status || ""),
            removed: Number(item?.removed || 0),
            error: item?.error ? truncateText(item.error, 300) : "",
            actionSummaries: Array.isArray(item?.actionSummaries) ? item.actionSummaries.slice(0, 8) : []
          }))
        : []
    };
  }
  return payload;
}

function isValidDailyTime(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ""));
}

function normalizeJobDefinition(definition = {}) {
  const key = String(definition.key || definition.job_key || "").trim();
  if (!key) throw new Error("Scheduled job definition is missing key");
  const scheduleType = String(definition.scheduleType || definition.schedule_type || "interval").trim();
  return {
    key,
    name: String(definition.name || key).trim(),
    category: String(definition.category || "maintenance").trim(),
    priority: String(definition.priority || "normal").trim(),
    scheduleType,
    intervalMinutes: Math.max(1, Number(definition.intervalMinutes || definition.interval_minutes || 60)),
    dailyTime: String(definition.dailyTime || definition.daily_time || "").slice(0, 5),
    enabled: definition.enabled === false ? 0 : 1,
    catchupEnabled: definition.catchupEnabled === false ? 0 : 1,
    maxCatchupRuns: Math.max(0, Number(definition.maxCatchupRuns ?? definition.max_catchup_runs ?? 1)),
    initialDelaySeconds: Math.max(0, Number(definition.initialDelaySeconds ?? definition.initial_delay_seconds ?? 0)),
    config: definition.config || {}
  };
}

function nextDailyRun(now, dailyTime) {
  const [hourRaw, minuteRaw] = String(dailyTime || "00:00").split(":");
  const hour = Math.min(Math.max(Number(hourRaw || 0), 0), 23);
  const minute = Math.min(Math.max(Number(minuteRaw || 0), 0), 59);
  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  let next = new Date(`${dateKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`);
  if (next <= now) {
    const tomorrow = new Date(next.getTime() + 24 * 60 * 60 * 1000);
    next = tomorrow;
  }
  return next;
}

function computeNextRun(job, base = new Date()) {
  if (String(job.schedule_type || job.scheduleType) === "daily") {
    return nextDailyRun(base, job.daily_time || job.dailyTime || "00:00");
  }
  return addMinutes(base, job.interval_minutes || job.intervalMinutes || 60);
}

function normalizeJobRow(row = {}) {
  return {
    id: Number(row.id || 0),
    key: row.job_key || "",
    name: row.job_name || "",
    category: row.category || "",
    priority: row.priority || "",
    scheduleType: row.schedule_type || "",
    intervalMinutes: Number(row.interval_minutes || 0),
    dailyTime: row.daily_time || "",
    enabled: Boolean(row.enabled),
    catchupEnabled: Boolean(row.catchup_enabled),
    maxCatchupRuns: Number(row.max_catchup_runs || 0),
    lastSuccessAt: row.last_success_at || null,
    lastAttemptAt: row.last_attempt_at || null,
    nextRunAt: row.next_run_at || null,
    lockedAt: row.locked_at || null,
    lockedBy: row.locked_by || "",
    failCount: Number(row.fail_count || 0),
    lastStatus: row.last_status || "",
    lastError: row.last_error || "",
    config: parseJson(row.config_json, {})
  };
}

function normalizeRunRow(row = {}) {
  return {
    id: Number(row.id || 0),
    jobKey: row.job_key || "",
    plannedFor: row.planned_for || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    status: row.status || "",
    mode: row.mode || "",
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, {}),
    errorMessage: row.error_message || ""
  };
}

function normalizeRunPreviewRow(row = {}) {
  return {
    id: Number(row.id || 0),
    jobKey: row.job_key || "",
    plannedFor: row.planned_for || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    status: row.status || "",
    mode: row.mode || "",
    result: parseJson(row.result_json, null),
    errorMessage: row.error_message || "",
    resultSize: Number(row.result_size || 0)
  };
}

export async function ensureScheduledJobTables() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      job_key VARCHAR(128) NOT NULL,
      job_name VARCHAR(255) NOT NULL,
      category VARCHAR(64) NOT NULL DEFAULT 'maintenance',
      priority VARCHAR(32) NOT NULL DEFAULT 'normal',
      schedule_type VARCHAR(32) NOT NULL DEFAULT 'interval',
      interval_minutes INT NOT NULL DEFAULT 60,
      daily_time VARCHAR(8) NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      catchup_enabled TINYINT(1) NOT NULL DEFAULT 1,
      max_catchup_runs INT NOT NULL DEFAULT 1,
      last_success_at DATETIME NULL,
      last_attempt_at DATETIME NULL,
      next_run_at DATETIME NULL,
      locked_at DATETIME NULL,
      locked_by VARCHAR(128) NULL,
      fail_count INT NOT NULL DEFAULT 0,
      last_status VARCHAR(32) NOT NULL DEFAULT '',
      last_error TEXT NULL,
      config_json LONGTEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_scheduled_jobs_key (job_key),
      KEY idx_scheduled_jobs_due (enabled, next_run_at),
      KEY idx_scheduled_jobs_category (category, priority)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      job_key VARCHAR(128) NOT NULL,
      planned_for DATETIME NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'running',
      mode VARCHAR(32) NOT NULL DEFAULT 'scheduled',
      payload_json LONGTEXT NULL,
      result_json LONGTEXT NULL,
      error_message TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_scheduled_job_runs_key_started (job_key, started_at),
      KEY idx_scheduled_job_runs_status (status, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS scheduled_job_run_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      run_id BIGINT UNSIGNED NOT NULL,
      job_key VARCHAR(128) NOT NULL,
      step_key VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'info',
      shop_id BIGINT NULL,
      shop_name VARCHAR(255) NULL,
      attempt INT NOT NULL DEFAULT 0,
      message TEXT NULL,
      detail_json LONGTEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_scheduled_job_run_events_run (run_id, created_at),
      KEY idx_scheduled_job_run_events_job (job_key, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const startedAtIndex = await mysqlQuery(`
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'scheduled_job_runs'
      AND index_name = 'idx_scheduled_job_runs_started_at'
    LIMIT 1
  `);
  if (!startedAtIndex[0]) {
    await mysqlExecute("CREATE INDEX idx_scheduled_job_runs_started_at ON scheduled_job_runs (started_at)");
  }
}

export async function registerScheduledJobs(definitions = []) {
  await ensureScheduledJobTables();
  const now = new Date();
  for (const rawDefinition of definitions) {
    const definition = normalizeJobDefinition(rawDefinition);
    const existingRows = await mysqlQuery("SELECT * FROM scheduled_jobs WHERE job_key = ? LIMIT 1", [definition.key]);
    const existing = existingRows[0];
    const initialNextRun = definition.scheduleType === "daily"
      ? computeNextRun(definition, now)
      : new Date(now.getTime() + definition.initialDelaySeconds * 1000);
    const nextRun = existing?.next_run_at ? existing.next_run_at : sqlDate(initialNextRun);
    await mysqlExecute(`
      INSERT INTO scheduled_jobs
        (job_key, job_name, category, priority, schedule_type, interval_minutes, daily_time,
         enabled, catchup_enabled, max_catchup_runs, next_run_at, config_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        job_name = VALUES(job_name),
        category = VALUES(category),
        priority = VALUES(priority),
        schedule_type = VALUES(schedule_type),
        interval_minutes = VALUES(interval_minutes),
        daily_time = VALUES(daily_time),
        enabled = VALUES(enabled),
        catchup_enabled = VALUES(catchup_enabled),
        max_catchup_runs = VALUES(max_catchup_runs),
        config_json = CASE
          WHEN config_json IS NULL OR config_json = '' THEN VALUES(config_json)
          ELSE config_json
        END,
        next_run_at = COALESCE(next_run_at, VALUES(next_run_at))
    `, [
      definition.key,
      definition.name,
      definition.category,
      definition.priority,
      definition.scheduleType,
      definition.intervalMinutes,
      definition.dailyTime || null,
      definition.enabled,
      definition.catchupEnabled,
      definition.maxCatchupRuns,
      nextRun,
      JSON.stringify(definition.config || {})
    ]);
  }
}

export async function listScheduledJobs(query = {}) {
  await ensureScheduledJobTables();
  const rows = await mysqlQuery(`
    SELECT *
    FROM scheduled_jobs
    ORDER BY FIELD(priority, 'critical', 'high', 'normal', 'low'), category, job_key
  `);
  const limit = Math.min(Math.max(Number(query.run_limit || query.runLimit || 5), 1), 20);
  const runs = await mysqlQuery(`
    SELECT id, job_key, planned_for, started_at, finished_at, status, mode, error_message, result_json,
           CHAR_LENGTH(COALESCE(result_json, '')) AS result_size
    FROM scheduled_job_runs
    ORDER BY started_at DESC
    LIMIT ?
  `, [limit * Math.max(rows.length, 1)]);
  const runsByJob = new Map();
  for (const run of runs) {
    const key = run.job_key || "";
    if (!runsByJob.has(key)) runsByJob.set(key, []);
    if (runsByJob.get(key).length < limit) runsByJob.get(key).push(normalizeRunPreviewRow(run));
  }
  return rows.map((row) => ({
    ...normalizeJobRow(row),
    recentRuns: runsByJob.get(row.job_key) || []
  }));
}

export async function scheduledJobRuns(query = {}) {
  await ensureScheduledJobTables();
  const params = [];
  const where = [];
  if (query.job_key || query.jobKey) {
    where.push("job_key = ?");
    params.push(String(query.job_key || query.jobKey));
  }
  const limit = Math.min(Math.max(Number(query.limit || 50), 1), 200);
  params.push(limit);
  const rows = await mysqlQuery(`
    SELECT *
    FROM scheduled_job_runs
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY started_at DESC
    LIMIT ?
  `, params);
  return rows.map(normalizeRunRow);
}

export async function scheduledJobRunEvents(query = {}) {
  await ensureScheduledJobTables();
  const params = [];
  const where = [];
  if (query.run_id || query.runId) {
    where.push("run_id = ?");
    params.push(Number(query.run_id || query.runId));
  }
  if (query.job_key || query.jobKey) {
    where.push("job_key = ?");
    params.push(String(query.job_key || query.jobKey));
  }
  const limit = Math.min(Math.max(Number(query.limit || 200), 1), 1000);
  params.push(limit);
  return await mysqlQuery(`
    SELECT id, run_id, job_key, step_key, status, shop_id, shop_name, attempt, message, detail_json, created_at
    FROM scheduled_job_run_events
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT ?
  `, params);
}

export async function logScheduledJobEvent(event = {}) {
  await ensureScheduledJobTables();
  const runId = Number(event.runId || event.run_id || 0);
  if (!runId) throw new Error("runId is required");
  await mysqlExecute(`
    INSERT INTO scheduled_job_run_events
      (run_id, job_key, step_key, status, shop_id, shop_name, attempt, message, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    runId,
    String(event.jobKey || event.job_key || ""),
    String(event.stepKey || event.step_key || "info"),
    String(event.status || "info"),
    event.shopId ? Number(event.shopId) : null,
    event.shopName ? String(event.shopName) : null,
    Math.max(0, Number(event.attempt || 0)),
    event.message ? truncateText(event.message, 4000) : null,
    event.detail === undefined ? null : JSON.stringify(event.detail)
  ]);
}

export async function updateScheduledJobState(body = {}) {
  await ensureScheduledJobTables();
  const jobKey = String(body.job_key || body.jobKey || body.key || "").trim();
  if (!jobKey) throw new Error("Missing scheduled job key");
  const enabled = body.enabled === true || body.enabled === 1 || body.enabled === "1" || body.enabled === "true" ? 1 : 0;
  const result = await mysqlExecute(`
    UPDATE scheduled_jobs
    SET enabled = ?, locked_at = IF(? = 0, NULL, locked_at), locked_by = IF(? = 0, NULL, locked_by)
    WHERE job_key = ?
  `, [enabled, enabled, enabled, jobKey]);
  if (Number(result.affectedRows || 0) !== 1) throw new Error(`Scheduled job not found: ${jobKey}`);
  const [row] = await mysqlQuery("SELECT * FROM scheduled_jobs WHERE job_key = ? LIMIT 1", [jobKey]);
  return normalizeJobRow(row);
}

export async function updateScheduledJobConfig(body = {}) {
  await ensureScheduledJobTables();
  const jobKey = String(body.job_key || body.jobKey || body.key || "").trim();
  if (!jobKey) throw new Error("Missing scheduled job key");
  const [existing] = await mysqlQuery("SELECT * FROM scheduled_jobs WHERE job_key = ? LIMIT 1", [jobKey]);
  if (!existing) throw new Error(`Scheduled job not found: ${jobKey}`);
  if (existing.locked_at) throw new Error(`Scheduled job is running: ${jobKey}`);

  const scheduleType = String(body.schedule_type || body.scheduleType || existing.schedule_type || "interval").trim();
  if (!["interval", "daily"].includes(scheduleType)) {
    throw new Error(`Unsupported schedule type: ${scheduleType}`);
  }

  let intervalMinutes = Number(body.interval_minutes ?? body.intervalMinutes ?? existing.interval_minutes ?? 60);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
    throw new Error("Interval minutes must be at least 1");
  }
  intervalMinutes = Math.floor(intervalMinutes);

  let dailyTime = String(body.daily_time ?? body.dailyTime ?? existing.daily_time ?? "").trim();
  if (scheduleType === "daily") {
    if (!isValidDailyTime(dailyTime)) throw new Error("Daily time must use HH:mm format");
    dailyTime = dailyTime.slice(0, 5);
  } else {
    dailyTime = "";
  }

  const catchupEnabled = body.catchup_enabled === undefined && body.catchupEnabled === undefined
    ? Number(existing.catchup_enabled || 0)
    : (body.catchup_enabled === true || body.catchup_enabled === 1 || body.catchup_enabled === "1" || body.catchup_enabled === "true" || body.catchupEnabled === true ? 1 : 0);

  let maxCatchupRuns = Number(body.max_catchup_runs ?? body.maxCatchupRuns ?? existing.max_catchup_runs ?? 1);
  if (!Number.isFinite(maxCatchupRuns) || maxCatchupRuns < 0) {
    throw new Error("Max catchup runs must be zero or greater");
  }
  maxCatchupRuns = Math.floor(maxCatchupRuns);

  const existingConfig = parseJson(existing.config_json, {});
  const configPatch = body.config && typeof body.config === "object" ? body.config : {};
  const mergedConfig = { ...existingConfig, ...configPatch };
  if (mergedConfig.timeoutMinutes !== undefined) {
    const timeoutMinutes = Number(mergedConfig.timeoutMinutes);
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1) throw new Error("Timeout minutes must be at least 1");
    mergedConfig.timeoutMinutes = Math.floor(timeoutMinutes);
  }
  if (mergedConfig.days !== undefined) {
    const days = Number(mergedConfig.days);
    if (!Number.isFinite(days) || days < 1) throw new Error("Sync window days must be at least 1");
    mergedConfig.days = Math.floor(days);
  }
  if (mergedConfig.scope !== undefined) {
    const scope = String(mergedConfig.scope || "").trim();
    if (scope && !["today_only", "recent_window", "full"].includes(scope)) {
      throw new Error(`Unsupported config scope: ${scope}`);
    }
    mergedConfig.scope = scope;
  }

  const base = fromSqlDate(existing.last_attempt_at) || new Date();
  const nextRun = computeNextRun({
    schedule_type: scheduleType,
    interval_minutes: intervalMinutes,
    daily_time: dailyTime
  }, base);

  await mysqlExecute(`
    UPDATE scheduled_jobs
    SET schedule_type = ?, interval_minutes = ?, daily_time = ?, catchup_enabled = ?, max_catchup_runs = ?,
        config_json = ?, next_run_at = ?, locked_at = NULL, locked_by = NULL
    WHERE job_key = ?
  `, [
    scheduleType,
    intervalMinutes,
    dailyTime || null,
    catchupEnabled,
    maxCatchupRuns,
    JSON.stringify(mergedConfig),
    sqlDate(nextRun),
    jobKey
  ]);
  const [updated] = await mysqlQuery("SELECT * FROM scheduled_jobs WHERE job_key = ? LIMIT 1", [jobKey]);
  return normalizeJobRow(updated);
}

export async function scheduledJobSummary() {
  await ensureScheduledJobTables();
  const rows = await mysqlQuery(`
    SELECT *
    FROM scheduled_jobs
    ORDER BY FIELD(priority, 'critical', 'high', 'normal', 'low'), fail_count DESC, next_run_at ASC
  `);
  const now = Date.now();
  const normalized = rows.map(normalizeJobRow);
  const failed = normalized.filter((job) => job.lastStatus === "failed");
  const due = normalized.filter((job) => {
    if (!job.enabled || !job.nextRunAt) return false;
    const nextRun = fromSqlDate(job.nextRunAt);
    const time = nextRun?.getTime?.();
    return Number.isFinite(time) && time <= now;
  });
  return {
    total: normalized.length,
    enabled: normalized.filter((job) => job.enabled).length,
    failedCount: failed.length,
    dueCount: due.length,
    failedJobs: failed.slice(0, 5).map((job) => ({
      key: job.key,
      name: job.name,
      priority: job.priority,
      failCount: job.failCount,
      nextRunAt: job.nextRunAt,
      lastError: job.lastError
    })),
    dueJobs: due.slice(0, 5).map((job) => ({
      key: job.key,
      name: job.name,
      priority: job.priority,
      nextRunAt: job.nextRunAt
    }))
  };
}

async function claimDueJobs({ limit = 5, includeCatchup = true } = {}) {
  const now = new Date();
  const nowSql = sqlDate(now);
  const staleLockSql = sqlDate(addMinutes(now, -DEFAULT_LOCK_TTL_MINUTES));
  const rows = await mysqlQuery(`
    SELECT *
    FROM scheduled_jobs
    WHERE enabled = 1
      AND next_run_at IS NOT NULL
      AND next_run_at <= ?
      AND (locked_at IS NULL OR locked_at < ?)
      AND NOT EXISTS (
        SELECT 1
        FROM scheduled_job_runs recent_runs
        WHERE recent_runs.job_key = scheduled_jobs.job_key
          AND recent_runs.status = 'running'
          AND recent_runs.started_at >= ?
      )
      ${includeCatchup ? "" : "AND (last_attempt_at IS NULL OR next_run_at >= DATE_SUB(?, INTERVAL interval_minutes + 2 MINUTE))"}
    ORDER BY FIELD(priority, 'critical', 'high', 'normal', 'low'), next_run_at ASC
    LIMIT ?
  `, includeCatchup ? [nowSql, staleLockSql, staleLockSql, limit] : [nowSql, staleLockSql, staleLockSql, nowSql, limit]);

  const claimed = [];
  for (const row of rows) {
    const lockId = randomUUID();
    const result = await mysqlExecute(`
      UPDATE scheduled_jobs
      SET locked_at = ?, locked_by = ?, last_attempt_at = ?
      WHERE id = ?
        AND (locked_at IS NULL OR locked_at < ?)
    `, [nowSql, lockId, nowSql, row.id, staleLockSql]);
    if (Number(result.affectedRows || 0) === 1) claimed.push({ ...row, locked_by: lockId, locked_at: nowSql });
  }
  return claimed;
}

async function startRun(job, mode) {
  const staleStartedBefore = sqlDate(addMinutes(new Date(), -DEFAULT_LOCK_TTL_MINUTES));
  await mysqlExecute(`
    UPDATE scheduled_job_runs
    SET status = 'failed',
        finished_at = COALESCE(finished_at, UTC_TIMESTAMP()),
        error_message = COALESCE(NULLIF(error_message, ''), 'stale running scheduled job was reset automatically')
    WHERE job_key = ?
      AND status = 'running'
      AND started_at < ?
  `, [job.job_key, staleStartedBefore]);
  const activeRuns = await mysqlQuery(`
    SELECT id
    FROM scheduled_job_runs
    WHERE job_key = ?
      AND status = 'running'
    ORDER BY started_at DESC
    LIMIT 1
  `, [job.job_key]);
  if (activeRuns[0]?.id) {
    throw new Error(`Scheduled job already has an active run: ${job.job_key}`);
  }
  const result = await mysqlExecute(`
    INSERT INTO scheduled_job_runs (job_key, planned_for, status, mode, payload_json)
    VALUES (?, ?, 'running', ?, ?)
  `, [
    job.job_key,
    job.next_run_at || null,
    mode,
    JSON.stringify({
      scheduleType: job.schedule_type,
      intervalMinutes: job.interval_minutes,
      dailyTime: job.daily_time,
      config: parseJson(job.config_json, {})
    })
  ]);
  return Number(result.insertId || 0);
}

async function finishRunSuccess(job, runId, resultPayload = {}) {
  const now = new Date();
  const retryDelaySeconds = Math.max(0, Number(resultPayload?.retryDelaySeconds || resultPayload?.retry_delay_seconds || 0));
  const nextRun = retryDelaySeconds
    ? new Date(now.getTime() + retryDelaySeconds * 1000)
    : computeNextRun(job, now);
  const status = String(resultPayload?.status || "success");
  const lastError = status === "partial" ? compactError(resultPayload?.warning || resultPayload?.summary || "partial_success") : null;
  const storedResult = summarizeScheduledJobResult(job.job_key, resultPayload || {});
  await withMysqlTransaction(async (connection) => {
    await connection.execute(`
      UPDATE scheduled_job_runs
      SET status = ?, finished_at = ?, result_json = ?
      WHERE id = ?
    `, [status, sqlDate(now), JSON.stringify(storedResult), runId]);
    await connection.execute(`
      UPDATE scheduled_jobs
      SET last_success_at = ?, last_status = ?, last_error = ?, fail_count = 0,
          next_run_at = ?, locked_at = NULL, locked_by = NULL
      WHERE id = ? AND locked_by = ?
    `, [sqlDate(now), status, lastError, sqlDate(nextRun), job.id, job.locked_by]);
  });
}

async function finishRunFailure(job, runId, error) {
  const now = new Date();
  const retryMinutes = Math.min(60, Math.max(5, Number(job.interval_minutes || 60) / 4));
  const errorMessage = compactError(error);
  await withMysqlTransaction(async (connection) => {
    await connection.execute(`
      UPDATE scheduled_job_runs
      SET status = 'failed', finished_at = ?, error_message = ?
      WHERE id = ?
    `, [sqlDate(now), errorMessage, runId]);
    await connection.execute(`
      UPDATE scheduled_jobs
      SET last_status = 'failed', last_error = ?, fail_count = fail_count + 1,
          next_run_at = ?, locked_at = NULL, locked_by = NULL
      WHERE id = ? AND locked_by = ?
    `, [errorMessage, sqlDate(addMinutes(now, retryMinutes)), job.id, job.locked_by]);
  });
}

async function finishRunSkipped(job, runId, reason, options = {}) {
  const now = new Date();
  const retryDelaySeconds = Math.max(0, Number(options.retryDelaySeconds || 0));
  const nextRun = retryDelaySeconds
    ? new Date(now.getTime() + retryDelaySeconds * 1000)
    : computeNextRun(job, now);
  await withMysqlTransaction(async (connection) => {
    await connection.execute(`
      UPDATE scheduled_job_runs
      SET status = 'skipped', finished_at = ?, result_json = ?
      WHERE id = ?
    `, [sqlDate(now), JSON.stringify({ skipped: true, reason }), runId]);
    await connection.execute(`
      UPDATE scheduled_jobs
      SET next_run_at = ?, locked_at = NULL, locked_by = NULL
      WHERE id = ? AND locked_by = ?
    `, [sqlDate(nextRun), job.id, job.locked_by]);
  });
}

export class ScheduledJobScheduler {
  constructor({ handlers = {}, pollIntervalMs = 60_000, maxConcurrent = 1 } = {}) {
    this.handlers = handlers;
    this.pollIntervalMs = Math.max(10_000, Number(pollIntervalMs || 60_000));
    this.maxConcurrent = Math.max(1, Number(maxConcurrent || 1));
    this.running = 0;
    this.timer = null;
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext(1000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  scheduleNext(delay = this.pollIntervalMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.tick("scheduled").catch((error) => console.error("scheduled job tick failed", error));
    }, delay);
  }

  async tick(mode = "scheduled") {
    if (this.stopped) return;
    try {
      const capacity = this.maxConcurrent - this.running;
      if (capacity <= 0) return;
      const jobs = await claimDueJobs({ limit: capacity, includeCatchup: true });
      await Promise.all(jobs.map((job) => this.runClaimedJob(job, mode)));
    } finally {
      this.scheduleNext();
    }
  }

  async runClaimedJob(job, mode = "scheduled") {
    const handler = this.handlers[job.job_key];
    let runId = 0;
    try {
      runId = await startRun(job, mode);
    } catch (error) {
      if (String(error?.message || "").includes("already has an active run")) {
        await mysqlExecute(`
          UPDATE scheduled_jobs
          SET locked_at = NULL, locked_by = NULL
          WHERE id = ? AND locked_by = ?
        `, [job.id, job.locked_by]);
        return;
      }
      throw error;
    }
    const plannedFor = fromSqlDate(job.next_run_at);
    const intervalMs = Math.max(1, Number(job.interval_minutes || 60)) * 60 * 1000;
    if (!job.catchup_enabled && plannedFor && plannedFor.getTime() < Date.now() - intervalMs) {
      await finishRunSkipped(job, runId, "missed_window_catchup_disabled");
      return;
    }
    if (!handler) {
      await finishRunFailure(job, runId, new Error(`No scheduled job handler registered for ${job.job_key}`));
      return;
    }
    this.running += 1;
    try {
      const result = await handler({
        key: job.job_key,
        runId,
        mode,
        plannedFor: fromSqlDate(job.next_run_at),
        config: parseJson(job.config_json, {})
      });
      if (result?.skipped) {
        await finishRunSkipped(job, runId, result.reason || "skipped", { retryDelaySeconds: result.retryDelaySeconds });
        return;
      }
      await finishRunSuccess(job, runId, result || {});
    } catch (error) {
      console.error(`scheduled job ${job.job_key} failed`, error);
      await finishRunFailure(job, runId, error);
    } finally {
      this.running -= 1;
    }
  }
}

export async function runScheduledJobNow(jobKey, handlers = {}, mode = "manual") {
  await ensureScheduledJobTables();
  const rows = await mysqlQuery("SELECT * FROM scheduled_jobs WHERE job_key = ? LIMIT 1", [String(jobKey || "")]);
  const row = rows[0];
  if (!row) throw new Error(`Scheduled job not found: ${jobKey}`);
  const lockId = randomUUID();
  const nowSql = sqlDate();
  const result = await mysqlExecute(`
    UPDATE scheduled_jobs
    SET locked_at = ?, locked_by = ?, last_attempt_at = ?
    WHERE id = ? AND locked_at IS NULL
  `, [nowSql, lockId, nowSql, row.id]);
  if (Number(result.affectedRows || 0) !== 1) throw new Error(`Scheduled job is already running: ${jobKey}`);
  const scheduler = new ScheduledJobScheduler({ handlers });
  await scheduler.runClaimedJob({ ...row, locked_by: lockId, locked_at: nowSql }, mode);
  const [updated] = await mysqlQuery("SELECT * FROM scheduled_jobs WHERE job_key = ? LIMIT 1", [String(jobKey || "")]);
  return normalizeJobRow(updated || row);
}
