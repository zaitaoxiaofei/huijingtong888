import { isPlatformAdmin } from "../shared/permissions.js";

const BASIC_REQUESTS = new Set([
  "GET tools/pricing/reference-rate", "GET tools/pricing/rfbs-marketplace", "GET tools/pricing/logistics-rules",
  "GET system/info", "GET system/update-status", "GET user-preferences", "POST user-preferences"
]);

export function subscriptionAccessDecision(session, parts = [], method = "GET") {
  if (isPlatformAdmin(session) || parts[1] === "auth" || session?.tenant?.access_allowed) return { allowed: true };
  const key = `${String(method).toUpperCase()} ${parts.slice(1).join("/")}`;
  if (session?.tenant?.id && BASIC_REQUESTS.has(key)) return { allowed: true };
  return { allowed: false, status: 402, code: "TENANT_SUBSCRIPTION_REQUIRED",
    error: "当前企业尚未激活或会员已到期，请前往会员中心输入激活码；基础定价和利润工具仍可使用" };
}
