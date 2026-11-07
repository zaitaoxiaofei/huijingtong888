import { getProfitFormula } from "./profit-formulas/registry.js";
import { attributeOrderProfitFx, moneyToCny, validateDailyFxSnapshot } from "./profit-formulas/v2/fx.js";
import { profitCalculationFingerprint } from "./order-profit-calculation-versions.js";

const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const pending = code => ({ ok: false, code, items: [] });

export function fxSettlementInputFingerprint({ order, items, targetItemId, fxState, finance }) {
  const date = value => {
    if (!value) return null;
    const text = value instanceof Date ? value.toISOString() : String(value);
    const parsed = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(text) ? text : text.replace(" ", "T") + "Z");
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : text;
  };
  const target = items.find(item => Number(item.id) === Number(targetItemId));
  const costFields = ["quantity", "sale_price", "frozen_purchase_cost", "frozen_domestic_shipping", "purchase_cost_cny", "domestic_shipping_cny", "advertising_cost_cny"];
  const orderFields = ["order_status", "tracking_stage", "logistics_status", "cancel_reason", "cancel_reason_id", "cancel_initiator", "cancel_type", "cancelled_after_ship"];
  const financeFields = ["id", "operation_id", "posting_number", "operation_type", "operation_type_name", "service_type", "service_name", "amount", "amount_cny",
    "accruals_for_sale", "accruals_for_sale_cny", "currency_code", "currency_source", "derived_from_parent_posting", "parent_allocation_share"];
  return profitCalculationFingerprint({
    order: { ...Object.fromEntries(orderFields.map(field => [field, String(order[field] ?? "")])),
      order_id: Number(order.order_id || order.id), shop_id: Number(order.shop_id), posting_number: order.posting_number,
      ordered_at: date(order.ordered_at), delivered_at: date(order.delivered_at), accrued_at: date(order.accrued_at) },
    target: target ? { id: Number(target.id), ozon_sku: String(target.ozon_sku),
      actual_revision_id: String(target.current_actual_revision_id || ""),
      ...Object.fromEntries(costFields.map(field => [field, Number(target[field] || 0)])) } : null,
    weights: items.map(item => ({ id: Number(item.id), ozon_sku: String(item.ozon_sku), quantity: Number(item.quantity), formula_version: item.formula_version || "V1" })).sort((a, b) => a.id - b.id),
    fx: { order_fx_id: String(fxState?.orderFx?.id || ""), signed_fx_id: String(fxState?.signedFx?.id || ""), prices: fxState?.prices || [] },
    finance_rows: finance?.rows.map(row => Object.fromEntries(financeFields.map(field => [field, row[field] ?? null]))) || [],
    allocation: finance?.allocation || null
  });
}

