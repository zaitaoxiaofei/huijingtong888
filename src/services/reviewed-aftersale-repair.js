import { reviewedAftersaleReason } from './reviewed-aftersale-reasons.js';
import { getProfitFormula, usesDailyProfitFx } from './profit-formulas/registry.js';
import { profitCalculationFingerprint, recordOrderProfitCalculation } from './order-profit-calculation-versions.js';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const actualFields = ['sale_amount_cny', 'purchase_cost_cny', 'domestic_shipping_cny', 'international_shipping_cny',
  'packaging_cost_cny', 'commission_rate', 'commission_fee_cny', 'ozon_service_fee_cny', 'return_loss_cny',
  'advertising_cost_cny', 'other_fee_cny', 'gross_profit_cny', 'net_profit_cny'];

export function planReviewedAftersaleRepair(snapshot) {
  const { order, item, profit, state, estimate, actual } = snapshot;
  const reason = reviewedAftersaleReason(order);
  if (!reason || !state || !profit) throw new Error('修复对象缺少已核对原因、公式版本或利润明细');
  const version = usesDailyProfitFx(state.formula_version) ? 'V4' : 'V3';
  const accounting = getProfitFormula(version).outcome.classifyOrderAccounting(order);
  if (!['cancelled_pre_fulfillment', 'cargo_lost'].includes(accounting.outcome_type)) throw new Error('只能修复已核对的取消或配送货损订单');
  const evidence = parse(estimate?.inputs_json);
  const collecting = evidence?.estimate?.paymentFee;
  const blocked = reason.kind === 'cargo_loss' && (collecting === null || collecting === undefined
    || !Number.isFinite(Number(collecting)) || Number(collecting) < 0);
  const purchase = Number(item.frozen_purchase_cost) * Number(item.quantity);
  if (reason.kind === 'cargo_loss' && (item.frozen_purchase_cost == null || item.frozen_purchase_cost === ''
    || !Number.isFinite(purchase) || purchase < 0)) throw new Error('配送货损缺少商品成本依据');
  const loss = reason.kind === 'cargo_loss' && !blocked ? round(purchase + Number(collecting)) : 0;
  const actualKnown = actual && !Number(actual.legacy_baseline) && actual.input_completeness === 'complete'
    && ['ozon_finance', 'ozon_finance_daily_fx', 'aftersale_policy_correction'].includes(actual.source)
    && profit.profit_status === 'accrued';
  // Preserve verified acquiring fees. A legacy accrued flag is not evidence
  // that unknown historic charges are final actual amounts.
  const actualCollecting = actualKnown ? Number(profit.other_fee_cny || 0) : 0;
  const amount = actualKnown ? round((reason.kind === 'cargo_loss' ? purchase : 0) + actualCollecting) : loss;
  const nextProfit = Object.fromEntries(actualFields.map(field => [field, 0]));
  Object.assign(nextProfit, {
    purchase_cost_cny: reason.kind === 'cargo_loss' ? purchase : 0,
    other_fee_cny: actualKnown ? actualCollecting : reason.kind === 'cargo_loss' && !blocked ? Number(collecting) : 0,
    gross_profit_cny: amount ? -amount : 0, net_profit_cny: amount ? -amount : 0,
    profit_status: actualKnown ? 'accrued' : 'estimated',
    is_locked: actualKnown ? Number(profit.is_locked) : 0,
    locked_at: actualKnown ? profit.locked_at : null,
    lock_reason: actualKnown ? profit.lock_reason : null
  });
  const nextItem = { aftersale_loss: loss, estimated_profit: loss ? -loss : 0, estimated_commission: 0,
    actual_profit: actualKnown && amount ? -amount : 0, platform_fee_actual: actualKnown ? Number(item.platform_fee_actual || 0) : 0,
    settlement_state: actualKnown ? 'accrued' : 'pending' };
  return { order_id: Number(order.id), order_item_id: Number(item.id), posting_number: order.posting_number,
    tenant_key: order.tenant_key, reason_code: reason.reason_code, reason_label: reason.label,
    outcome_type: accounting.outcome_type, formula_before: state.formula_version, formula_after: version,
    before_hash: profitCalculationFingerprint(snapshot), blocked,
    blocking_reason: blocked ? '历史收单费预估依据缺失，不能将未知费用当成 0；先补证据再修复金额' : '',
    before_estimated_profit: Number(item.estimated_profit), after_estimated_profit: blocked ? null : nextItem.estimated_profit,
    before_net_profit: Number(profit.net_profit_cny), after_net_profit: blocked ? null : nextProfit.net_profit_cny,
    actual_basis: actualKnown ? 'verified_finance' : 'estimate_pending_finance', nextItem, nextProfit };
}

