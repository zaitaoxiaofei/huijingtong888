import { calculateProfitQuote } from "./pricingFormula.js";

const RMB_PER_RUB_DEFAULT = 1 / 11.32;

const OZON_RFBS_RULES = [
  {
    category: "Extra Small",
    label: "超级轻小件",
    minRub: 1,
    maxRub: 1500,
    minKg: 0.001,
    maxKg: 0.5,
    maxSumCm: 90,
    maxSideCm: 60,
    chargeByVolume: false,
    channels: {
      express: { name: "CEL Express Extra Small", cnName: "陆空特快", days: "5-10天", perGram: 0.0468, perTicket: 3.12 },
      standard: { name: "CEL Standard Extra Small", cnName: "陆空标准", days: "10-15天", perGram: 0.0364, perTicket: 3.12 },
      economy: { name: "CEL Economy Extra Small", cnName: "陆运经济", days: "15-25天", perGram: 0.026, perTicket: 3.12 }
    }
  },
  {
    category: "Budget",
    label: "低客单价标准件",
    minRub: 1,
    maxRub: 1500,
    minKg: 0.501,
    maxKg: 30,
    maxSumCm: 150,
    maxSideCm: 60,
    chargeByVolume: false,
    channels: {
      express: { name: "CEL Express Budget", cnName: "陆空特快", days: "5-10天", perGram: 0.03432, perTicket: 23.92 },
      standard: { name: "CEL Standard Budget", cnName: "陆空标准", days: "10-15天", perGram: 0.026, perTicket: 23.92 },
      economy: { name: "CEL Economy Budget", cnName: "陆运经济", days: "15-25天", perGram: 0.01768, perTicket: 23.92 }
    }
  },
  {
    category: "Small",
    label: "小件",
    minRub: 1501,
    maxRub: 7000,
    minKg: 0.001,
    maxKg: 2,
    maxSumCm: 150,
    maxSideCm: 60,
    chargeByVolume: false,
    channels: {
      express: { name: "CEL Express Small", cnName: "陆空特快", days: "5-10天", perGram: 0.0468, perTicket: 16.64 },
      standard: { name: "CEL Standard Small", cnName: "陆空标准", days: "10-15天", perGram: 0.0364, perTicket: 16.64 },
      economy: { name: "CEL Economy Small", cnName: "陆运经济", days: "15-25天", perGram: 0.026, perTicket: 16.64 }
    }
  },
  {
    category: "Big",
    label: "大件",
    minRub: 1501,
    maxRub: 7000,
    minKg: 2.001,
    maxKg: 30,
    volumetricDivisor: 12000,
    maxVolumetricKg: 31,
    maxSumCm: 310,
    maxSideCm: 150,
    chargeByVolume: true,
    channels: {
      standard: { name: "CEL Standard Big", cnName: "陆空标准", days: "10-15天", perGram: 0.026, perTicket: 37.44 },
      economy: { name: "CEL Economy Big", cnName: "陆运经济", days: "15-25天", perGram: 0.01768, perTicket: 37.44 }
    }
  },
  {
    category: "Premium Small",
    label: "高客单价小件",
    minRub: 7001,
    maxRub: 250000,
    minKg: 0.001,
    maxKg: 5,
    maxSumCm: 250,
    maxSideCm: 150,
    chargeByVolume: false,
    channels: {
      express: { name: "CEL Express Premium Small", cnName: "陆空特快", days: "5-10天", perGram: 0.0468, perTicket: 22.88 },
      standard: { name: "CEL Standard Premium Small", cnName: "陆空标准", days: "10-15天", perGram: 0.0364, perTicket: 22.88 },
      economy: { name: "CEL Economy Premium Small", cnName: "陆运经济", days: "15-25天", perGram: 0.026, perTicket: 22.88 }
    }
  },
  {
    category: "Premium Big",
    label: "高客单价大件",
    minRub: 7001,
    maxRub: 250000,
    minKg: 5.001,
    maxKg: 30,
    maxVolumetricKg: 80,
    maxSumCm: 310,
    maxSideCm: 150,
    chargeByVolume: true,
    volumetricDivisor: 6000,
    hundredGramCeil: true,
    channels: {
      standard: { name: "CEL Standard Premium Big", cnName: "陆空标准", days: "10-15天", perGram: 0.02912, perTicket: 64.48 },
      economy: { name: "CEL Economy Premium Big", cnName: "陆运经济", days: "15-25天", perGram: 0.02392, perTicket: 64.48 }
    }
  },
  {
    category: "HK",
    label: "中国香港渠道",
    minRub: 1,
    maxRub: 500000,
    minKg: 0.001,
    maxKg: 25,
    maxSumCm: 310,
    maxSideCm: 150,
    chargeByVolume: true,
    channels: {
      express: { name: "CEL Express HK", cnName: "香港空运", days: "7-12天", perGram: 0.096, perTicket: 19 }
    }
  }
];

