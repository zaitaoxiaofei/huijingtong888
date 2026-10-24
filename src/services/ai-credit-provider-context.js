import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const providerContext = new AsyncLocalStorage();
const operationContext = new AsyncLocalStorage();
const fail = (message, code, status = 409) => Object.assign(new Error(message), { code, status, statusCode: status });

// A recovered worker reuses its saved operation number, never a new random key.
export function withAiCreditOperation(key, operation) {
  if (!key) return operation();
  if (typeof key !== "string" || key.length > 256 || /[\x00-\x1f]/.test(key)) throw fail("AI 提交编号无效", "AI_CREDIT_IDEMPOTENCY_REQUIRED", 400);
  return operationContext.run(key, operation);
}

export function aiCreditOperationKey(payload = {}, suffix = "image:0") {
  const persisted = payload.usageContext?.jobNo && payload.usageContext?.itemNo
    ? `variant:${payload.usageContext.jobNo}:${payload.usageContext.itemNo}` : "";
  const key = operationContext.getStore() || persisted || payload.idempotencyKey;
  if (typeof key !== "string" || !key || key.length > 256 || /[\x00-\x1f]/.test(key)) {
    throw fail("积分 AI 任务缺少固定提交编号，请从生成任务重新提交；同一任务重试必须复用原编号", "AI_CREDIT_IDEMPOTENCY_REQUIRED", 400);
  }
  return `operation:${createHash("sha256").update(key).digest("hex")}:${suffix}`;
}

// SQL is supplied by the caller so request accounting need not import the whole
// provider/runtime graph, and isolated fixtures execute these same real checks.
export async function readAiCreditModeFromQuery(session, query) {
  if (!session) return { mode: "internal" }; // Separately authorized platform diagnostics.
  const tenantId = Number(session.tenant?.id);
  if (!Number.isSafeInteger(tenantId) || tenantId < 1) throw fail("AI 操作缺少企业身份", "AI_CREDIT_FORBIDDEN", 403);
  const tenants = await query("SELECT * FROM tenants WHERE id = ?", [tenantId]);
  if (!tenants.length) throw fail("企业不存在", "AI_CREDIT_FORBIDDEN", 403);
  let flags = tenants[0].feature_flags_json || {};
  if (typeof flags === "string") {
    try { flags = JSON.parse(flags); } catch { throw fail("企业 AI 配置损坏，请联系平台管理员核查", "AI_CREDIT_STORAGE_UNAVAILABLE", 503); }
  }
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) throw fail("企业 AI 配置损坏，请联系平台管理员核查", "AI_CREDIT_STORAGE_UNAVAILABLE", 503);
  if (flags.ai_credits_opted_in !== undefined && typeof flags.ai_credits_opted_in !== "boolean") throw fail("企业 AI 积分开通标记损坏，请联系平台核查", "AI_CREDIT_STORAGE_UNAVAILABLE", 503);
  const internalAllowed = tenants[0].slug === "default" || flags.ai_internal_mode_reviewed === true;
  const notConfigured = () => fail("企业尚未开通 AI 积分账户，请联系平台管理员开通；外部企业不能使用平台内部额度", "AI_CREDIT_ACCOUNT_NOT_CONFIGURED");
  let accounts;
  try {
    accounts = await query("SELECT tenant_id, status, available_points, frozen_points FROM ai_credit_accounts WHERE tenant_id = ?", [tenantId]);
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE" && flags.ai_credits_opted_in !== true) {
      if (internalAllowed) return { mode: "internal" };
      throw notConfigured();
    }
    throw fail("企业 AI 积分账本暂不可用，请联系平台管理员核查；不会改走内部额度", "AI_CREDIT_STORAGE_UNAVAILABLE", 503);
  }
  if (!accounts.length && flags.ai_credits_opted_in !== true) {
    if (internalAllowed) return { mode: "internal" };
    throw notConfigured();
  }
  if (!accounts.length) throw fail("企业 AI 积分账户缺失，请联系平台管理员核查", "AI_CREDIT_STORAGE_UNAVAILABLE", 503);
  if (accounts[0].status !== "active") throw fail("企业 AI 积分账户已停用，请联系平台管理员", "AI_CREDIT_ACCOUNT_DISABLED");
  return { mode: "credits", account: accounts[0] };
}

export function withAiCreditProviderPermit(session, kind, operation) {
  return providerContext.run({ tenantId: Number(session.tenant.id), personId: Number(session.personId), kind }, operation);
}

export async function checkAiCreditProviderBoundary(session, kind, query) {
  const mode = await readAiCreditModeFromQuery(session, query);
  if (mode.mode !== "credits") return mode;
  const permit = providerContext.getStore();
  if (!permit || permit.tenantId !== Number(session.tenant.id) || permit.personId !== Number(session.personId) || permit.kind !== kind) {
    throw fail("此 AI 入口尚未接入企业积分结算，请使用已开通的生成任务；不会调用平台内部账户", "AI_CREDIT_CAPABILITY_DISABLED");
  }
  return mode;
}
