import { buildOrderProfitDetailSnapshotPayload } from "./order-profit-detail-snapshots.js";
import { validateDailyFxSnapshot } from "./profit-formulas/v2/fx.js";

const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const amount = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const ACTUAL_FIELDS = {
  sale: "sale_amount_cny", purchase: "purchase_cost_cny", domestic: "domestic_shipping_cny",
  international: "international_shipping_cny", packaging: "packaging_cost_cny", commission: "commission_fee_cny",
  collecting: "other_fee_cny", service: "ozon_service_fee_cny", aftersale: "return_loss_cny", other: "advertising_cost_cny", profit: "net_profit_cny"
};

function firstEstimateRevision(record) {
  const eligible = revision => ["V2", "V4"].includes(revision?.formula_version) && revision.layer === "estimate"
    && !revision.legacy_baseline && !revision.inputs?.estimate?.fxPending;
  if (record?.first_estimate_revision) return eligible(record.first_estimate_revision) ? record.first_estimate_revision : null;
  if (record?.truncated) return null;
  return [...(record?.revisions || [])].filter(eligible).sort((a, b) => Number(a.revision_no) - Number(b.revision_no))[0] || null;
}

export function orderProfitFxDetailFinalRate(order, state) {
  if (!state?.orderFx) return null;
  const requiresSigned = ["delivered_signed", "after_delivery_return"].includes(order.outcome_type);
  if (!state.signedFx && requiresSigned) return null;
  return validateDailyFxSnapshot(state.signedFx || state.orderFx, {
    businessDate: state.signedFx ? state.signed_business_date : state.ordered_business_date
  });
}

// The legacy builder supplies only the existing row/layout contract. V2
// actual amounts come from the atomically committed settlement projection,
// never from reinterpreting legacy amount_cny columns or incomplete bill rows.
export function buildOrderProfitFxDetailSnapshotPayload(order, items, finance, fxState, { financeErrorCode = null, calculationVersions = {} } = {}) {
  const base = buildOrderProfitDetailSnapshotPayload(order, [], []);
  const firstRevisions = items.map(item => firstEstimateRevision(calculationVersions.items?.find(record => Number(record.order_item_id) === Number(item.id))));
  const baselines = firstRevisions.map(revision => revision?.outputs?.estimated_breakdown || null);
  const completeEstimate = baselines.length > 0 && baselines.every(baseline => baseline
    && Object.values(ACTUAL_FIELDS).every(field => amount(baseline[field]) !== null));
  const originalProfits = firstRevisions.map(revision => amount(revision?.outputs?.estimated_profit) ?? amount(revision?.outputs?.estimated_breakdown?.net_profit_cny));
  const estimated = Object.fromEntries(Object.entries(ACTUAL_FIELDS).map(([key, field]) => [key,
    completeEstimate ? round(baselines.reduce((sum, baseline) => sum + Number(baseline[field]), 0)) : null]));
  if (estimated.profit === null && originalProfits.length && originalProfits.every(value => value !== null)) {
    estimated.profit = round(originalProfits.reduce((sum, value) => sum + value, 0));
  }
  if (estimated.sale === null && baselines.length && baselines.every(baseline => amount(baseline?.sale_amount_cny) !== null)) {
    estimated.sale = round(baselines.reduce((sum, baseline) => sum + Number(baseline.sale_amount_cny), 0));
  }
  estimated.costTotal = completeEstimate ? round(Object.keys(ACTUAL_FIELDS).filter(key => !["sale", "profit"].includes(key))
    .reduce((sum, key) => sum + estimated[key], 0)) : estimated.sale !== null && estimated.profit !== null ? round(estimated.sale - estimated.profit) : null;
  const signedOutcome = ["delivered_signed", "after_delivery_return"].includes(order.outcome_type);
  const noDeliveryOutcome = ["cancelled_pre_fulfillment", "rejected_unclaimed", "cargo_lost"].includes(order.outcome_type);
  const expectedLock = fxState?.signedFx && (signedOutcome || noDeliveryOutcome) ? "finance_accrued_signed_day_fx"
    : noDeliveryOutcome ? "finance_accrued_no_delivery_order_day_fx" : null;
  const completeProjection = items.length > 0 && items.every(item => item.profit_status === "accrued" && item.settlement_state === "accrued"
    && expectedLock && item.lock_reason === expectedLock && Object.values(ACTUAL_FIELDS).every(field => amount(item[field]) !== null));
  const actualReady = Boolean(completeProjection && fxState?.state === "ready" && orderProfitFxDetailFinalRate(order, fxState)
    && !financeErrorCode && !fxState?.last_error_code && finance.length > 0);
  const actual = Object.fromEntries(Object.entries(ACTUAL_FIELDS).map(([key, field]) => [key,
    actualReady ? round(items.reduce((sum, item) => sum + Number(item[field]), 0)) : null]));
  actual.costTotal = actualReady ? round(Object.keys(ACTUAL_FIELDS).filter(key => !["sale", "profit"].includes(key))
    .reduce((sum, key) => sum + actual[key], 0)) : null;
  const actualRate = actualReady && actual.sale ? actual.profit / actual.sale * 100 : null;
  const matchStatus = actualReady ? "settled" : finance.length ? "matched" : "unmatched";
  const sale = actualReady ? actual.sale : estimated.sale;
  return {
    ...base, sale_amount_cny: sale, estimated_profit_cny: estimated.profit, estimated_cost_total_cny: estimated.costTotal,
    estimated_breakdown_ready: completeEstimate, actual_profit_cny: actual.profit, actual_profit_rate: actualRate,
    actual_cost_total_cny: actual.costTotal, actual_profit_ready: actualReady ? 1 : 0,
    finance_match_status: matchStatus, finance_rows: finance.length,
    summary: { ...base.summary, saleAmount: sale, estimatedProfit: estimated.profit, estimatedCostTotal: estimated.costTotal,
      estimatedBreakdownReady: completeEstimate, actualProfit: actual.profit, actualProfitRate: actualRate,
      actualCostTotal: actual.costTotal, actualProfitReady: actualReady, financeMatchStatus: matchStatus, financeRows: finance.length },
    detailRows: base.detailRows.map(row => ({ ...row, estimated: estimated[row.key], actual: actual[row.key],
      ...(estimated[row.key] === null ? { estimatedText: "未留存完整预估依据", note: "未保存完整的首次预估费用基线，不能用当前真实成本倒推。" } : {}),
      ...(!completeEstimate && row.key === "costTotal" && estimated.costTotal !== null ? { note: "由首次预估销售额减首次预估利润确认总成本；费用细项未完整保存。" } : {}),
      diff: actual[row.key] === null || estimated[row.key] === null ? null : round(actual[row.key] - estimated[row.key]) })),
    financeTotals: actualReady ? { commission: actual.commission, collecting_fee: actual.collecting,
      platform_delivery: actual.international, other: actual.service, aftersale_loss: actual.aftersale } : {}
  };
}
