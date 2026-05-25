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
  const raw = String(row.service_name || row.operation_type_name || row.service_type || row.operation_type || "").trim();
  const normalized = raw.toLowerCase();
  if (normalized.includes("sale_commission") || raw === "Ozon 销售佣金") return "commission";
  if (normalized.includes("marketplaceredistributionofacquiringoperation")) return "collecting_fee";
  if (normalized.includes("return_delivery_charge") || normalized.includes("returnflowlogistic") || normalized.includes("returnnotdelivtocustomer")) return "aftersale_loss";
  if (normalized.includes("delivery_charge")) return "platform_delivery";
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
  return positiveAmount(item.purchase_cost_cny) || itemEstimatedPurchaseCost(item);
}

function itemActualDomesticShipping(item) {
  return positiveAmount(item.domestic_shipping_cny) || itemEstimatedDomesticShipping(item);
}

function itemHasFinanceActualProfit(item = {}) {
  const statusText = [item.settlement_state, item.profit_status].map((value) => String(value || "").toLowerCase()).join(" ");
  const lockReason = String(item.lock_reason || "").toLowerCase();
  return statusText.includes("accrued") && lockReason.includes("finance");
}

function hasFinanceSaleAccrual(finance = []) {
  return (finance || []).some((row) => Math.abs(Number(row.accruals_for_sale_cny || row.accruals_for_sale || 0)) > 0.005);
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
  const total = (finance || []).reduce((sum, row) => {
    if (!keys.has(financeCategory(row))) return sum;
    matched = true;
    const feeAmount = numberOrNull(row.fee_amount_cny);
    const rawAmount = Number(row.amount_cny || 0);
    const amount = feeAmount !== null ? feeAmount : rawAmount < 0 ? Math.abs(rawAmount) : 0;
    return sum + amount;
  }, 0);
  return matched ? roundMoneyValue(total) : null;
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
  if (snapshot?.summary && Array.isArray(snapshot?.rows)) {
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
      rows: snapshot.rows.map((row) => ({
        ...row,
        note: row.note || snapshotDetailNote(row.key),
        strong: Boolean(row.strong)
      })),
      fromSnapshot: true
    };
  }
  const rows = Array.isArray(items) ? items : [];
  const financeRows = Array.isArray(finance) ? finance : [];
  const hasFinalFinanceBasis = financeRows.length > 0 && (hasFinanceSaleAccrual(financeRows) || isFinalProfitOutcome(order));
  const actualProfitReady = hasFinalFinanceBasis && rows.length > 0 && rows.every((item) => itemHasFinanceActualProfit(item));
  const saleAmount = sumRows(rows, itemSaleAmount);
  const estimated = {
    sale: saleAmount,
    purchase: sumRows(rows, itemEstimatedPurchaseCost),
    domestic: sumRows(rows, itemEstimatedDomesticShipping),
    international: sumRows(rows, itemEstimatedInternationalShipping),
    packaging: sumRows(rows, (item) => positiveAmount(item.packaging_cost_cny)),
    commission: sumRows(rows, (item) => positiveAmount(item.estimated_commission) || positiveAmount(item.commission_fee_cny)),
    collecting: 0,
    service: sumRows(rows, (item) => positiveAmount(item.ozon_service_fee_cny)),
    aftersale: sumRows(rows, (item) => positiveAmount(item.aftersale_loss) || positiveAmount(item.return_loss_cny)),
    other: sumRows(rows, (item) => positiveAmount(item.advertising_cost_cny) + positiveAmount(item.other_fee_cny)),
    profit: sumRows(rows, (item) => numberOrNull(item.estimated_profit) ?? numberOrNull(item.net_profit_cny) ?? 0)
  };
  const financeInternational = financeCategoryTotal(financeRows, ["platform_delivery", "international_transport"]);
  const financeCommission = financeCategoryTotal(financeRows, "commission");
  const financeCollecting = financeCategoryTotal(financeRows, "collecting_fee");
  const financeService = financeCategoryTotal(financeRows, "other");
  const financeAftersale = financeCategoryTotal(financeRows, "aftersale_loss");
  const actual = {
    sale: saleAmount,
    purchase: sumRows(rows, itemActualPurchaseCost),
    domestic: sumRows(rows, itemActualDomesticShipping),
    international: financeInternational ?? (actualProfitReady ? 0 : null),
    packaging: sumRows(rows, (item) => positiveAmount(item.packaging_cost_cny)),
    commission: financeCommission ?? (actualProfitReady ? 0 : null),
    collecting: financeCollecting ?? (actualProfitReady ? 0 : null),
    service: financeService ?? (actualProfitReady ? 0 : null),
    aftersale: financeAftersale ?? (actualProfitReady ? 0 : null),
    other: actualProfitReady ? sumRows(rows, (item) => positiveAmount(item.advertising_cost_cny) + positiveAmount(item.other_fee_cny)) : null,
    profit: null
  };
  const estimatedCostTotal = roundMoneyValue(estimated.purchase + estimated.domestic + estimated.international + estimated.packaging + estimated.commission + estimated.collecting + estimated.service + estimated.aftersale + estimated.other);
  const actualCostTotal = actualProfitReady
    ? roundMoneyValue(actual.purchase + actual.domestic + (actual.international || 0) + actual.packaging + (actual.commission || 0) + (actual.collecting || 0) + (actual.service || 0) + (actual.aftersale || 0) + (actual.other || 0))
    : null;
  const estimatedProfit = estimated.profit || roundMoneyValue(saleAmount - estimatedCostTotal);
  const actualProfit = actualProfitReady ? roundMoneyValue(saleAmount - actualCostTotal) : null;
  const actualMargin = actualProfitReady && saleAmount ? actualProfit / saleAmount * 100 : null;

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
    actualProfitReady,
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
