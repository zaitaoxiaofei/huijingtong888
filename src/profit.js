import { calculateCelFbsPricing } from "./celRates.js";
import { calculateProfitQuote } from "./pricingFormula.js";

export function commissionRate(price, mapping, exchangeRate = 1) {
  const ozonRate = ozonCommissionRate(mapping);
  if (ozonRate !== null) return ozonRate;
  const low = toNumber(mapping?.commission_low, 0.12);
  const high = toNumber(mapping?.commission_high, 0.17);
  const rubPrice = toNumber(price) * toNumber(exchangeRate, 1);
  return rubPrice <= 1500 ? low : high;
}

export function estimateItemProfit({ salePrice, quantity, product, mapping }) {
  const price = Number(salePrice);
  const qty = Number(quantity || 1);
  const exchangeRate = toNumber(product.exchange_rate, 11.32);
  const explicitLogisticsFreight = logisticsRuleFreight(product);
  const resolvedCommissionRate = commissionRate(price, mapping, exchangeRate);
  if (explicitLogisticsFreight !== null) {
    const purchaseCostPerUnit = roundMoney(
      toNumber(product.purchase_cost) +
      toNumber(product.domestic_shipping) / Math.max(toNumber(product.purchase_quantity, 1), 1) +
      toNumber(product.handling_fee)
    );
    const perItem = calculateProfitQuote({
      saleRmb: price,
      purchaseCost: purchaseCostPerUnit,
      freightAmount: explicitLogisticsFreight,
      commissionRate: resolvedCommissionRate,
      returnRate: toNumber(product.return_rate, 0.05),
      withdrawalRate: toNumber(product.withdrawal_fee_rate, 0.012),
      advertisingRate: toNumber(product.advertising_rate, 0)
    });
    return {
      commission: roundMoney(toNumber(perItem.commission) * qty),
      paymentFee: roundMoney(toNumber(perItem.paymentFee) * qty),
      withdrawalFee: roundMoney(toNumber(perItem.withdrawalFee) * qty),
      advertisingCost: roundMoney(toNumber(perItem.advertisingCost) * qty),
      expectedReturnLoss: roundMoney(toNumber(perItem.expectedReturnLoss) * qty),
      cost: roundMoney((purchaseCostPerUnit + explicitLogisticsFreight) * qty),
      freight: roundMoney(explicitLogisticsFreight),
      channel: String(product.logistics_rule_channel || product.shipping_method || ""),
      category: String(product.logistics_rule_name || product.logistics_rule_carrier || "manual_rule"),
      commissionRate: resolvedCommissionRate,
      commissionSource: ozonCommissionRate(mapping) !== null ? "ozon" : "fallback",
      profit: roundMoney(toNumber(perItem.profit) * qty)
    };
  }
  const quote = calculateCelFbsPricing({
    sale_rmb: price,
    listing_price_rub: price * exchangeRate,
    exchange_rate: exchangeRate,
    purchase_cost: product.purchase_cost,
    domestic_shipping: product.domestic_shipping,
    purchase_quantity: product.purchase_quantity || 1,
    package_weight_g: product.package_weight_g,
    length_cm: product.length_cm,
    width_cm: product.width_cm,
    height_cm: product.height_cm,
    return_rate: product.return_rate ?? 0.05,
    withdrawal_fee_rate: product.withdrawal_fee_rate ?? 0.012,
    advertising_rate: product.advertising_rate ?? 0
  });
  if (quote?.matched) {
    const channel = selectQuoteChannel(quote.channels, product.shipping_method);
    const purchaseCost = toNumber(quote.purchaseCost);
    const commission = roundMoney(price * resolvedCommissionRate * qty);
    const baseProfitWithoutCommission = toNumber(channel.profit) + toNumber(channel.commission);
    return {
      commission,
      paymentFee: roundMoney(toNumber(channel.paymentFee) * qty),
      withdrawalFee: roundMoney(toNumber(channel.withdrawalFee) * qty),
      advertisingCost: roundMoney(toNumber(channel.advertisingCost) * qty),
      expectedReturnLoss: roundMoney(toNumber(channel.expectedReturnLoss) * qty),
      cost: roundMoney((purchaseCost + toNumber(channel.amount)) * qty),
      freight: roundMoney(toNumber(channel.amount)),
      channel: channel.channel,
      category: quote.category,
      commissionRate: resolvedCommissionRate,
      commissionSource: ozonCommissionRate(mapping) !== null ? "ozon" : "fallback",
      profit: roundMoney((baseProfitWithoutCommission - price * resolvedCommissionRate) * qty)
    };
  }

  const purchaseCost = toNumber(product.purchase_cost);
  const domesticShipping = toNumber(product.domestic_shipping);
  const internationalShipping = toNumber(product.international_shipping);
  const handlingFee = toNumber(product.handling_fee);
  const returnRate = toNumber(product.return_rate, 0.05);
  const withdrawalFeeRate = toNumber(product.withdrawal_fee_rate, 0.012);
  const cost = (purchaseCost + domesticShipping + internationalShipping + handlingFee) * qty;
  const perItem = calculateProfitQuote({
    saleRmb: price,
    purchaseCost: purchaseCost + domesticShipping + handlingFee,
    freightAmount: internationalShipping,
    commissionRate: resolvedCommissionRate,
    returnRate,
    withdrawalRate: withdrawalFeeRate,
    advertisingRate: toNumber(product.advertising_rate, 0)
  });

  return {
    commission: roundMoney(toNumber(perItem.commission) * qty),
    paymentFee: roundMoney(toNumber(perItem.paymentFee) * qty),
    withdrawalFee: roundMoney(toNumber(perItem.withdrawalFee) * qty),
    advertisingCost: roundMoney(toNumber(perItem.advertisingCost) * qty),
    expectedReturnLoss: roundMoney(toNumber(perItem.expectedReturnLoss) * qty),
    cost: roundMoney(cost),
    commissionRate: resolvedCommissionRate,
    commissionSource: ozonCommissionRate(mapping) !== null ? "ozon" : "fallback",
    profit: roundMoney(toNumber(perItem.profit) * qty)
  };
}

