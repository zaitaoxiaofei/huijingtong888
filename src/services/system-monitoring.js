import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_RETENTION_DAYS = 180;
const WARNING_USAGE_PERCENT = 65;
const CRITICAL_USAGE_PERCENT = 80;
const WARNING_AVAILABLE_BYTES = 10 * 1024 ** 3;
const CRITICAL_AVAILABLE_BYTES = 5 * 1024 ** 3;
const WARNING_DAILY_GROWTH_BYTES = 512 * 1024 ** 2;
const CRITICAL_DAILY_GROWTH_BYTES = 1024 ** 3;
const MONITORED_PATHS = Object.freeze({
  mysql: "/var/lib/mysql",
  uploads: "/opt/ozon-erp/shared/uploads",
  backups: "/opt/ozon-erp/shared/backups",
  releases: "/opt/ozon-erp/releases",
  logs: "/var/log"
});

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

async function directoryBytes(targetPath) {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", "--", targetPath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    return Math.max(0, numberValue(String(stdout).trim().split(/\s+/)[0]) * 1024);
  } catch {
    return 0;
  }
}

async function binaryLogBytes() {
  try {
    const entries = await fs.readdir(MONITORED_PATHS.mysql, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && /^binlog\.\d+$/.test(entry.name));
    const stats = await Promise.all(files.map((entry) => fs.stat(`${MONITORED_PATHS.mysql}/${entry.name}`)));
    return stats.reduce((sum, stat) => sum + numberValue(stat.size), 0);
  } catch {
    return 0;
  }
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
  await ensureSchema();
  const [disk, mysqlBytes, uploadsBytes, backupsBytes, releasesBytes, logsBytes, binlogBytes, tables, previousRows] = await Promise.all([
    fs.statfs("/"),
    directoryBytes(MONITORED_PATHS.mysql),
    directoryBytes(MONITORED_PATHS.uploads),
    directoryBytes(MONITORED_PATHS.backups),
    directoryBytes(MONITORED_PATHS.releases),
    directoryBytes(MONITORED_PATHS.logs),
    binaryLogBytes(),
    topDatabaseTables(),
    mysqlQuery("SELECT disk_used_bytes FROM system_monitor_snapshots ORDER BY captured_at DESC LIMIT 1")
  ]);
  const totalBytes = numberValue(disk.blocks) * numberValue(disk.bsize);
  const availableBytes = numberValue(disk.bavail) * numberValue(disk.bsize);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : 0;
  const previousUsedBytes = previousRows[0] ? numberValue(previousRows[0].disk_used_bytes) : usedBytes;
  const dailyGrowthBytes = usedBytes - previousUsedBytes;
  const severity = severityFor(usagePercent, availableBytes, dailyGrowthBytes);
  const memory = process.memoryUsage();
  const capturedAt = new Date();

  const result = await mysqlExecute(`
    INSERT INTO system_monitor_snapshots (
      captured_at, disk_total_bytes, disk_used_bytes, disk_available_bytes, usage_percent,
      daily_growth_bytes, mysql_bytes, binlog_bytes, uploads_bytes, backups_bytes,
      releases_bytes, logs_bytes, app_rss_bytes, service_uptime_seconds, severity, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    capturedAt, totalBytes, usedBytes, availableBytes, usagePercent, dailyGrowthBytes,
    mysqlBytes, binlogBytes, uploadsBytes, backupsBytes, releasesBytes, logsBytes,
    memory.rss, Math.floor(process.uptime()), severity, JSON.stringify({ topTables: tables })
  ]);
  await mysqlExecute(
    "DELETE FROM system_monitor_snapshots WHERE captured_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)",
    [SNAPSHOT_RETENTION_DAYS]
  );
  return { id: Number(result.insertId), capturedAt: capturedAt.toISOString(), usagePercent, dailyGrowthBytes, severity };
}

function normalizeSnapshot(row) {
  if (!row) return null;
  let details = row.details_json || {};
  if (typeof details === "string") {
    try { details = JSON.parse(details); } catch { details = {}; }
  }
  return {
    id: Number(row.id),
    capturedAt: row.captured_at,
    diskTotalBytes: numberValue(row.disk_total_bytes),
    diskUsedBytes: numberValue(row.disk_used_bytes),
    diskAvailableBytes: numberValue(row.disk_available_bytes),
    usagePercent: numberValue(row.usage_percent),
    dailyGrowthBytes: numberValue(row.daily_growth_bytes),
    mysqlBytes: numberValue(row.mysql_bytes),
    binlogBytes: numberValue(row.binlog_bytes),
    uploadsBytes: numberValue(row.uploads_bytes),
    backupsBytes: numberValue(row.backups_bytes),
    releasesBytes: numberValue(row.releases_bytes),
    logsBytes: numberValue(row.logs_bytes),
    appRssBytes: numberValue(row.app_rss_bytes),
    serviceUptimeSeconds: numberValue(row.service_uptime_seconds),
    severity: row.severity || "normal",
    topTables: Array.isArray(details.topTables) ? details.topTables : []
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
  const snapshots = rows.map(normalizeSnapshot);
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
