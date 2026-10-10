import { calculateWithdrawalFee } from "../../../src/pricingFormula.js";

const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const finalMileRate = 0.025;

function saleFees(saleCny, freight) {
  const lastMile = round(saleCny * finalMileRate);
  const withdrawalFee = calculateWithdrawalFee({ saleRmb: saleCny, freightAmount: freight, finalMileBankFee: lastMile });
  return { lastMile, withdrawalFee };
}

export function calculatePricing(input) {
  const number = (key) => Number(input[key]);
  const required = ["purchaseCost", "weight", "length", "width", "height", "commissionRate", "freight", "exchangeRate"];
  if (required.some((key) => !Number.isFinite(number(key)) || number(key) <= 0)) {
    throw new Error("请填写大于 0 的采购成本、包裹重量与尺寸、类目佣金、跨境物流费和汇率");
  }
  const optional = ["domesticCost", "adRate", "otherRate", "targetMargin", "discountRate", "returnRate", "returnLoss"];
  if (optional.some((key) => !Number.isFinite(number(key)) || number(key) < 0)) {
    throw new Error("其他费用和比例不能为负数");
  }
  const rate = (key) => number(key) / 100;
  if (rate("returnRate") > 1) {
    throw new Error("退货率不能超过 100%");
  }
  const totalRate = rate("commissionRate") + rate("adRate") + rate("otherRate") + rate("targetMargin");
  if (totalRate >= 1 || rate("discountRate") >= 1) {
    throw new Error("佣金、广告、其他费率与目标利润率之和必须低于 100%，折扣须低于 100%");
  }
  const expectedReturnLoss = number("returnLoss") * rate("returnRate");
  const fixedCost = number("purchaseCost") + number("freight") + number("domesticCost") + expectedReturnLoss;
  const netAfterCosts = (sale) => {
    const fees = saleFees(sale, number("freight"));
    return sale * (1 - totalRate) - fixedCost - fees.lastMile - fees.withdrawalFee;
  };
  let low = 0;
  let high = Math.max(1, fixedCost / Math.max(0.01, 1 - totalRate));
  while (netAfterCosts(high) < 0 && high < 1e9) high *= 2;
  if (netAfterCosts(high) < 0) throw new Error("当前费率无法达到目标净利率");
  for (let index = 0; index < 50; index += 1) {
    const middle = (low + high) / 2;
    if (netAfterCosts(middle) >= 0) high = middle;
    else low = middle;
  }
  const saleCny = Math.ceil(high * 100) / 100;
  const { lastMile, withdrawalFee } = saleFees(saleCny, number("freight"));
  const saleRub = round(saleCny * number("exchangeRate"));
  const listRub = round(saleRub / (1 - rate("discountRate")));
  const commission = round(saleCny * rate("commissionRate"));
  const advertising = round(saleCny * rate("adRate"));
  const other = round(saleCny * rate("otherRate"));
  const profit = round(saleCny - fixedCost - commission - advertising - other - lastMile - withdrawalFee);
  return {
    saleCny, saleRub, listRub, commission, advertising, other, lastMile, withdrawalFee, profit,
    expectedReturnLoss: round(expectedReturnLoss),
    margin: round(profit / saleCny * 100),
    volumeLiters: round(number("length") * number("width") * number("height") / 1000),
    fixedCost
  };
}

export function calculateProfit(input) {
  const number = (key) => Number(input[key]);
  const required = ["saleCny", "purchaseCost", "weight", "length", "width", "height", "freight", "exchangeRate"];
  if (required.some((key) => !Number.isFinite(number(key)) || number(key) <= 0)) {
    throw new Error("请填写大于 0 的售价、采购成本、包裹重量与尺寸、跨境物流费和汇率");
  }
  const optional = ["commissionRate", "domesticCost", "adRate", "otherRate", "returnRate", "returnLoss"];
  if (optional.some((key) => !Number.isFinite(number(key)) || number(key) < 0)) {
    throw new Error("费率与费用不能为负数");
  }
  if (["commissionRate", "adRate", "otherRate", "returnRate"].some((key) => number(key) > 100)) {
    throw new Error("费率不能超过 100%");
  }
  const saleCny = number("saleCny");
  const commission = round(saleCny * number("commissionRate") / 100);
  const advertising = round(saleCny * number("adRate") / 100);
  const other = round(saleCny * number("otherRate") / 100);
  const expectedReturnLoss = round(number("returnRate") * number("returnLoss") / 100);
  const { lastMile, withdrawalFee } = saleFees(saleCny, number("freight"));
  const profit = round(saleCny - number("purchaseCost") - number("freight") - number("domesticCost") - lastMile - withdrawalFee - commission - advertising - other - expectedReturnLoss);
  return {
    saleRub: round(saleCny * number("exchangeRate")),
    commission, advertising, other, lastMile, withdrawalFee, expectedReturnLoss, profit,
    margin: round(profit / saleCny * 100),
    volumeLiters: round(number("length") * number("width") * number("height") / 1000)
  };
}
