import fs from "node:fs/promises";
import { config } from "../config.js";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { collectStorageUsage, storageMetricValue } from "./system-monitor-storage.js";

const SNAPSHOT_RETENTION_DAYS = 180;
const WARNING_USAGE_PERCENT = 65;
const CRITICAL_USAGE_PERCENT = 80;
const WARNING_AVAILABLE_BYTES = 10 * 1024 ** 3;
const CRITICAL_AVAILABLE_BYTES = 5 * 1024 ** 3;
const WARNING_DAILY_GROWTH_BYTES = 512 * 1024 ** 2;
const CRITICAL_DAILY_GROWTH_BYTES = 1024 ** 3;

let schemaReadyPromise;

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = mysqlExecute(`
      CREATE TABLE IF NOT EXISTS system_monitor_snapshots (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        captured_at DATETIME(3) NOT NULL,
        disk_total_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        disk_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        disk_available_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        usage_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
        daily_growth_bytes BIGINT NOT NULL DEFAULT 0,
        mysql_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        binlog_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        uploads_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        backups_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        releases_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        logs_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        app_rss_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        service_uptime_seconds BIGINT UNSIGNED NOT NULL DEFAULT 0,
        severity VARCHAR(16) NOT NULL DEFAULT 'normal',
        details_json JSON NULL,
        PRIMARY KEY (id),
        KEY idx_system_monitor_captured_at (captured_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function topDatabaseTables(limit = 12) {
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 12));
  const rows = await mysqlQuery(`
    SELECT table_name,
           COALESCE(table_rows, 0) AS table_rows,
           COALESCE(data_length, 0) AS data_bytes,
           COALESCE(index_length, 0) AS index_bytes,
           COALESCE(data_length, 0) + COALESCE(index_length, 0) AS total_bytes
    FROM information_schema.tables
    WHERE table_schema = ?
    ORDER BY total_bytes DESC
    LIMIT ${safeLimit}
  `, [config.dbName]);
  return rows.map((row) => ({
    tableName: row.table_name,
    rows: numberValue(row.table_rows),
    dataBytes: numberValue(row.data_bytes),
    indexBytes: numberValue(row.index_bytes),
    totalBytes: numberValue(row.total_bytes)
  }));
}

function severityFor(usagePercent, availableBytes, dailyGrowthBytes) {
  if (usagePercent >= CRITICAL_USAGE_PERCENT || availableBytes <= CRITICAL_AVAILABLE_BYTES || dailyGrowthBytes >= CRITICAL_DAILY_GROWTH_BYTES) return "critical";
  if (usagePercent >= WARNING_USAGE_PERCENT || availableBytes <= WARNING_AVAILABLE_BYTES || dailyGrowthBytes >= WARNING_DAILY_GROWTH_BYTES) return "warning";
  return "normal";
}

export async function captureSystemMonitorSnapshot() {
  return captureSystemMonitorSnapshotWith();
}

export async function captureSystemMonitorSnapshotWith({ prepare = ensureSchema,
  readDisk = () => fs.statfs("/"), readStorage = collectStorageUsage, readTables = topDatabaseTables,
  query = mysqlQuery, execute = mysqlExecute, now = () => new Date(), warn = console.warn } = {}) {
  await prepare();
  const [disk, storage, tables, previousRows] = await Promise.all([
    readDisk(), readStorage(), readTables(),
    query("SELECT disk_used_bytes FROM system_monitor_snapshots ORDER BY captured_at DESC LIMIT 1")
  ]);
  const totalBytes = numberValue(disk.blocks) * numberValue(disk.bsize);
  const availableBytes = numberValue(disk.bavail) * numberValue(disk.bsize);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : 0;
  const previousUsedBytes = previousRows[0] ? numberValue(previousRows[0].disk_used_bytes) : usedBytes;
  const dailyGrowthBytes = usedBytes - previousUsedBytes;
  let severity = severityFor(usagePercent, availableBytes, dailyGrowthBytes);
  if (storage.collection.status === "incomplete") {
    if (severity === "normal") severity = "warning";
    warn("[system-monitor] storage collection incomplete", storage.collection.errors);
  }
  const memory = process.memoryUsage();
  const capturedAt = now();

  const result = await execute(`
    INSERT INTO system_monitor_snapshots (
      captured_at, disk_total_bytes, disk_used_bytes, disk_available_bytes, usage_percent,
      daily_growth_bytes, mysql_bytes, binlog_bytes, uploads_bytes, backups_bytes,
      releases_bytes, logs_bytes, app_rss_bytes, service_uptime_seconds, severity, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    capturedAt, totalBytes, usedBytes, availableBytes, usagePercent, dailyGrowthBytes,
    // Existing NOT NULL columns keep a compatibility placeholder; errors in details distinguish unknown from zero.
    ...["mysql", "binlog", "uploads", "backups", "releases", "logs"].map(key => storage.metrics[key] ?? 0),
    memory.rss, Math.floor(process.uptime()), severity,
    JSON.stringify({ topTables: tables, storageCollection: storage.collection })
  ]);
  await execute(
    "DELETE FROM system_monitor_snapshots WHERE captured_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)",
    [SNAPSHOT_RETENTION_DAYS]
  );
  return { id: Number(result.insertId), capturedAt: capturedAt.toISOString(), usagePercent, dailyGrowthBytes, severity,
    status: storage.collection.status === "incomplete" ? "partial" : "success", storageCollection: storage.collection };
}

