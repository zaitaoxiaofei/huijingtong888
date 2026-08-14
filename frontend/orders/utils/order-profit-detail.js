function numberOrNull(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function positiveAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function roundMoneyValue(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function shippingMethodLabel(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "--";
  if (text === "cel_air_land") return "CEL 陆空";
  if (text === "cel_land") return "CEL 陆运";
  if (text === "cel_large_land") return "CEL 大件陆运";
  if (text === "postal_packet") return "邮政小包";
  if (text === "hunchun_2") return "珲春 2";
  if (text === "manual_review") return "人工核验";
  if (text.includes("fbp")) return "平台仓发货";
  if (text.includes("fbs")) return "自发货";
  if (text.includes("air")) return "空运";
  if (text.includes("sea")) return "海运";
  return String(value || "").trim();
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
  if (raw === "袩械褉械胁褘褋褌邪胁谢械薪懈械 褍褋谢褍谐 写芯褋褌邪胁泻懈" || raw.includes("写芯褋褌邪胁")) return "platform_delivery";
  if (raw.includes("屑械卸写褍薪邪褉芯写") || raw.includes("褌褉邪薪褋锌芯褉褌薪芯-褝泻褋锌械写懈褑懈芯薪薪褘褏")) return "international_transport";
  if (raw.includes("效邪褋褌懈褔薪邪褟 泻芯屑锌械薪褋邪褑懈褟 锌芯泻褍锌邪褌械谢褞") || raw.includes("胁芯蟹胁褉邪褌") || raw.includes("薪械写芯胁谢芯卸")) return "aftersale_loss";
  return "other";
}

function sumRows(rows = [], getter = () => 0) {
  return roundMoneyValue(rows.reduce((sum, row) => sum + Number(getter(row) || 0), 0));
}

function itemSaleAmount(item) {
  return positiveAmount(item.sale_amount_cny) || Number(item.sale_price || 0) * Number(item.quantity || 1);
}

function orderSaleAmount(rows = [], order = {}, financeRows = []) {
  const outcome = String(order.outcome_type || "");
  if (outcome === "cancelled_pre_fulfillment") return 0;
  if (["rejected_unclaimed", "after_delivery_return"].includes(outcome)) {
    return hasFinanceSaleAccrual(financeRows) ? sumRows(rows, (item) => positiveAmount(item.sale_amount_cny)) : 0;
  }
  return sumRows(rows, itemSaleAmount);
}

function itemQuantity(item) {
  return Math.max(Number(item.quantity || 1), 1);
}

function itemEstimatedPurchaseCost(item) {
  return positiveAmount(item.frozen_purchase_cost) * itemQuantity(item) || positiveAmount(item.purchase_cost_cny);
}

function itemEstimatedDomesticShipping(item) {
  return positiveAmount(item.frozen_domestic_shipping) * itemQuantity(item) || positiveAmount(item.domestic_shipping_cny);
}

function itemEstimatedInternationalShipping(item) {
  return positiveAmount(item.frozen_international_shipping) * itemQuantity(item) || positiveAmount(item.international_shipping_cny);
}

function itemActualPurchaseCost(item) {
  return numberOrNull(item.purchase_cost_cny) ?? itemEstimatedPurchaseCost(item);
}

function itemActualDomesticShipping(item) {
  return numberOrNull(item.domestic_shipping_cny) ?? itemEstimatedDomesticShipping(item);
}

function isTerminalNoOriginalRevenue(order = {}) {
  return ["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(String(order.outcome_type || "").trim());
}

function terminalLossPolicy(order = {}) {
  const outcome = String(order.outcome_type || "").trim();
  const profile = String(order.loss_profile_code || "").trim().toLowerCase();
  if (outcome === "cancelled_pre_fulfillment") {
    return { purchase: false, domestic: false, international: false, packaging: false, commission: false, service: false, collecting: true, aftersaleFinance: false };
  }
  if (profile === "purchase_collecting") {
    return { purchase: true, domestic: false, international: true, packaging: false, commission: false, service: false, collecting: true, aftersaleFinance: true };
  }
  if (profile === "commission_purchase_collecting_international") {
    return { purchase: true, domestic: true, international: true, packaging: false, commission: true, service: false, collecting: true, aftersaleFinance: true };
  }
  if (profile === "purchase_collecting_international" || outcome === "after_delivery_return") {
    return { purchase: true, domestic: true, international: true, packaging: false, commission: false, service: false, collecting: true, aftersaleFinance: true };
  }
  if (outcome === "rejected_unclaimed") {
    return { purchase: true, domestic: false, international: true, packaging: false, commission: false, service: false, collecting: true, aftersaleFinance: true };
  }
  return { purchase: false, domestic: false, international: false, packaging: false, commission: false, service: false, collecting: false, aftersaleFinance: true };
}

function appliedOrEstimated(applied, estimated) {
  return positiveAmount(applied) || positiveAmount(estimated);
}

function terminalComponentTotals(rows = [], order = {}) {
  const policy = terminalLossPolicy(order);
  const totals = (rows || []).reduce((acc, item) => {
    const referencePurchase = itemEstimatedPurchaseCost(item);
    const referenceDomestic = itemEstimatedDomesticShipping(item);
    const referenceInternational = itemEstimatedInternationalShipping(item);
    const financeActual = itemHasFinanceActualProfit(item);
    acc.purchase += policy.purchase ? (financeActual ? numberOrNull(item.purchase_cost_cny) ?? referencePurchase : appliedOrEstimated(item.purchase_cost_cny, referencePurchase)) : 0;
    acc.domestic += policy.domestic ? (financeActual ? numberOrNull(item.domestic_shipping_cny) ?? referenceDomestic : appliedOrEstimated(item.domestic_shipping_cny, referenceDomestic)) : 0;
    acc.international += policy.international ? (financeActual ? numberOrNull(item.international_shipping_cny) ?? referenceInternational : appliedOrEstimated(item.international_shipping_cny, referenceInternational)) : 0;
    acc.packaging += policy.packaging ? positiveAmount(item.packaging_cost_cny) : 0;
    acc.commission += policy.commission
      ? (financeActual ? numberOrNull(item.commission_fee_cny) ?? positiveAmount(item.estimated_commission) : positiveAmount(item.commission_fee_cny) || positiveAmount(item.estimated_commission))
      : 0;
    acc.collecting += policy.collecting ? positiveAmount(item.other_fee_cny) : 0;
    acc.service += policy.service ? positiveAmount(item.ozon_service_fee_cny) : 0;
    acc.aftersale += policy.aftersaleFinance
      ? (financeActual ? numberOrNull(item.return_loss_cny) ?? positiveAmount(item.aftersale_loss) : positiveAmount(item.return_loss_cny) || positiveAmount(item.aftersale_loss))
      : 0;
    return acc;
  }, { purchase: 0, domestic: 0, international: 0, packaging: 0, commission: 0, collecting: 0, service: 0, aftersale: 0, other: 0 });
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, roundMoneyValue(value)]));
}

