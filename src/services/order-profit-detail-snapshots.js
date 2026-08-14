import { classifyOrderAccounting, resolveReturnLossCostPolicy } from "./order-outcome.js";

function roundMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) / 100 : 0;
}

function positiveAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function nullableNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function itemQuantity(item = {}) {
  return Math.max(Number(item.quantity || 1), 1);
}

function orderAccounting(order = {}) {
  return classifyOrderAccounting(order);
}

function isTerminalNoOriginalRevenue(order = {}) {
  return ["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(String(order.outcome_type || "").trim());
}

function terminalLossPolicy(order = {}) {
  if (String(order.outcome_type || "") === "cancelled_pre_fulfillment") {
    return {
      purchase: false,
      domestic: false,
      international: false,
      packaging: false,
      commission: false,
      service: false,
      collecting: true,
      aftersaleFinance: false
    };
  }
  return resolveReturnLossCostPolicy({ outcome: order.outcome_type, lossProfileCode: order.loss_profile_code });
}

function saleAmount(item = {}, order = {}) {
  return positiveAmount(item.sale_amount_cny) || Number(item.sale_price || 0) * itemQuantity(item);
}

function orderSaleAmount(rows = [], order = {}, financeRows = []) {
  const outcome = String(order.outcome_type || "");
  if (outcome === "cancelled_pre_fulfillment") return 0;
  if (["rejected_unclaimed", "after_delivery_return"].includes(outcome)) {
    return hasFinanceSaleAccrual(financeRows) ? sumRows(rows, (item) => positiveAmount(item.sale_amount_cny)) : 0;
  }
  return sumRows(rows, (item) => saleAmount(item, order));
}

function estimatedPurchase(item = {}) {
  return positiveAmount(item.frozen_purchase_cost) * itemQuantity(item) || positiveAmount(item.purchase_cost_cny);
}

function estimatedDomestic(item = {}) {
  return positiveAmount(item.frozen_domestic_shipping) * itemQuantity(item) || positiveAmount(item.domestic_shipping_cny);
}

function estimatedInternational(item = {}) {
  return positiveAmount(item.frozen_international_shipping) * itemQuantity(item) || positiveAmount(item.international_shipping_cny);
}

function appliedOrEstimated(applied, estimated) {
  return positiveAmount(applied) || positiveAmount(estimated);
}

function terminalComponentTotals(rows = [], order = {}) {
  const policy = terminalLossPolicy(order);
  const totals = rows.reduce((acc, item) => {
    const referencePurchase = estimatedPurchase(item);
    const referenceDomestic = estimatedDomestic(item);
    const referenceInternational = estimatedInternational(item);
    const financeActual = hasFinanceActualProfit(item);
    acc.purchase += policy.purchase ? (financeActual ? nullableNumber(item.purchase_cost_cny) ?? referencePurchase : appliedOrEstimated(item.purchase_cost_cny, referencePurchase)) : 0;
    acc.domestic += policy.domestic ? (financeActual ? nullableNumber(item.domestic_shipping_cny) ?? referenceDomestic : appliedOrEstimated(item.domestic_shipping_cny, referenceDomestic)) : 0;
    acc.international += policy.international ? (financeActual ? nullableNumber(item.international_shipping_cny) ?? referenceInternational : appliedOrEstimated(item.international_shipping_cny, referenceInternational)) : 0;
    acc.packaging += policy.packaging ? positiveAmount(item.packaging_cost_cny) : 0;
    acc.commission += policy.commission
      ? (financeActual ? nullableNumber(item.commission_fee_cny) ?? positiveAmount(item.estimated_commission) : positiveAmount(item.commission_fee_cny) || positiveAmount(item.estimated_commission))
      : 0;
    acc.collecting += policy.collecting ? positiveAmount(item.other_fee_cny) : 0;
    acc.service += policy.service ? positiveAmount(item.ozon_service_fee_cny) : 0;
    acc.aftersale += policy.aftersaleFinance
      ? (financeActual ? nullableNumber(item.return_loss_cny) ?? positiveAmount(item.aftersale_loss) : positiveAmount(item.return_loss_cny) || positiveAmount(item.aftersale_loss))
      : 0;
    acc.other += 0;
    return acc;
  }, {
    purchase: 0,
    domestic: 0,
    international: 0,
    packaging: 0,
    commission: 0,
    collecting: 0,
    service: 0,
    aftersale: 0,
    other: 0
  });
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, roundMoney(value)]));
}

