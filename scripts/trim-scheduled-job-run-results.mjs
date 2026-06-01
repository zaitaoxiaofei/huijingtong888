import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";
import { ensureScheduledJobTables } from "../src/services/scheduled-jobs.js";

function truncateText(value, maxLength = 500) {
  return String(value || "").slice(0, Math.max(1, Number(maxLength || 500)));
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

function summarizeStockResult(payload = {}) {
  return {
    status: String(payload.status || "success"),
    fetched: Number(payload.fetched || 0),
    upserted: Number(payload.upserted || 0),
    message: truncateText(payload.message || ""),
    errorCount: Array.isArray(payload.errors) ? payload.errors.length : 0,
    errors: Array.isArray(payload.errors) ? payload.errors.slice(0, 20).map((item) => truncateText(item, 300)) : [],
    alerts: summarizeAlertCollection(payload.alerts),
    summaryTruncated: true
  };
}

async function main() {
  await ensureScheduledJobTables();
  const rows = await mysqlQuery(`
    SELECT id, result_json
    FROM scheduled_job_runs
    WHERE job_key = 'ozon_stock_sync'
      AND CHAR_LENGTH(COALESCE(result_json, '')) > 200000
  `);
  let updated = 0;
  for (const row of rows) {
    let payload = {};
    try {
      payload = row.result_json ? JSON.parse(row.result_json) : {};
    } catch {
      payload = {};
    }
    await mysqlExecute(`
      UPDATE scheduled_job_runs
      SET result_json = ?
      WHERE id = ?
    `, [JSON.stringify(summarizeStockResult(payload)), row.id]);
    updated += 1;
  }
  console.log(JSON.stringify({ scanned: rows.length, updated }, null, 2));
  await closeMysqlPool();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
