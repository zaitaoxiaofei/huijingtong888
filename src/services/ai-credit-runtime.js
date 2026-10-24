import path from "node:path";
import { mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { assertCurrentAiTenantPermission, currentAiTenantSession } from "./ai-tenant-context.js";
import { createAiCreditLedger } from "./ai-credit-ledger.js";
import { createAiCreditExecutor } from "./ai-credit-execution.js";
import { createAiCreditResultStore } from "./ai-credit-result-store.js";
import { checkAiCreditProviderBoundary, readAiCreditModeFromQuery, withAiCreditProviderPermit } from "./ai-credit-provider-context.js";
export { withAiCreditOperation, aiCreditOperationKey } from "./ai-credit-provider-context.js";

const fail = (message, code, status = 409) => Object.assign(new Error(message), { code, status, statusCode: status });

export async function readAiCreditMode(session = currentAiTenantSession(), query = mysqlQuery) {
  return readAiCreditModeFromQuery(session, query);
}

// Also called on saved-job polls, which deliberately do not reserve a second
// request. Merely supplying a runtimeConfig/providerJob never grants permission.
export async function assertAiCreditProviderBoundary(kind = "text", authorizedSession = null) {
  const session = authorizedSession || await assertCurrentAiTenantPermission();
  return checkAiCreditProviderBoundary(session, kind, mysqlQuery);
}

export function createAiCreditRuntime({ query = mysqlQuery, transaction = withMysqlTransaction, resultStore = null, authorize = assertCurrentAiTenantPermission } = {}) {
  const ledger = createAiCreditLedger({ transaction });
  let privateStore = resultStore;
  return {
    mode: session => readAiCreditMode(session, query),
    async existingProvider(session, idempotencyKey) {
      const found = await query(`SELECT a.provider, a.model FROM ai_credit_tasks t
        JOIN ai_credit_attempts a ON a.task_id = t.id
        WHERE t.tenant_id = ? AND t.created_by_person_id = ? AND t.idempotency_key = ?
        ORDER BY a.attempt_number DESC LIMIT 1`, [session.tenant.id, session.personId, idempotencyKey]);
      return found[0] || null;
    },
    async execute(session, { kind, capability, idempotencyKey, payload, provider }) {
      const authorizeCurrent = async () => {
        const current = await authorize();
        if (!current || Number(current.tenant?.id) !== Number(session.tenant?.id) || Number(current.personId) !== Number(session.personId)) {
          throw fail("AI 积分执行身份与当前企业操作人不一致", "AI_CREDIT_FORBIDDEN", 403);
        }
        await readAiCreditMode(session, query);
      };
      await authorizeCurrent();
      if ((await readAiCreditMode(session, query)).mode !== "credits") throw fail("企业尚未开通积分模式", "AI_CREDIT_ACCOUNT_DISABLED");
      privateStore ||= createAiCreditResultStore(path.resolve(process.env.AI_CREDIT_RESULT_ROOT || "data/ai-credit-results"));
      const protect = operation => withAiCreditProviderPermit(session, kind, operation);
      const execute = createAiCreditExecutor({ ledger, resultStore: privateStore,
        authorize: authorizeCurrent,
        providers: { [capability]: { ...provider,
          submit: (...args) => protect(() => provider.submit(...args)),
          ...(provider.query ? { query: (...args) => protect(() => provider.query(...args)) } : {}) } } });
      return execute(session, { capability, idempotencyKey, payload });
    }
  };
}

export const aiCreditRuntime = createAiCreditRuntime();
