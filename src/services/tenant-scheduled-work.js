import { mysqlQuery } from "../mysql-pool.js";

// The platform scheduler owns orchestration; every business execution receives
// one explicit active enterprise and cannot select a global/default fallback.
export async function runTenantScheduledWork(run, query = mysqlQuery) {
  const tenants = await query(`SELECT t.id FROM tenants t WHERE t.status='active'
    AND t.subscription_status IN ('active','trial')
    AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at>UTC_TIMESTAMP())
    ORDER BY t.id`);
  const aggregate = { tenants: [], errors: [], shops: [] };
  for (const tenant of tenants) {
    const [current] = await query(`SELECT id FROM tenants WHERE id=? AND status='active'
      AND subscription_status IN ('active','trial')
      AND (subscription_expires_at IS NULL OR subscription_expires_at>UTC_TIMESTAMP())`, [tenant.id]);
    if (!current) continue;
    try {
      const result = await run(String(current.id));
      aggregate.tenants.push({ tenant_id: Number(current.id), result });
      aggregate.errors.push(...(Array.isArray(result?.errors) ? result.errors : []));
      aggregate.shops.push(...(Array.isArray(result?.shops) ? result.shops : []));
      for (const [key, value] of Object.entries(result || {})) {
        if (typeof value === "number" && Number.isFinite(value)) aggregate[key] = Number(aggregate[key] || 0) + value;
      }
    } catch (error) {
      aggregate.errors.push(`企业 #${current.id}: ${error?.message || String(error)}`);
    }
  }
  if (aggregate.errors.length) throw Object.assign(new Error(`企业后台任务部分失败：${aggregate.errors.join("；")}`), { result: aggregate });
  return aggregate;
}