function logisticsRuleFreight(product = {}) {
  if (!Number(product?.logistics_rule_id || 0)) return null;
  const base = toNumberOrNull(product?.logistics_rule_base_fee_cny);
  const perGram = toNumberOrNull(product?.logistics_rule_per_gram_cny);
  const perTicket = toNumberOrNull(product?.logistics_rule_per_ticket_cny);
  if (base === null && perGram === null && perTicket === null) return null;
  const weight = Math.max(0, toNumber(product?.package_weight_g, 0));
  return roundMoney((base || 0) + weight * (perGram || 0) + (perTicket || 0));
}

export function ozonCommissionRate(mapping) {
  const raw = mapping?.commissions_json || mapping?.ozon_commissions_json || mapping?.commission_json;
  const list = parseCommissionList(raw);
  if (!list.length) return null;
  const preferred = selectCommissionEntry(list, mapping) || list[0];
  const value = [
    preferred.percent,
    preferred.commission,
    preferred.rate,
    preferred.value
  ].map(toNumberOrNull).find((item) => item !== null && item > 0);
  if (value === undefined || value === null) return null;
  return value > 1 ? value / 100 : value;
}

function selectCommissionEntry(list, mapping) {
  const schemaHints = [
    mapping?.sale_schema,
    mapping?.schema,
    mapping?.delivery_schema,
    mapping?.stock_type,
    mapping?.shipping_method
  ].map(normalizeSchemaHint).filter(Boolean);
  for (const hint of schemaHints) {
    const exact = list.find((item) => normalizeSchemaHint(item.sale_schema || item.schema || item.delivery_schema || item.type) === hint);
    if (exact) return exact;
  }
  if (schemaHints.some((hint) => hint.includes("fbo") || hint.includes("fbp"))) {
    return list.find((item) => {
      const normalized = normalizeSchemaHint(item.sale_schema || item.schema || item.delivery_schema || item.type);
      return normalized.includes("fbo") || normalized.includes("fbp");
    });
  }
  return list.find((item) => normalizeSchemaHint(item.sale_schema || item.schema || item.delivery_schema || item.type).includes("fbs"));
}

function parseCommissionList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.commissions)) return parsed.commissions;
    return parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

function normalizeSchemaHint(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text.includes("rfbs")) return "rfbs";
  if (text.includes("fbs")) return "fbs";
  if (text.includes("fbo")) return "fbo";
  if (text.includes("fbp")) return "fbp";
  return text;
}

function toNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function selectQuoteChannel(channels = [], shippingMethod = "") {
  const preferred = {
    air: "express",
    air_land: "standard",
    land: "economy"
  }[shippingMethod] || "standard";
  return channels.find((item) => item.key === preferred) || channels.find((item) => item.key === "standard") || channels.find((item) => item.key === "economy") || channels[0] || {};
}

export function actualItemProfit(item, breakdown = null) {
  const revenue = toNumber(item.sale_price) * toNumber(item.quantity);
  const costs =
    (toNumber(item.frozen_purchase_cost) +
      toNumber(item.frozen_domestic_shipping) +
      toNumber(item.frozen_international_shipping) +
      toNumber(item.frozen_handling_fee)) *
    toNumber(item.quantity);
  const packagingCost = breakdown ? toNumber(breakdown.packaging_cost_cny) : 0;
  const advertisingCost = breakdown ? toNumber(breakdown.advertising_cost_cny) : 0;
  const otherFee = breakdown ? toNumber(breakdown.other_fee_cny) : 0;
  const platformFees = toNumber(item.platform_fee_actual || item.estimated_commission);
  return roundMoney(
    revenue
    - costs
    - packagingCost
    - platformFees
    - toNumber(item.aftersale_loss)
    - advertisingCost
    - otherFee
  );
}

export function roundMoney(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
