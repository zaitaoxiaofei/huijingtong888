const DEFAULTS = {
  commissionRate: 0.2,
  returnRate: 0.05,
  advertisingRate: 0,
  finalMileBaseRate: 0.014,
  finalMileMiddleRate: 0.02,
  finalMileLowThreshold: 50,
  finalMileLowFee: 1,
  finalMileHighThreshold: 750,
  finalMileHighFee: 15,
  withdrawalRate: 0.012,
  withdrawalCommissionRate: 0.2
};

export function calculateFinalMileBankFee(saleRmb, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const sale = toNumber(saleRmb);
  const tierFee =
    sale < config.finalMileLowThreshold
      ? config.finalMileLowFee
      : sale >= config.finalMileHighThreshold
        ? config.finalMileHighFee
        : sale * config.finalMileMiddleRate;
  return roundMoney(sale * config.finalMileBaseRate + tierFee);
}

export function calculateWithdrawalFee({ saleRmb, freightAmount = 0, finalMileBankFee = 0, withdrawalRate = DEFAULTS.withdrawalRate, withdrawalCommissionRate = DEFAULTS.withdrawalCommissionRate }) {
  const base =
    toNumber(saleRmb) -
    toNumber(finalMileBankFee) -
    toNumber(freightAmount) -
    toNumber(saleRmb) * toNumber(withdrawalCommissionRate, DEFAULTS.withdrawalCommissionRate);
  return roundMoney(Math.max(0, base) * toNumber(withdrawalRate, DEFAULTS.withdrawalRate));
}

export function calculateProfitQuote(input = {}) {
  const saleRmb = toNumber(input.saleRmb);
  const purchaseCost = toNumber(input.purchaseCost);
  const freightAmount = toNumber(input.freightAmount);
  const commissionRate = toNumber(input.commissionRate, DEFAULTS.commissionRate);
  const returnRate = toNumber(input.returnRate, DEFAULTS.returnRate);
  const advertisingRate = toNumber(input.advertisingRate, DEFAULTS.advertisingRate);
  const withdrawalRate = toNumber(input.withdrawalRate, DEFAULTS.withdrawalRate);
  const withdrawalCommissionRate = toNumber(input.withdrawalCommissionRate, DEFAULTS.withdrawalCommissionRate);

  const commission = saleRmb * commissionRate;
  const finalMileBankFee = calculateFinalMileBankFee(saleRmb);
  const withdrawalFee = calculateWithdrawalFee({ saleRmb, freightAmount, finalMileBankFee, withdrawalRate, withdrawalCommissionRate });
  const advertisingCost = saleRmb * advertisingRate;
  const expectedReturnLoss = (purchaseCost + freightAmount) * returnRate;
  const profit =
    saleRmb -
    purchaseCost -
    freightAmount -
    commission -
    finalMileBankFee -
    withdrawalFee -
    advertisingCost -
    expectedReturnLoss;
  const margin = saleRmb ? profit / saleRmb : 0;

  return {
    commission: roundMoney(commission),
    paymentFee: roundMoney(finalMileBankFee),
    finalMileBankFee: roundMoney(finalMileBankFee),
    withdrawalFee: roundMoney(withdrawalFee),
    advertisingCost: roundMoney(advertisingCost),
    expectedReturnLoss: roundMoney(expectedReturnLoss),
    profit: roundMoney(profit),
    margin: roundMoney(margin * 100)
  };
}

export function roundMoney(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
