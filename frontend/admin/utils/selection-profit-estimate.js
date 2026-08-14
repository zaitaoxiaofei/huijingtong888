import { estimateItemProfit, roundMoney } from "../../../src/profit.js";

function normalizedRate(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric > 1 ? numeric / 100 : numeric;
}

function productWithRule(row = {}, logisticsRule = null) {
  if (!logisticsRule) {
    return {
      ...row,
      return_rate: normalizedRate(row.return_rate, 0.05),
      advertising_rate: normalizedRate(row.advertising_rate, 0)
    };
  }
  return {
    ...row,
    logistics_rule_id: Number(logisticsRule.id || row.logistics_rule_id || 0) || null,
    logistics_rule_name: logisticsRule.name || "",
    logistics_rule_carrier: logisticsRule.carrier || "",
    logistics_rule_channel: logisticsRule.channel || row.shipping_method || "",
    logistics_rule_base_fee_cny: Number(logisticsRule.base_fee_cny || 0),
    logistics_rule_per_gram_cny: Number(logisticsRule.per_gram_cny || 0),
    logistics_rule_per_ticket_cny: Number(logisticsRule.per_ticket_cny || 0),
    return_rate: normalizedRate(row.return_rate, 0.05),
    advertising_rate: normalizedRate(row.advertising_rate, 0)
  };
}

export function estimateSelectionProfit(row = {}, logisticsRule = null, salePrice = 0) {
  const saleRmb = Math.max(0, Number(salePrice || 0));
  const quote = estimateItemProfit({
    salePrice: saleRmb,
    quantity: 1,
    product: productWithRule(row, logisticsRule),
    mapping: row
  });
  const profit = roundMoney(quote.profit);
  return {
    ...quote,
    saleRmb: roundMoney(saleRmb),
    profit,
    margin: saleRmb > 0 ? roundMoney((profit / saleRmb) * 100) : 0,
    totalCost: roundMoney(saleRmb - profit),
    freight: roundMoney(quote.freight || 0)
  };
}

export function solveSelectionSalePrice(row = {}, logisticsRule = null) {
  const mode = String(row.desired_profit_mode || "margin");
  const rawTarget = Number(row.desired_profit_value || 0);
  const target = mode === "margin" ? normalizedRate(rawTarget, 0) : rawTarget;
  const matchesTarget = (saleRmb) => {
    const quote = estimateSelectionProfit(row, logisticsRule, saleRmb);
    return mode === "profit"
      ? quote.profit >= target
      : saleRmb > 0 && quote.profit / saleRmb >= target;
  };

  let low = 0;
  let high = Math.max(
    100,
    Number(row.sale_price_rmb || row.air_sale_price_rmb || 0),
    Number(row.purchase_cost || 0) * 2
  );
  while (!matchesTarget(high) && high < 1_000_000) high *= 2;
  for (let index = 0; index < 60; index += 1) {
    const middle = (low + high) / 2;
    if (matchesTarget(middle)) high = middle;
    else low = middle;
  }
  const saleRmb = roundMoney(high);
  return {
    saleRmb,
    listingPriceRub: roundMoney(saleRmb * Number(row.exchange_rate || 11.32))
  };
}
