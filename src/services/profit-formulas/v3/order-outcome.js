import * as previous from '../v1/order-outcome.js';
import { reviewedAftersaleReason, reviewedAftersaleReasons } from '../../reviewed-aftersale-reasons.js';

export * from '../v1/order-outcome.js';
export const AFTERSALE_POLICY_VERSION = '2026-10-30';

function reviewedTerminal(row) {
  const outcome = previous.classifyOrderOutcome(row);
  return ['cancelled_pre_fulfillment', 'rejected_unclaimed', 'after_delivery_return'].includes(outcome)
    ? reviewedAftersaleReason(row) : null;
}

export function classifyOrderOutcome(row = {}) {
  const reason = reviewedTerminal(row);
  return reason ? reason.kind === 'cargo_loss' ? 'cargo_lost' : 'cancelled_pre_fulfillment'
    : previous.classifyOrderOutcome(row);
}

export function resolveOrderLossProfile(row = {}) {
  const reason = reviewedTerminal(row);
  if (reason?.kind === 'cargo_loss') return {
    code: 'cargo_purchase_collecting', label: '货损：商品成本＋收单费',
    formulaText: '损失 = 商品成本 + 收单费；不计佣金及运费，理赔到账后另核销',
    components: ['purchase', 'collecting']
  };
  if (reason) return previous.resolveOrderLossProfile({ ...row, outcome_type: 'cancelled_pre_fulfillment', outcome: 'cancelled_pre_fulfillment' });
  return previous.resolveOrderLossProfile(row);
}

export function classifyAftersaleBucket(row = {}, options = {}) {
  const reason = reviewedTerminal(row);
  return reason ? reason.kind === 'cargo_loss' ? 'cargo_loss' : 'pre_fulfillment_cancel'
    : previous.classifyAftersaleBucket(row, options);
}

export function classifyOrderAccounting(row = {}, options = {}) {
  const reason = reviewedTerminal(row);
  if (!reason) return previous.classifyOrderAccounting(row, options);
  const profile = resolveOrderLossProfile(row);
  return {
    order_nature: reason.kind === 'cargo_loss' ? 'cargo_loss' : 'cancellation',
    is_quality_order: false, is_passport_missing_order: previous.isPassportMissingOrder(row),
    outcome_type: classifyOrderOutcome(row), loss_profile_code: profile.code,
    loss_profile_label: profile.label, loss_formula_text: profile.formulaText || '',
    aftersale_bucket: classifyAftersaleBucket(row, options), should_include_aftersale_loss: true,
    aftersale_policy_version: AFTERSALE_POLICY_VERSION,
    claim_status: reason.kind === 'cargo_loss' ? '赔付待核对' : null
  };
}

export function resolveReturnLossCostPolicy(input = {}) {
  if (input.outcome === 'cargo_lost' || input.lossProfileCode === 'cargo_purchase_collecting') return {
    purchase: true, domestic: false, international: false, packaging: false,
    commission: false, service: false, collecting: true, aftersaleFinance: false
  };
  return previous.resolveReturnLossCostPolicy(input);
}

export function estimateOutcomeReturnLoss(input = {}) {
  if (input.outcome === 'cargo_lost' || input.lossProfileCode === 'cargo_purchase_collecting') {
    return Math.round((Number(input.purchaseCostPerUnit || 0) * Number(input.quantity || 1)
      + Number(input.collectingFeeTotal || 0) + Number.EPSILON) * 100) / 100;
  }
  return previous.estimateOutcomeReturnLoss(input);
}

export function isCancelledOutcome(row = {}) { return classifyOrderOutcome(row) === 'cancelled_pre_fulfillment'; }
export function isReturnedOutcome(row = {}) { return ['rejected_unclaimed', 'after_delivery_return'].includes(classifyOrderOutcome(row)); }

export function buildOrderOutcomeSql(alias = 'o', dialect = 'mysql') {
  const base = previous.buildOrderOutcomeSql(alias, dialect);
  const quote = value => `'${value.toLowerCase().replace(/'/g, "''")}'`;
  const match = kind => '(' + reviewedAftersaleReasons.filter(reason => reason.kind === kind).map(reason =>
    `(CAST(${alias}.cancel_reason_id AS CHAR) IN (${reason.codes.map(quote).join(',')}) OR LOWER(TRIM(COALESCE(NULLIF(${alias}.cancel_reason, ''), ${alias}.cancel_type, ''))) = ${quote(reason.original)})`
  ).join(' OR ') + ')';
  const terminal = `(${base.cancelLike} OR ${base.afterDeliveryReturn})`;
  const reviewedCancellation = `(${terminal} AND ${match('cancellation')})`;
  const cargoLost = `(${terminal} AND ${match('cargo_loss')})`;
  const remaining = `(NOT ${reviewedCancellation} AND NOT ${cargoLost})`;
  return { ...base, cargoLost,
    cancelledPreFulfillment: `(${reviewedCancellation} OR (${remaining} AND ${base.cancelledPreFulfillment}))`,
    rejectedUnclaimed: `(${remaining} AND ${base.rejectedUnclaimed})`,
    afterDeliveryReturn: `(${remaining} AND ${base.afterDeliveryReturn})`,
    deliveredSigned: `(${remaining} AND ${base.deliveredSigned})`,
    active: `(${remaining} AND ${base.active})`,
    effectiveSale: `(${remaining} AND ${base.effectiveSale})`
  };
}