export function calculateSelectionPricing(product) {
  const listingPriceRub = Number(product.listing_price_rub || product.target_price || 0);
  const weightKg = Number(product.package_weight_g || 0) / 1000;
  const length = Number(product.length_cm || 0);
  const width = Number(product.width_cm || 0);
  const height = Number(product.height_cm || 0);
  const exchangeRate = Number(product.exchange_rate || 11.32);
  const saleRmb = Number(product.air_sale_price_rmb || 0) || listingPriceRub * (exchangeRate ? 1 / exchangeRate : RMB_PER_RUB_DEFAULT);
  const purchaseCost = purchaseCostPerUnit(product);
  const rule = matchRule({ listingPriceRub, weightKg, length, width, height });
  const airChannel = rule?.channels.standard || rule?.channels.express || null;
  const landChannel = rule?.channels.economy || null;
  const airFreight = airChannel ? freight(rule, airChannel, { weightKg, length, width, height }) : null;
  const landFreight = landChannel ? freight(rule, landChannel, { weightKg, length, width, height }) : null;

  const returnRate = Number(product.return_rate || 0.05);
  const withdrawalFeeRate = Number(product.withdrawal_fee_rate || 0.012);
  const advertisingRate = Number(product.advertising_rate || 0);

  const common = {
    listingPriceRub,
    saleRmb,
    listingPriceForFees: saleRmb,
    purchaseCost,
    exchangeRate,
    commissionRate: getCommissionRate(listingPriceRub),
    returnRate,
    withdrawalFeeRate,
    withdrawalCommissionRate: Number(product.withdrawal_commission_rate || 0.2),
    advertisingRate
  };

  // 目标净利润率（desired_profit_mode=margin 时才反推）
  const targetMargin = (() => {
    const mode = product.desired_profit_mode || "margin";
    if (mode === "margin") {
      const val = Number(product.desired_profit_value || product.target_margin || 20);
      return val > 1 ? val / 100 : val; // 支持 20 和 0.2 两种写法
    }
    return null;
  })();

  // 反推建议上架价（RUB）
  // saleRmb = (cost + freight) * (1 + returnRate) / (1 - commission - payment - withdrawal - targetMargin)
  // suggestedRub = saleRmb * exchangeRate
  function suggestRub(freightRmb) {
    if (targetMargin === null || freightRmb === null || exchangeRate <= 0) return null;
    const totalCost = purchaseCost + freightRmb;
    // 先用低佣金档试算
    for (const commRate of [0.12, 0.17]) {
      const denom = 1 - commRate - withdrawalFeeRate - advertisingRate - targetMargin;
      if (denom <= 0) return null; // 目标利润率设置过高无解
      const rub = roundMoney((totalCost * (1 + returnRate) / denom) * exchangeRate);
      // 验证佣金档是否与反推结果匹配
      const correctCommRate = rub <= 1500 ? 0.12 : 0.17;
      if (correctCommRate === commRate) return rub;
      // 否则继续循环用下一档
    }
    return null;
  }

  const suggestedRub_air = airFreight ? suggestRub(airFreight.amount) : null;
  const suggestedRub_land = landFreight ? suggestRub(landFreight.amount) : null;

  return {
    category: rule?.category || "未匹配",
    categoryLabel: rule?.label || "尺寸、重量或售价未匹配",
    chargeableWeightKg: rule ? chargeableWeight(rule, { weightKg, length, width, height }) : 0,
    volumetricWeightKg: volumetricWeight(length, width, height),
    air: airFreight ? profitQuote(common, airFreight) : null,
    land: landFreight ? profitQuote(common, landFreight) : null,
    suggestedRub_air,
    suggestedRub_land,
    suggestedRub_air_x2: suggestedRub_air ? roundMoney(suggestedRub_air * 2) : null,
    suggestedRub_land_x2: suggestedRub_land ? roundMoney(suggestedRub_land * 2) : null,
    targetMarginPct: targetMargin !== null ? roundMoney(targetMargin * 100) : null
  };
}