function itemHasFinanceActualProfit(item = {}) {
  const statusText = [item.settlement_state, item.profit_status].map((value) => String(value || "").toLowerCase()).join(" ");
  const lockReason = String(item.lock_reason || "").toLowerCase();
  return statusText.includes("accrued") && lockReason.includes("finance");
}

function hasFinanceSaleAccrual(finance = []) {
  return (finance || []).some((row) => Math.abs(Number(row.accruals_for_sale_cny || row.accruals_for_sale || 0)) > 0.005);
}

function hasRequiredFinanceBasis(finance = [], order = {}) {
  const outcome = String(order.outcome_type || "");
  if (["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(outcome)) return true;
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
  const signedTotal = (finance || []).reduce((sum, row) => {
    if (!keys.has(financeCategory(row))) return sum;
    matched = true;
    const rawAmount = Number(row.amount_cny || 0);
    if (Math.abs(rawAmount) > 0.000001) {
      hasSignedAmount = true;
      return sum + rawAmount;
    }
    fallbackTotal += positiveAmount(row.fee_amount_cny);
    return sum;
  }, 0);
  return matched ? roundMoneyValue(hasSignedAmount ? Math.max(0, -signedTotal) : fallbackTotal) : null;
}

function valueDiff(actual, estimated) {
  if (actual === null || actual === undefined) return null;
  return roundMoneyValue(Number(actual || 0) - Number(estimated || 0));
}

function snapshotDetailNote(key) {
  return {
    sale: "订单全部商品销售收入。",
    purchase: "本地库存商品采购成本。",
    domestic: "本地采购到仓或集货的国内运费。",
    international: "真实金额来自 Ozon 财务里的平台配送或国际运输费用；未出现前显示 --。",
    packaging: "本地包装处理费规则或已保存利润项。",
    commission: "真实金额来自 Ozon 销售佣金账单；FBP 减免以账单为准。",
    collecting: "真实值来自 Ozon 收单手续费账单。",
    service: "真实值来自非佣金、非物流、非售后类 Ozon 财务费用。",
    aftersale: "真实值来自退货、拒收、补偿等售后财务费用。",
    other: "广告费、手工调整或额外费用。",
    costTotal: "真实成本未结算完整时不汇总，避免误导。",
    profit: "订单未结算完整前不计算真实利润。"
  }[key] || "";
}

function buildDetailMetricCards(summary, formatters) {
  const { formatMoney, formatSignedMoney, formatPercent } = formatters;
  return [
    {
      label: "订单金额",
      value: formatMoney(summary.saleAmount),
      sub: "订单全部商品销售收入",
      tone: "strong"
    },
    {
      label: "利润",
      lines: [
        {
          label: "实际利润",
          value: summary.actualProfitReady ? formatMoney(summary.actualProfit) : "--"
        },
        {
          label: "预估利润",
          value: formatMoney(summary.estimatedProfit)
        }
      ],
      sub: summary.actualProfitReady ? `差异 ${formatSignedMoney(summary.profitDiff)}` : "真实利润待 Ozon 财务结算后计算",
      tone: summary.actualProfit < 0 ? "danger" : "default"
    },
    {
      label: "实际利润率",
      value: summary.actualProfitReady ? formatPercent(summary.actualMargin) : "--",
      sub: "实际利润 / 销售额",
      tone: summary.actualMargin < 0 ? "danger" : "strong"
    },
    {
      label: "财务匹配状态",
      value: summary.actualProfitReady ? "已结算" : summary.financeRows ? "已匹配" : "未匹配",
      sub: summary.financeRows
        ? `已识别 ${summary.financeRows} 类 Ozon 真实费用${summary.actualProfitReady ? "" : "，利润待结算"}`
        : "未匹配到 Ozon 真实费用",
      tone: summary.actualProfitReady || summary.financeRows ? "success" : "warning"
    }
  ];
}

const defaultFormatters = {
  formatMoney: (value) => {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
  },
  formatSignedMoney: (value) => {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) return "0.00";
    if (Math.abs(amount) < 0.005) return "0.00";
    return `${amount > 0 ? "+" : ""}${amount.toFixed(2)}`;
  },
  formatPercent: (value) => {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? `${amount.toFixed(2)}%` : "0.00%";
  }
};

export function buildOrderProfitDetail(order = {}, items = [], finance = [], snapshot = null, formatters = {}) {
  const display = { ...defaultFormatters, ...formatters };
  const snapshotRows = Array.isArray(snapshot?.detailRows)
    ? snapshot.detailRows
    : Array.isArray(snapshot?.rows)
      ? snapshot.rows
      : null;
  if (snapshot?.summary && snapshotRows) {
    const summary = {
      saleAmount: Number(snapshot.summary.saleAmount || snapshot.sale_amount_cny || 0),
      estimatedProfit: Number(snapshot.summary.estimatedProfit || snapshot.estimated_profit_cny || 0),
      actualProfit: snapshot.summary.actualProfit ?? snapshot.actual_profit_cny,
      profitDiff: snapshot.summary.actualProfit !== null && snapshot.summary.actualProfit !== undefined
        ? roundMoneyValue(Number(snapshot.summary.actualProfit || 0) - Number(snapshot.summary.estimatedProfit || 0))
        : null,
      actualMargin: snapshot.summary.actualProfitRate ?? snapshot.actual_profit_rate,
      hasActual: Number(snapshot.finance_rows || snapshot.summary.financeRows || 0) > 0,
      actualProfitReady: Boolean(snapshot.summary.actualProfitReady || snapshot.actual_profit_ready),
      financeRows: Number(snapshot.finance_rows || snapshot.summary.financeRows || 0),
      estimatedCostTotal: Number(snapshot.summary.estimatedCostTotal || snapshot.estimated_cost_total_cny || 0),
      actualCostTotal: snapshot.summary.actualCostTotal ?? snapshot.actual_cost_total_cny
    };
    return {
      summary,
      cards: buildDetailMetricCards(summary, display),
      rows: snapshotRows.map((row) => ({
        ...row,
        note: row.note || snapshotDetailNote(row.key),
        strong: Boolean(row.strong)
      })),
      fromSnapshot: true
    };
  }
  const rows = Array.isArray(items) ? items : [];
  const financeRows = Array.isArray(finance) ? finance : [];
  const terminalNoOriginalRevenue = isTerminalNoOriginalRevenue(order);
  const hasFinalFinanceBasis = financeRows.length > 0 && hasRequiredFinanceBasis(financeRows, order);
  const actualProfitReady = hasFinalFinanceBasis && rows.length > 0 && rows.every((item) => itemHasFinanceActualProfit(item));
  const terminalTotals = terminalNoOriginalRevenue ? terminalComponentTotals(rows, order) : null;
  const saleAmount = orderSaleAmount(rows, order, financeRows);
  const estimated = {
    sale: saleAmount,
    purchase: terminalTotals ? terminalTotals.purchase : sumRows(rows, itemEstimatedPurchaseCost),
    domestic: terminalTotals ? terminalTotals.domestic : sumRows(rows, itemEstimatedDomesticShipping),
    international: terminalTotals ? terminalTotals.international : sumRows(rows, itemEstimatedInternationalShipping),
    packaging: terminalTotals ? terminalTotals.packaging : sumRows(rows, (item) => positiveAmount(item.packaging_cost_cny)),
    commission: terminalTotals ? terminalTotals.commission : sumRows(rows, (item) => positiveAmount(item.estimated_commission) || positiveAmount(item.commission_fee_cny)),
    collecting: terminalTotals ? terminalTotals.collecting : 0,
    service: terminalTotals ? terminalTotals.service : sumRows(rows, (item) => positiveAmount(item.ozon_service_fee_cny)),
    aftersale: terminalTotals ? terminalTotals.aftersale : sumRows(rows, (item) => positiveAmount(item.aftersale_loss) || positiveAmount(item.return_loss_cny)),
    other: terminalTotals ? terminalTotals.other : sumRows(rows, (item) => positiveAmount(item.advertising_cost_cny) + positiveAmount(item.other_fee_cny)),
    profit: terminalTotals ? null : sumRows(rows, (item) => numberOrNull(item.estimated_profit) ?? numberOrNull(item.net_profit_cny) ?? 0)
  };
  const financeInternational = financeCategoryTotal(financeRows, ["platform_delivery", "international_transport"]);
  const financeCommission = financeCategoryTotal(financeRows, "commission");
  const financeCollecting = financeCategoryTotal(financeRows, "collecting_fee");
  const financeService = financeCategoryTotal(financeRows, "other");
  const financeAftersale = financeCategoryTotal(financeRows, "aftersale_loss");
  const actual = {
    sale: saleAmount,
    purchase: terminalTotals ? terminalTotals.purchase : sumRows(rows, itemActualPurchaseCost),
    domestic: terminalTotals ? terminalTotals.domestic : sumRows(rows, itemActualDomesticShipping),
    international: terminalTotals ? terminalTotals.international : financeInternational ?? (actualProfitReady ? 0 : null),
    packaging: terminalTotals ? terminalTotals.packaging : sumRows(rows, (item) => positiveAmount(item.packaging_cost_cny)),
    commission: terminalTotals ? terminalTotals.commission : financeCommission ?? (actualProfitReady ? 0 : null),
    collecting: terminalTotals ? terminalTotals.collecting : financeCollecting ?? (actualProfitReady ? 0 : null),
    service: terminalTotals ? terminalTotals.service : financeService ?? (actualProfitReady ? 0 : null),
    aftersale: terminalTotals ? terminalTotals.aftersale : financeAftersale ?? (actualProfitReady ? 0 : null),
    other: terminalTotals
      ? terminalTotals.other
      : actualProfitReady
        ? sumRows(rows, (item) => positiveAmount(item.advertising_cost_cny) + (financeCollecting === null ? positiveAmount(item.other_fee_cny) : 0))
        : null,
    profit: null
  };
  const estimatedCostTotal = roundMoneyValue(estimated.purchase + estimated.domestic + estimated.international + estimated.packaging + estimated.commission + estimated.collecting + estimated.service + estimated.aftersale + estimated.other);
  const actualCostTotal = actualProfitReady || terminalTotals
    ? roundMoneyValue(actual.purchase + actual.domestic + (actual.international || 0) + actual.packaging + (actual.commission || 0) + (actual.collecting || 0) + (actual.service || 0) + (actual.aftersale || 0) + (actual.other || 0))
    : null;
  const estimatedProfit = terminalTotals ? roundMoneyValue(saleAmount - estimatedCostTotal) : estimated.profit || roundMoneyValue(saleAmount - estimatedCostTotal);
  const actualProfit = actualProfitReady || terminalTotals ? roundMoneyValue(saleAmount - actualCostTotal) : null;
  const actualMargin = (actualProfitReady || terminalTotals) && saleAmount ? actualProfit / saleAmount * 100 : null;

  const moneyRow = (key, label, note) => ({
    key,
    label,
    estimated: roundMoneyValue(estimated[key] || 0),
    actual: actual[key],
    diff: valueDiff(actual[key], estimated[key] || 0),
    note
  });

  const detailRows = [
    {
      key: "shipping",
      label: "运输方式",
      estimatedText: shippingMethodLabel(rows[0]?.shipping_method || order.delivery_method || order.shipping_method),
      actualText: financeRows.length || actualProfitReady ? shippingMethodLabel(order.delivery_method || order.shipping_method || rows[0]?.shipping_method) : "--",
      diffText: "",
      note: "预计按库存商品物流模型；真实列仅展示已匹配到订单维度的财务口径。"
    },
    moneyRow("sale", "订单金额", "订单全部商品销售收入。"),
    moneyRow("purchase", "采购成本", "本地库存商品的采购成本，通常不会随 Ozon 结算变化。"),
    moneyRow("domestic", "国内运费", "本地采购到仓或集货的国内运费。"),
    moneyRow("international", "国际运费", "真实金额优先取 Ozon 财务里的平台配送或国际运输费用；未出现前不拿预估值冒充。"),
    moneyRow("packaging", "包装处理费", "本地包装处理费规则或已保存利润项。"),
    moneyRow("commission", "Ozon佣金", "真实金额来自 Ozon 销售佣金账单；FBP 减免以账单或结算后的 0 值为准。"),
    moneyRow("collecting", "收单费", "真实值来自 Ozon 收单手续费账单。"),
    moneyRow("service", "Ozon服务费", "真实值来自非佣金、非物流、非售后类 Ozon 财务费用。"),
    moneyRow("aftersale", "售后损失", "真实值来自退货、拒收、补偿等售后财务费用。"),
    moneyRow("other", "其他费用", "广告费、手工调整或额外费用。"),
    {
      key: "costTotal",
      label: "总成本",
      estimated: estimatedCostTotal,
      actual: actualCostTotal,
      diff: valueDiff(actualCostTotal, estimatedCostTotal),
      note: actualProfitReady ? "实际成本合计已按结算后的真实值汇总。" : "真实成本未结算完整时不汇总，避免误导。",
      strong: true
    },
    {
      key: "profit",
      label: "利润",
      estimated: estimatedProfit,
      actual: actualProfit,
      diff: valueDiff(actualProfit, estimatedProfit),
      note: actualProfitReady ? `实际利润率 ${display.formatPercent(actualMargin)}` : "订单未结算完整前不计算真实利润。",
      strong: true
    }
  ];

  const summary = {
    saleAmount,
    estimatedProfit,
    actualProfit,
    profitDiff: actualProfitReady ? roundMoneyValue(actualProfit - estimatedProfit) : null,
    actualMargin,
    hasActual: financeRows.length > 0 || actualProfitReady,
    actualProfitReady: actualProfitReady || Boolean(terminalTotals),
    financeRows: financeRows.length,
    estimatedCostTotal,
    actualCostTotal
  };

  return {
    summary,
    cards: buildDetailMetricCards(summary, display),
    rows: detailRows
  };
}

export function profitDetailCellClassName({ columnIndex }) {
  if (columnIndex === 2) return "orders-profit-actual-column";
  return "";
}