function financeCategory(row = {}) {
  const raw = [row.service_type, row.service_name, row.operation_type, row.operation_type_name]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  const normalized = raw.toLowerCase();
  if (normalized.includes("sale_commission") || normalized.includes("commission") || raw === "Ozon 销售佣金") return "commission";
  if (normalized.includes("marketplaceredistributionofacquiringoperation")) return "collecting_fee";
  if (normalized.includes("return_delivery_charge") || normalized.includes("returnflowlogistic") || normalized.includes("returnnotdelivtocustomer")) return "aftersale_loss";
  if (
    normalized.includes("delivery_charge")
    || normalized.includes("marketplaceredistributionofdeliveryservicesoperation")
    || normalized.includes("marketplaceserviceitemredistributionlastmile")
  ) return "platform_delivery";
  if (normalized.includes("agencyfeeaggregator3plglobal")) return "international_transport";
  if (normalized.includes("возврат") || normalized.includes("компенсац")) return "aftersale_loss";
  if (raw === "Перевыставление услуг доставки" || raw.includes("достав")) return "platform_delivery";
  if (raw.includes("международ") || raw.includes("транспортно-экспедиционных")) return "international_transport";
  if (raw.includes("Частичная компенсация покупателю") || raw.includes("возврат") || raw.includes("недовлож")) return "aftersale_loss";
  return "other";
}

function sumRows(rows = [], getter = () => 0) {
  return roundMoney(rows.reduce((sum, row) => sum + Number(getter(row) || 0), 0));
}

function hasFinanceActualProfit(item = {}) {
  const statusText = [item.settlement_state, item.profit_status].map((value) => String(value || "").toLowerCase()).join(" ");
  return statusText.includes("accrued") && String(item.lock_reason || "").toLowerCase().includes("finance");
}

function hasFinanceSaleAccrual(finance = []) {
  return finance.some((row) => Math.abs(Number(row.accruals_for_sale_cny || row.accruals_for_sale || 0)) > 0.005);
}

