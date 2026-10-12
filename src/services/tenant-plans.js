import { normalizeTenantQuotaLimit } from "./tenant-quotas.js";

export const DEFAULT_TENANT_PLAN_PRESETS = Object.freeze([
  { code: "trial_1d", name: "1 天体验", duration_days: 1, subscription_status: "trial", account_limit: 1, shop_limit: 2 },
  { code: "trial_7d", name: "7 天体验", duration_days: 7, subscription_status: "trial", account_limit: 1, shop_limit: 2 },
  { code: "monthly", name: "月租基础版", duration_days: 30, subscription_status: "active", account_limit: 1, shop_limit: 2 },
  { code: "monthly_team", name: "月租团队版", duration_days: 30, subscription_status: "active", account_limit: 3, shop_limit: 10 },
  { code: "quarterly_team", name: "季度团队版", duration_days: 90, subscription_status: "active", account_limit: 3, shop_limit: 10 },
  { code: "yearly", name: "年租团队版", duration_days: 365, subscription_status: "active", account_limit: 3, shop_limit: 10 }
]);

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

export function normalizeTenantPlanInput(body = {}) {
  const name = String(body.name || "").trim().slice(0, 80);
  if (!name) invalid("套餐名称不能为空");
  const durationDays = Number(body.duration_days ?? body.durationDays);
  if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 3650) invalid("套餐时长必须是 1 到 3650 天之间的整数");
  const accountLimit = normalizeTenantQuotaLimit(body.account_limit ?? body.accountLimit, null, "账号总数");
  if (accountLimit !== null && accountLimit < 1) invalid("套餐账号总数至少为 1（含主账号）；留空表示不限");
  const shopLimit = normalizeTenantQuotaLimit(body.shop_limit ?? body.shopLimit, null, "店铺额度");
  const subscriptionStatus = String(body.subscription_status || body.subscriptionStatus || "active").trim();
  if (!["trial", "active"].includes(subscriptionStatus)) invalid("套餐类型仅支持体验或正式订阅");
  return {
    name,
    duration_days: durationDays,
    subscription_status: subscriptionStatus,
    account_limit: accountLimit,
    shop_limit: shopLimit
  };
}

export function tenantPlanMemberLimit(plan = {}) {
  return plan.account_limit == null ? null : Math.max(0, Number(plan.account_limit) - 1);
}