export async function readReviewedAftersaleSnapshot(query, itemId, { lock = false } = {}) {
  const [owned] = await query(`SELECT oi.id FROM order_items oi WHERE oi.id = ?${lock ? ' FOR UPDATE' : ''}`, [itemId]);
  if (!owned) throw new Error('订单商品不存在');
  const [order] = await query(`SELECT o.id,o.shop_id,o.posting_number,o.ordered_at,o.status,o.tracking_stage,o.logistics_status,
    o.delivered_at,o.accrued_at,o.cancel_reason_id,o.cancel_reason,o.cancel_type,o.cancel_initiator,o.cancelled_after_ship,
    CASE WHEN s.tenant_id>0 THEN CAST(s.tenant_id AS CHAR) ELSE 'admin' END tenant_key
    FROM orders o JOIN shops s ON s.id=o.shop_id JOIN order_items oi ON oi.order_id=o.id WHERE oi.id=?${lock ? ' FOR UPDATE' : ''}`, [itemId]);
  const [item] = await query('SELECT * FROM order_items WHERE id=?', [itemId]);
  const [profit] = await query(`SELECT * FROM order_profit_items WHERE order_item_id=?${lock ? ' FOR UPDATE' : ''}`, [itemId]);
  const [state] = await query(`SELECT * FROM order_profit_calc_state WHERE order_item_id=? AND tenant_key=?${lock ? ' FOR UPDATE' : ''}`, [itemId, order.tenant_key]);
  const revisions = state ? await query('SELECT * FROM order_profit_calc_revisions WHERE id IN (?,?)',
    [state.current_estimate_revision_id || 0, state.current_actual_revision_id || 0]) : [];
  return { order, item, profit: profit || null, state: state || null,
    estimate: revisions.find(row => String(row.id) === String(state?.current_estimate_revision_id)) || null,
    actual: revisions.find(row => String(row.id) === String(state?.current_actual_revision_id)) || null };
}

export async function applyReviewedAftersaleRepair(connection, plan, { commandId, actorId, reason }) {
  if (!commandId || !Number.isSafeInteger(actorId) || actorId <= 0 || !String(reason || '').trim()) throw new Error('修复需要命令编号、操作人及审核说明');
  if (plan.blocked) throw new Error(plan.blocking_reason);
  const query = async (sql, params) => (await connection.query(sql, params))[0];
  const snapshot = await readReviewedAftersaleSnapshot(query, plan.order_item_id, { lock: true });
  if (snapshot.order.tenant_key !== plan.tenant_key || Number(snapshot.order.id) !== plan.order_id) throw new Error('修复对象企业或订单归属已变化');
  const [done] = await query(`SELECT id FROM order_profit_calc_revisions WHERE tenant_key=? AND order_item_id=? AND command_id=? LIMIT 1`,
    [plan.tenant_key, plan.order_item_id, `${commandId}:applied:actual`]);
  if (done) return { reused: true };
  if (profitCalculationFingerprint(snapshot) !== plan.before_hash) throw new Error(`订单 ${plan.posting_number} 已变化，请重新生成修复预览`);
  const verified = planReviewedAftersaleRepair(snapshot);
  if (verified.blocked || profitCalculationFingerprint(verified) !== profitCalculationFingerprint(plan)) throw new Error('修复预览与当前计算不一致');
  const shared = { tenantId: plan.tenant_key, orderId: plan.order_id, orderItemId: plan.order_item_id, actorId, reason,
    inputCompleteness: 'complete', preserveBaseline: false };
  for (const layer of ['estimate', 'actual']) await recordOrderProfitCalculation(connection, {
    ...shared, layer, formulaVersion: snapshot.state.formula_version,
    inputCompleteness: 'legacy_unknown', source: 'aftersale_policy_before',
    commandId: `${commandId}:before:${layer}`, inputs: { reviewed_reason: plan.reason_code },
    outputs: { item: snapshot.item, profit: snapshot.profit, prior_state: snapshot.state }
  });
  await connection.execute('UPDATE order_profit_calc_state SET formula_version=? WHERE tenant_key=? AND order_item_id=?',
    [plan.formula_after, plan.tenant_key, plan.order_item_id]);
  await connection.execute(`UPDATE order_items SET ${Object.keys(plan.nextItem).map(field => `${field}=?`).join(',')} WHERE id=?`,
    [...Object.values(plan.nextItem), plan.order_item_id]);
  await connection.execute(`UPDATE order_profit_items SET ${Object.keys(plan.nextProfit).map(field => `${field}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE order_item_id=?`,
    [...Object.values(plan.nextProfit), plan.order_item_id]);
  for (const layer of ['estimate', 'actual']) await recordOrderProfitCalculation(connection, {
    ...shared, layer, formulaVersion: plan.formula_after, source: 'aftersale_policy_correction',
    commandId: `${commandId}:applied:${layer}`, inputs: { reviewed_reason: plan.reason_code, before_hash: plan.before_hash,
      actual_basis: plan.actual_basis }, outputs: { ...plan.nextItem, ...plan.nextProfit }
  });
  return { reused: false };
}