export function normalizeSystemMonitorSnapshot(row) {
  if (!row) return null;
  let details = row.details_json || {};
  if (typeof details === "string") {
    try { details = JSON.parse(details); } catch { details = {}; }
  }
  const collection = details.storageCollection || null;
  return {
    id: Number(row.id),
    capturedAt: row.captured_at,
    diskTotalBytes: numberValue(row.disk_total_bytes),
    diskUsedBytes: numberValue(row.disk_used_bytes),
    diskAvailableBytes: numberValue(row.disk_available_bytes),
    usagePercent: numberValue(row.usage_percent),
    dailyGrowthBytes: numberValue(row.daily_growth_bytes),
    mysqlBytes: storageMetricValue(row, "mysql_bytes", "mysql", collection),
    binlogBytes: storageMetricValue(row, "binlog_bytes", "binlog", collection),
    uploadsBytes: storageMetricValue(row, "uploads_bytes", "uploads", collection),
    backupsBytes: storageMetricValue(row, "backups_bytes", "backups", collection),
    releasesBytes: storageMetricValue(row, "releases_bytes", "releases", collection),
    logsBytes: storageMetricValue(row, "logs_bytes", "logs", collection),
    appRssBytes: numberValue(row.app_rss_bytes),
    serviceUptimeSeconds: numberValue(row.service_uptime_seconds),
    severity: row.severity || "normal",
    topTables: Array.isArray(details.topTables) ? details.topTables : [],
    storageCollection: collection
  };
}

export async function systemMonitoringOverview(query = {}) {
  await ensureSchema();
  const days = Math.max(7, Math.min(90, Number(query.days) || 30));
  const rows = await mysqlQuery(`
    SELECT * FROM system_monitor_snapshots
    WHERE captured_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
    ORDER BY captured_at DESC
  `, [days]);
  const snapshots = rows.map(normalizeSystemMonitorSnapshot);
  return {
    latest: snapshots[0] || null,
    history: snapshots,
    thresholds: {
      warningUsagePercent: WARNING_USAGE_PERCENT,
      criticalUsagePercent: CRITICAL_USAGE_PERCENT,
      warningAvailableBytes: WARNING_AVAILABLE_BYTES,
      criticalAvailableBytes: CRITICAL_AVAILABLE_BYTES,
      warningDailyGrowthBytes: WARNING_DAILY_GROWTH_BYTES,
      criticalDailyGrowthBytes: CRITICAL_DAILY_GROWTH_BYTES
    },
    retentionDays: SNAPSHOT_RETENTION_DAYS
  };
}