export function calculateCelFbsPricing(input) {
  const exchangeRate = Number(input.exchange_rate || 11.32);
  const saleRmb = Number(input.sale_rmb || input.air_sale_price_rmb || 0);
  const listingPriceRub = Number(input.listing_price_rub || 0) || (exchangeRate ? saleRmb * exchangeRate : 0);
  const weightKg = Number(input.weight_kg || 0) || Number(input.package_weight_g || 0) / 1000;
  const length = Number(input.length_cm || 0);
  const width = Number(input.width_cm || 0);
  const height = Number(input.height_cm || 0);
  const purchaseCost = purchaseCostPerUnit({
    purchase_cost: input.purchase_cost,
    domestic_shipping: input.domestic_shipping,
    handling_fee: 0,
    purchase_quantity: input.purchase_quantity || 1
  });
  const returnRate = Number(input.return_rate ?? 0.05);
  const withdrawalFeeRate = Number(input.withdrawal_fee_rate ?? 0.012);
  const advertisingRate = Number(input.advertising_rate ?? 0);
  const rule = matchRule({ listingPriceRub, weightKg, length, width, height });

  if (!rule) {
    return {
      matched: false,
      message: "当前售价、重量或尺寸不符合 CEL Ozon-rFBS 发运规则",
      listingPriceRub: roundMoney(listingPriceRub),
      saleRmb: roundMoney(saleRmb),
      weightKg,
      length,
      width,
      height,
      sumCm: roundMoney(length + width + height),
      longestCm: Math.max(length, width, height),
      volumetricWeightKg: roundMoney(volumetricWeight(length, width, height, 12000))
    };
  }

  const common = {
    listingPriceRub,
    saleRmb,
    listingPriceForFees: saleRmb,
    purchaseCost,
    exchangeRate,
    commissionRate: getCommissionRate(listingPriceRub),
    returnRate,
    withdrawalFeeRate,
    withdrawalCommissionRate: Number(input.withdrawal_commission_rate ?? 0.2),
    advertisingRate
  };

  const channels = Object.entries(rule.channels).map(([key, channel]) => {
    const freightInfo = freight(rule, channel, { weightKg, length, width, height });
    return { key, ...profitQuote(common, freightInfo) };
  });

  return {
    matched: true,
    category: rule.category,
    categoryLabel: rule.label,
    listingPriceRub: roundMoney(listingPriceRub),
    saleRmb: roundMoney(saleRmb),
    exchangeRate,
    purchaseCost,
    commissionRate: common.commissionRate,
    weightKg,
    length,
    width,
    height,
    sumCm: roundMoney(length + width + height),
    longestCm: Math.max(length, width, height),
    volumetricWeightKg: roundMoney(volumetricWeight(length, width, height, rule.volumetricDivisor || 12000)),
    chargeableWeightKg: chargeableWeight(rule, { weightKg, length, width, height }),
    channels
  };
}

function matchRule({ listingPriceRub, weightKg, length, width, height }) {
  const sum = length + width + height;
  const maxSide = Math.max(length, width, height);
  const volumeKg = volumetricWeight(length, width, height);
  return OZON_RFBS_RULES.find((rule) => {
    const charged = chargeableWeight(rule, { weightKg, length, width, height });
    if (listingPriceRub < rule.minRub || listingPriceRub > rule.maxRub) return false;
    if (weightKg < rule.minKg || weightKg > rule.maxKg) return false;
    if (charged > rule.maxKg) return false;
    if (rule.maxVolumetricKg && volumeKg > rule.maxVolumetricKg) return false;
    if (sum > rule.maxSumCm || maxSide > rule.maxSideCm) return false;
    return true;
  });
}

function freight(rule, channel, size) {
  const chargedKg = chargeableWeight(rule, size);
  const billedGrams = rule.hundredGramCeil ? Math.ceil((chargedKg * 1000) / 100) * 100 : chargedKg * 1000;
  const amount = billedGrams * channel.perGram + channel.perTicket;
  return {
    channel: channel.cnName,
    channelName: channel.name,
    days: channel.days,
    amount: roundMoney(amount)
  };
}

function profitQuote(input, freightInfo) {
  return {
    ...freightInfo,
    ...calculateProfitQuote({
      saleRmb: input.saleRmb,
      purchaseCost: input.purchaseCost,
      freightAmount: freightInfo.amount,
      commissionRate: input.commissionRate,
      returnRate: input.returnRate,
      withdrawalRate: input.withdrawalFeeRate,
      withdrawalCommissionRate: input.withdrawalCommissionRate,
      advertisingRate: input.advertisingRate
    })
  };
}

function getCommissionRate(listingPriceRub) {
  return Number(listingPriceRub || 0) <= 1500 ? 0.12 : 0.17;
}

function purchaseCostPerUnit(product) {
  const quantity = Math.max(Number(product.purchase_quantity || product.purchase_qty || 1), 1);
  return roundMoney(
    Number(product.purchase_cost || 0) +
      Number(product.domestic_shipping || 0) / quantity +
      Number(product.handling_fee || 0)
  );
}

function chargeableWeight(rule, { weightKg, length, width, height }) {
  if (!rule.chargeByVolume) return Math.max(weightKg, 0);
  if (rule.category === "HK" && Number(length) + Number(width) + Number(height) <= 60) return Math.max(weightKg, 0);
  return Math.max(weightKg, volumetricWeight(length, width, height, rule.volumetricDivisor || 12000));
}

function volumetricWeight(length, width, height, divisor = 12000) {
  return roundMoney((Number(length) * Number(width) * Number(height)) / divisor);
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
