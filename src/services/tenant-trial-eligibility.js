import { TRIAL_PLAN_CODES, isTrialPlan } from '../shared/subscription-plan-features.js';
export function tenantHasUsedTrial(tenant = {}) {
  let flags = tenant.feature_flags_json || {};
  if (typeof flags === 'string') { try { flags = JSON.parse(flags); } catch { throw new Error('企业体验记录无法读取，请联系平台管理员核查'); } }
  return flags.beta_trial_used === true || flags.beta_trial_used === 1 || tenant.subscription_status === 'trial' || TRIAL_PLAN_CODES.includes(tenant.plan_code);
}
export async function claimTenantTrial(connection, tenant, plan) {
  if (!isTrialPlan(plan)) {
    if (tenantHasUsedTrial(tenant)) await markTrial(connection, tenant.id);
    return;
  }
  if (tenantHasUsedTrial(tenant)) throw Object.assign(new Error('本企业已使用体验套餐，1 天和 7 天体验只能选择一次；请开通正式套餐'), { statusCode: 409 });
  // Older voucher redemptions predate the durable marker. Do not grant another
  // trial after the current plan has changed to a paid one.
  const [rows] = await connection.execute(`SELECT id FROM tenant_subscription_vouchers WHERE used_by_tenant_id = ? AND status = 'used'
    AND JSON_UNQUOTE(JSON_EXTRACT(plan_snapshot_json, '$.subscription_status')) = 'trial' LIMIT 1`, [Number(tenant.id)]);
  if (rows.length) throw Object.assign(new Error('本企业已使用体验套餐，请开通正式套餐'), { statusCode: 409 });
  await markTrial(connection, tenant.id);
}
async function markTrial(connection, tenantId) {
  await connection.execute("UPDATE tenants SET feature_flags_json = JSON_SET(COALESCE(feature_flags_json, JSON_OBJECT()), '$.beta_trial_used', true) WHERE id = ?", [Number(tenantId)]);
}
