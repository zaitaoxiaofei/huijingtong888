import { mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { createAiCreditLedger } from "./ai-credit-ledger.js";

// Lazy catch-up in wallet/reserve covers newly registered enterprises and the
// first request after Beijing midnight; this sweep also serves inactive users.
export async function runAiCreditMonthlyBenefits({ query = mysqlQuery, transaction = withMysqlTransaction } = {}) {
  const tenants = await query(`SELECT t.id, t.slug, MIN(p.id) AS person_id FROM tenants t
    JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.active = 1
    JOIN people p ON p.id = tm.person_id AND p.active = 1
    WHERE t.status = 'active' AND t.subscription_status IN ('active', 'trial')
      AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at > UTC_TIMESTAMP())
    GROUP BY t.id, t.slug ORDER BY t.id`);
  const ledger = createAiCreditLedger({ transaction });
  const failures = [];
  let processed = 0;
  for (const tenant of tenants) {
    try {
      await ledger.provision({ personId: Number(tenant.person_id), tenant: { id: Number(tenant.id), slug: tenant.slug } });
      processed++;
    } catch (error) {
      failures.push({ tenant_id: tenant.id, code: error.code || 'AI_CREDIT_BENEFIT_FAILED' });
    }
  }
  if (failures.length) throw Object.assign(new Error("部分企业的 AI 月度积分尚未入账，下次执行会按原月份去重重试"), { code: "AI_CREDIT_BENEFIT_RETRY", failures, processed });
  return { processed, failed: 0 };
}