// No writes and no network calls. Currency/allocation evidence is supplied by
// the V2 finance reader; bill completeness is established here separately.
export async function planOrderFxSettlement({ order, items, fxState, finance, initialEstimates,
  classifyCategory, packagingFeeForSaleAmount, accounting }) {
  if (!fxState?.orderFx) return pending("ORDER_PROFIT_ORDER_FX_PENDING");
  const formula = getProfitFormula("V2");
  const outcome = accounting.outcome_type;
  if (outcome === "active") return pending("ORDER_PROFIT_TERMINAL_STATUS_PENDING");
  const requiresSigned = outcome === "delivered_signed" || outcome === "after_delivery_return";
  if (requiresSigned && !fxState.signedFx) return pending("ORDER_PROFIT_SIGNED_FX_PENDING");
  if (!finance?.ok) return pending(finance?.code || "ORDER_PROFIT_FINANCE_PENDING");
  const orderFx = validateDailyFxSnapshot(fxState.orderFx, { businessDate: fxState.ordered_business_date });
  const finalFx = requiresSigned || fxState.signedFx
    ? validateDailyFxSnapshot(fxState.signedFx, { businessDate: fxState.signed_business_date }) : orderFx;
  const basis = !requiresSigned && !fxState.signedFx ? "no_delivery_order_day" : "signed_day";
  if (!items.length || !finance.rows.length) return pending("ORDER_PROFIT_FINANCE_PENDING");
  const weights = new Map();
  for (const item of items) {
    const original = fxState.prices?.find(price => String(price.ozon_sku) === String(item.ozon_sku));
    if (!original || !["CNY", "RUB"].includes(original.currency) || !(Number(item.quantity) > 0)) return pending("ORDER_PROFIT_SALE_CURRENCY_UNKNOWN");
    weights.set(Number(item.id), moneyToCny(original.amount, original.currency, orderFx) * Number(item.quantity));
    if (!initialEstimates.has(Number(item.id))) return pending("ORDER_PROFIT_INITIAL_ESTIMATE_PENDING");
  }
  const totalWeight = [...weights.values()].reduce((sum, amount) => sum + amount, 0);
  if (!(totalWeight > 0)) return pending("ORDER_PROFIT_SALE_AMOUNT_UNKNOWN");
  const signedTotals = finance.rows.reduce((result, row) => {
    const category = classifyCategory(row);
    result[category] = (result[category] || 0) + Number(row.amount_cny);
    return result;
  }, {});
  const totals = Object.fromEntries(Object.entries(signedTotals).map(([category, amount]) => [category, round(Math.max(0, -amount))]));
  const saleBasis = finance.rows.reduce((selected, row) => Math.abs(Number(row.accruals_for_sale_cny)) > Math.abs(Number(selected?.accruals_for_sale_cny || 0)) ? row : selected, null);
  const signedAccruals = finance.income_mode === "signed_accruals";
  const incomeRows = signedAccruals ? finance.income_rows || [] : [];
  const grossSale = signedAccruals ? Number(finance.sale_accrual_cny) : Math.abs(Number(saleBasis?.accruals_for_sale_cny || 0));
  const hasSaleEvidence = signedAccruals ? incomeRows.length > 0 && Number.isFinite(grossSale) : grossSale > 0.005;
  const purchaseKnown = items.every(item => Number(item.purchase_cost_cny || 0) > 0.005
    || Number(item.frozen_purchase_cost || 0) * Number(item.quantity) > 0.005);
  if (outcome === "delivered_signed" && (!purchaseKnown || !hasSaleEvidence || !(totals.commission > 0.005)
    || !(totals.collecting_fee > 0.005) || !(Number(totals.platform_delivery || 0) + Number(totals.international_transport || 0) > 0.005))) {
    return pending("ORDER_PROFIT_FINAL_BILL_INCOMPLETE");
  }
  const cancelled = outcome === "cancelled_pre_fulfillment";
  const returned = ["rejected_unclaimed", "after_delivery_return"].includes(outcome);
  const terminalNoRevenue = cancelled || returned;
  const policy = returned ? formula.outcome.resolveReturnLossCostPolicy({ outcome, lossProfileCode: accounting.loss_profile_code }) : null;
  const use = {
    commission: !cancelled && (!policy || policy.commission),
    collecting_fee: !policy || policy.collecting,
    platform_delivery: !cancelled && (!policy || policy.international),
    international_transport: !cancelled && (!policy || policy.international),
    other: !cancelled && (!policy || policy.service),
    aftersale_loss: !cancelled && (!policy || policy.aftersaleFinance)
  };
  const projections = [];
  for (const item of items) {
    const share = weights.get(Number(item.id)) / totalWeight;
    const itemSale = terminalNoRevenue ? 0 : round(grossSale * share);
    const localItemSale = weights.get(Number(item.id));
    const purchaseCost = cancelled || (policy && !policy.purchase) ? 0 : Number(item.purchase_cost_cny || Number(item.frozen_purchase_cost || 0) * Number(item.quantity));
    const domesticShipping = cancelled || (policy && !policy.domestic) ? 0 : Number(item.domestic_shipping_cny || Number(item.frozen_domestic_shipping || 0) * Number(item.quantity));
    // Packaging and other CNY costs are fixed for the counterfactual comparison.
    const packagingCost = cancelled || (policy && !policy.packaging) ? 0 : Number(await packagingFeeForSaleAmount(terminalNoRevenue ? localItemSale : itemSale));
    const advertisingCost = cancelled ? 0 : Number(item.advertising_cost_cny || 0);
    const fee = category => use[category] ? round(Number(totals[category] || 0) * share) : 0;
    const commissionFeeCny = fee("commission"), actualServiceFeeCny = fee("other"), otherFee = fee("collecting_fee");
    const actualInternationalShipping = round(fee("platform_delivery") + fee("international_transport"));
    const returnLoss = fee("aftersale_loss");
    const { actualProfit, grossProfit } = formula.aggregateActualProfit({ terminalNoRevenue, itemSale, purchaseCost, domesticShipping,
      actualInternationalShipping, packagingCost, commissionFeeCny, actualServiceFeeCny, returnLoss, advertisingCost, otherFee });
    const actualNetAmounts = [];
    if (!terminalNoRevenue) {
      if (signedAccruals) {
        for (const row of incomeRows) actualNetAmounts.push({ amount: Number(row.accruals_for_sale) * share, currency: row.currency_code,
          role: "sale", operation_id: row.operation_id, finance_item_id: row.id });
      } else actualNetAmounts.push({ amount: Math.abs(Number(saleBasis.accruals_for_sale)) * share, currency: saleBasis.currency_code, role: "sale" });
    }
    for (const row of finance.rows) {
      const category = classifyCategory(row);
      if (use[category] && Number(totals[category] || 0) > 0) actualNetAmounts.push({ amount: Number(row.amount) * share, currency: row.currency_code,
        role: category, operation_id: row.operation_id, finance_item_id: row.id });
    }
    // An explicitly billed zero-loss cancellation still has a valid comparison.
    if (!actualNetAmounts.length) actualNetAmounts.push({ amount: 0, currency: "CNY", role: "zero_final_loss" });
    const attribution = attributeOrderProfitFx({ initialEstimatedProfitCny: initialEstimates.get(Number(item.id)), actualNetAmounts,
      actualCnyCost: purchaseCost + domesticShipping + packagingCost + advertisingCost, orderFx, signedFx: finalFx });
    attribution.actual_profit_at_signed_rate_cny = actualProfit;
    attribution.total_variance_cny = round(actualProfit - attribution.initial_estimated_profit_cny);
    attribution.rounding_difference_cny = round(attribution.total_variance_cny - attribution.fx_gain_loss_cny - attribution.business_variance_cny);
    attribution.settlement_basis = basis;
    projections.push({ item, share, itemSale, purchaseCost, domesticShipping, actualInternationalShipping, packagingCost,
      commissionFeeCny, commissionRate: grossSale > 0 ? Number(totals.commission || 0) / grossSale : 0,
      actualServiceFeeCny, returnLoss, advertisingCost, otherFee, actualProfit, grossProfit,
      totalFinanceFeeCny: round(Object.entries(totals).reduce((sum, [category, value]) => sum + (category === "income" ? 0 : Number(value)), 0) * share),
      attribution, actualNetAmounts });
  }
  return { ok: true, items: projections, orderFx, finalFx, settlementBasis: basis, categoryTotals: totals, accounting };
}