function hasRequiredFinanceBasis(finance = [], order = {}) {
  if (isFinalProfitOutcome(order) && ["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(String(order.outcome_type || ""))) return true;
  return hasFinanceSaleAccrual(finance) && finance.some((row) => financeCategory(row) === "commission");
}

function isFinalProfitOutcome(order = {}) {
  const text = [
    order.outcome_type,
    order.status,
    order.tracking_stage,
    order.logistics_status,
    order.accrued_at
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return text.includes("delivered")
    || text.includes("signed")
    || text.includes("cancel")
    || text.includes("return")
    || text.includes("reject")
    || text.includes("accrued");
}

function financeCategoryTotal(finance = [], categories = []) {
  const keys = new Set(Array.isArray(categories) ? categories : [categories]);
  let matched = false;
  let hasSignedAmount = false;
  let fallbackTotal = 0;
  const signedTotal = finance.reduce((sum, row) => {
    const key = financeCategory(row);
    if (!keys.has(key)) return sum;
    matched = true;
    const rawAmount = Number(row.amount_cny || 0);
    if (Math.abs(rawAmount) > 0.000001) {
      hasSignedAmount = true;
      return sum + rawAmount;
    }
    fallbackTotal += positiveAmount(row.fee_amount_cny);
    return sum;
  }, 0);
  return matched ? roundMoney(hasSignedAmount ? Math.max(0, -signedTotal) : fallbackTotal) : null;
}

function valueDiff(actual, estimated) {
  if (actual === null || actual === undefined) return null;
  return roundMoney(Number(actual || 0) - Number(estimated || 0));
}

export function buildOrderProfitDetailSnapshotPayload(order = {}, items = [], finance = []) {
  const rows = Array.isArray(items) ? items : [];
  const financeRows = Array.isArray(finance) ? finance : [];
  const accounting = orderAccounting(order);
  const normalizedOrder = {
    ...order,
    outcome_type: order.outcome_type || accounting.outcome_type,
    loss_profile_code: order.loss_profile_code || accounting.loss_profile_code
  };
  const terminalNoOriginalRevenue = isTerminalNoOriginalRevenue(normalizedOrder);
  const hasFinalFinanceBasis = financeRows.length > 0 && hasRequiredFinanceBasis(financeRows, normalizedOrder);
  const actualProfitReady = hasFinalFinanceBasis && rows.length > 0 && rows.every((item) => hasFinanceActualProfit(item));
  const sale = orderSaleAmount(rows, normalizedOrder, financeRows);
  const terminalTotals = terminalNoOriginalRevenue ? terminalComponentTotals(rows, normalizedOrder) : null;
  const estimated = {
    sale,
    purchase: terminalTotals ? terminalTotals.purchase : sumRows(rows, estimatedPurchase),
    domestic: terminalTotals ? terminalTotals.domestic : sumRows(rows, estimatedDomestic),
    international: terminalTotals ? terminalTotals.international : sumRows(rows, estimatedInternational),
    packaging: terminalTotals ? terminalTotals.packaging : sumRows(rows, (item) => positiveAmount(item.packaging_cost_cny)),
    commission: terminalTotals ? terminalTotals.commission : sumRows(rows, (item) => positiveAmount(item.estimated_commission) || positiveAmount(item.commission_fee_cny)),
    collecting: terminalTotals ? terminalTotals.collecting : 0,
    service: terminalTotals ? terminalTotals.service : sumRows(rows, (item) => positiveAmount(item.ozon_service_fee_cny)),
    aftersale: terminalTotals ? terminalTotals.aftersale : sumRows(rows, (item) => positiveAmount(item.aftersale_loss) || positiveAmount(item.return_loss_cny)),
    other: terminalTotals ? terminalTotals.other : sumRows(rows, (item) => positiveAmount(item.advertising_cost_cny) + positiveAmount(item.other_fee_cny)),
    profit: terminalTotals ? null : sumRows(rows, (item) => nullableNumber(item.estimated_profit) ?? nullableNumber(item.net_profit_cny) ?? 0)
  };
  const financeCollecting = financeCategoryTotal(financeRows, "collecting_fee");
  const actual = {
    sale,
    purchase: terminalTotals ? terminalTotals.purchase : sumRows(rows, (item) => nullableNumber(item.purchase_cost_cny) ?? estimatedPurchase(item)),
    domestic: terminalTotals ? terminalTotals.domestic : sumRows(rows, (item) => nullableNumber(item.domestic_shipping_cny) ?? estimatedDomestic(item)),
    international: terminalTotals ? terminalTotals.international : financeCategoryTotal(financeRows, ["platform_delivery", "international_transport"]),
    packaging: terminalTotals ? terminalTotals.packaging : sumRows(rows, (item) => positiveAmount(item.packaging_cost_cny)),
    commission: terminalTotals ? terminalTotals.commission : financeCategoryTotal(financeRows, "commission"),
    collecting: terminalTotals ? terminalTotals.collecting : financeCollecting,
    service: terminalTotals ? terminalTotals.service : financeCategoryTotal(financeRows, "other"),
    aftersale: terminalTotals ? terminalTotals.aftersale : financeCategoryTotal(financeRows, "aftersale_loss"),
    other: terminalTotals
      ? terminalTotals.other
      : actualProfitReady
        ? sumRows(rows, (item) => positiveAmount(item.advertising_cost_cny) + (financeCollecting === null ? positiveAmount(item.other_fee_cny) : 0))
        : null
  };
  if (actualProfitReady) {
    actual.international = actual.international ?? 0;
    actual.commission = actual.commission ?? 0;
    actual.collecting = actual.collecting ?? 0;
    actual.service = actual.service ?? 0;
    actual.aftersale = actual.aftersale ?? 0;
  }

  const estimatedCostTotal = roundMoney(estimated.purchase + estimated.domestic + estimated.international + estimated.packaging + estimated.commission + estimated.collecting + estimated.service + estimated.aftersale + estimated.other);
  const actualCostTotal = actualProfitReady || terminalTotals
    ? roundMoney(actual.purchase + actual.domestic + (actual.international || 0) + actual.packaging + (actual.commission || 0) + (actual.collecting || 0) + (actual.service || 0) + (actual.aftersale || 0) + (actual.other || 0))
    : null;
  const estimatedProfit = terminalTotals ? roundMoney(sale - estimatedCostTotal) : estimated.profit || roundMoney(sale - estimatedCostTotal);
  const actualProfit = actualProfitReady || terminalTotals ? roundMoney(sale - actualCostTotal) : null;
  const actualProfitRate = (actualProfitReady || terminalTotals) && sale ? actualProfit / sale * 100 : null;

  const moneyRow = (key, label) => ({
    key,
    label,
    estimated: roundMoney(estimated[key] || 0),
    actual: actual[key],
    diff: valueDiff(actual[key], estimated[key] || 0)
  });
  const detailRows = [
    moneyRow("sale", "订单金额"),
    moneyRow("purchase", "采购成本"),
    moneyRow("domestic", "国内运费"),
    moneyRow("international", "国际运费"),
    moneyRow("packaging", "包装处理费"),
    moneyRow("commission", "Ozon佣金"),
    moneyRow("collecting", "收单费"),
    moneyRow("service", "Ozon服务费"),
    moneyRow("aftersale", "售后损失"),
    moneyRow("other", "其他费用"),
    {
      key: "costTotal",
      label: "成本合计",
      estimated: estimatedCostTotal,
      actual: actualCostTotal,
      diff: valueDiff(actualCostTotal, estimatedCostTotal),
      strong: true
    },
    {
      key: "profit",
      label: "利润",
      estimated: estimatedProfit,
      actual: actualProfit,
      diff: valueDiff(actualProfit, estimatedProfit),
      strong: true
    }
  ];
  const financeTotals = financeRows.reduce((acc, row) => {
    const key = financeCategory(row);
    const rawAmount = Number(row.amount_cny || 0);
    const amount = rawAmount < 0 ? Math.abs(rawAmount) : 0;
    acc[key] = roundMoney(Number(acc[key] || 0) + amount);
    return acc;
  }, {});
  const financeMatchStatus = actualProfitReady || terminalTotals ? "settled" : financeRows.length ? "matched" : "unmatched";
  return {
    order_id: Number(order.id),
    shop_id: Number(order.shop_id),
    posting_number: order.posting_number || "",
    order_status: order.status || "",
    outcome_type: normalizedOrder.outcome_type || "",
    sale_amount_cny: sale,
    estimated_profit_cny: estimatedProfit,
    estimated_cost_total_cny: estimatedCostTotal,
    actual_profit_cny: actualProfit,
    actual_profit_rate: actualProfitRate,
    actual_cost_total_cny: actualCostTotal,
    finance_match_status: financeMatchStatus,
    finance_rows: financeRows.length,
    actual_profit_ready: actualProfitReady || terminalTotals ? 1 : 0,
    summary: {
      saleAmount: sale,
      estimatedProfit,
      estimatedCostTotal,
      actualProfit,
      actualProfitRate,
      actualCostTotal,
      financeRows: financeRows.length,
      actualProfitReady: actualProfitReady || Boolean(terminalTotals),
      financeMatchStatus
    },
    detailRows,
    financeTotals
  };
}
