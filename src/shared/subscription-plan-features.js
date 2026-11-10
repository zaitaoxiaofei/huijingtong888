// Built-in commercial plans. Custom historical plans keep their existing access;
// business permissions and tenant isolation are always checked separately.
export const BETA_PLAN_PRICES_FEN = Object.freeze({ trial_1d: 990, trial_7d: 1990, monthly: 29900, monthly_team: 39900, quarterly_team: 109900, yearly: 399900 });
export const TRIAL_PLAN_CODES = Object.freeze(['trial_1d', 'trial_7d']);
export function isTrialPlan(plan = {}) { return plan.subscription_status === "trial" || TRIAL_PLAN_CODES.includes(plan.code || plan.plan_code); }
export function planFeatures(tenant = {}) {
  if (isTrialPlan(tenant)) return { ai: false, tasks: false, finance: false };
  if (tenant.plan_code === 'monthly') return { ai: false, tasks: false, finance: true };
  return { ai: true, tasks: true, finance: true };
}
export function planFeatureMessage(feature) {
  return ({ ai: '当前套餐不含 AI 技能库，请在会员中心联系升级团队版；升级后仍按 AI 积分规则使用', tasks: '任务系统仅团队版开放，请在会员中心联系升级', finance: '体验套餐不含财务中心，请在会员中心联系开通正式套餐' })[feature];
}
const financeResources = new Set(['finance-center', 'finance-submissions', 'payroll', 'profits', 'monthly-billing-details', 'monthly-billing-orders', 'ozon-finance', 'profit-reconciliation', 'profit-snapshots', 'pending-settlement-costs', 'profit-aftersales', 'inventory-capital']);
export function subscriptionApiFeature(parts = []) {
  if (parts[1] === 'team') return 'tasks';
  if (financeResources.has(parts[1])) return 'finance';
  return null;
}
export function subscriptionPageFeature(path = '') {
  if (path === '/team-plan' || path.startsWith('/team/') || path.startsWith('/mobile/team')) return 'tasks';
  if (path === '/finance-center' || path.startsWith('/finance/') || path.startsWith('/profit/') || ['/mobile/finance', '/mobile/inventory-capital', '/mobile/monthly-billing'].includes(path)) return 'finance';
  return null;
}
export function publicPlanDetails(plan) {
  return { code: plan.code, name: plan.name, duration_days: Number(plan.duration_days), subscription_status: plan.subscription_status,
    account_limit: plan.account_limit === null ? null : Number(plan.account_limit), shop_limit: plan.shop_limit === null ? null : Number(plan.shop_limit),
    price_fen: BETA_PLAN_PRICES_FEN[plan.code] ?? null, features: planFeatures({ plan_code: plan.code, subscription_status: plan.subscription_status }) };
}
