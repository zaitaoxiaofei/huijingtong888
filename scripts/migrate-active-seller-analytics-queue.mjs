import { closeMysqlPool, mysqlExecute, mysqlQuery, withMysqlTransaction } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const rows = await mysqlQuery(`
  SELECT tenant_id, value
  FROM settings
  WHERE \`key\` LIKE 'seller_analytics_collect_run:%'
`);
const activeRuns = [];
for (const row of rows) {
  let run;
  try { run = JSON.parse(row.value || "null"); } catch { continue; }
  if (!run || !["pending", "running"].includes(run.status)) continue;
  const requests = (Array.isArray(run.requests) ? run.requests : [])
    .filter((request) => ["pending", "running"].includes(request.status));
  if (!requests.length) continue;
  activeRuns.push({ ...run, tenant_id: row.tenant_id || run.tenant_id || "admin", requests });
}

const report = {
  mode: APPLY ? "apply" : "dry-run",
  run_count: activeRuns.length,
  request_count: activeRuns.reduce((sum, run) => sum + run.requests.length, 0)
};
console.log(JSON.stringify(report, null, 2));

if (APPLY) {
  await withMysqlTransaction(async (connection) => {
    for (const run of activeRuns) {
      await connection.execute(`
        INSERT IGNORE INTO seller_analytics_collect_runs
          (id, tenant_id, store_id, status, period_key, current_period_json, previous_period_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [run.id, run.tenant_id, run.store_id || null, run.status, run.period_key || null,
        JSON.stringify(run.current_period || {}), JSON.stringify(run.previous_period || {}),
        run.created_at || new Date(), run.updated_at || new Date()]);
      for (const request of run.requests) {
        await connection.execute(`
          INSERT IGNORE INTO seller_analytics_collect_requests
            (id, run_id, tenant_id, store_id, status, source_key, source_label, endpoint_type, page_index,
             request_url, request_method, request_headers_json, request_body_json, attempts, claimed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [request.id, run.id, run.tenant_id, run.store_id || null, request.status || "pending",
          request.source_key || null, request.source_label || null, request.endpoint_type || null,
          Number(request.page_index || 0), request.request_url || null, request.request_method || "POST",
          JSON.stringify(request.request_headers || {}), JSON.stringify(request.request_body || {}),
          Number(request.attempts || 0), request.claimed_at || null,
          run.created_at || new Date(), run.updated_at || new Date()]);
      }
    }
  });
  await mysqlExecute("UPDATE seller_analytics_collect_requests SET status='pending', claimed_at=NULL WHERE status='running' AND claimed_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)");
}

await closeMysqlPool();
