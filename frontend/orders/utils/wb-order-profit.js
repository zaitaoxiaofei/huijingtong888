import { wbLogisticsQuote } from '../../admin/utils/wb-pricing.js';
import { saleFees } from '../../admin/utils/pricing-tool.js';

const amount = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function estimateWbOrderProfit(input, rule) {
  const sale = amount(input.sale);
  const cost = amount(input.purchaseCost);
  const domestic = amount(input.domesticCost);
  const rate = amount(input.commissionRate);
  const commission = sale != null && rate != null ? round(sale * rate / 100) : null;
  let shipping = null;
  let shippingError = '';
  if (rule) {
    try { shipping = wbLogisticsQuote(rule, input); }
    catch (error) { shippingError = error.message; }
  }
  const delivery = shipping?.freight ?? null;
  const fees = sale == null ? null : saleFees(sale, delivery ?? 0);
  const ad = sale == null ? null : round(sale * (amount(input.adRate) || 0) / 100);
  const other = sale == null ? null : round(sale * (amount(input.otherRate) || 0) / 100);
  const returnLoss = round((amount(input.returnRate) || 0) * (amount(input.returnLoss) || 0) / 100);
  const components = [cost, domestic, commission, delivery, fees?.lastMile, delivery == null ? null : fees?.withdrawalFee, ad, other, returnLoss];
  const total = sale != null && components.every(value => value != null) ? components.reduce((sum, value) => sum + value, 0) : null;
  return { sale, cost, domestic, commission, delivery, lastMile: fees?.lastMile ?? null,
    withdrawal: delivery == null ? null : fees?.withdrawalFee ?? null, ad, other, returnLoss, total: total == null ? null : round(total),
    profit: total == null ? null : round(sale - total), shipping, shippingError };
}
