import { wbLogisticsQuote } from '../../admin/utils/wb-pricing.js';
import { saleFees } from '../../admin/utils/pricing-tool.js';

const amount = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const sum = values => values.every(value => value != null) ? round(values.reduce((total, value) => total + value, 0)) : null;
export const WB_ORDER_ESTIMATE_MODEL_VERSION = 'wb-order-estimate-v2';

export function estimateWbOrderProfit(input, rule) {
  const missingInputs = [];
  const inputErrors = [];
  const required = (field, label, max = Infinity, min = 0) => {
    const value = amount(input[field]);
    if (value == null || value < min || value > max) {
      missingInputs.push({ field, label });
      return null;
    }
    return value;
  };
  const optional = (field, label, max = 100) => {
    if (input[field] == null || input[field] === '') return 0;
    const value = amount(input[field]);
    if (value == null || value < 0 || value > max) {
      inputErrors.push({ field, label });
      return null;
    }
    return value;
  };
  const sale = required('sale', '订单销售额');
  const cost = required('purchaseCost', '采购成本');
  const domestic = required('domesticCost', '国内运费及贴单');
  const rate = required('commissionRate', 'WB 中国跨境佣金费率', 100);
  for (const [field, label] of [['weight', '包裹实重'], ['length', '包裹长度'], ['width', '包裹宽度'], ['height', '包裹高度']]) {
    required(field, label, Infinity, Number.MIN_VALUE);
  }
  if (!rule) missingInputs.push({ field: 'warehouseId', label: 'WB 揽收仓' });
  const commission = sale != null && rate != null ? round(sale * rate / 100) : null;
  let shipping = null;
  let shippingError = '';
  if (rule) {
    try { shipping = wbLogisticsQuote(rule, input); }
    catch (error) { shippingError = error.message; }
  }
  const delivery = shipping?.freight ?? null;
  const fees = sale == null ? null : saleFees(sale, delivery ?? 0);
  const percentageFee = value => sale == null || value == null ? null : round(sale * value / 100);
  const ad = percentageFee(optional('adRate', '广告费率'));
  const other = percentageFee(optional('otherRate', '其他费率'));
  const paymentRate = optional('paymentRate', '支付手续费率');
  const paymentConfigured = input.paymentRate != null && input.paymentRate !== '' && paymentRate != null;
  const payment = percentageFee(paymentRate);
  const autoReturnLoss = sum([cost, domestic, delivery, commission, fees?.lastMile]);
  const returnLossOverridden = input.returnLoss != null && input.returnLoss !== '';
  const singleReturnLoss = returnLossOverridden ? optional('returnLoss', '单次退货损失', Infinity) : autoReturnLoss;
  const returnRate = optional('returnRate', '退货率');
  const returnLoss = returnRate === 0 ? 0 : returnRate == null || singleReturnLoss == null ? null : round(returnRate * singleReturnLoss / 100);
  const components = [cost, domestic, commission, delivery, fees?.lastMile, delivery == null ? null : fees?.withdrawalFee, payment, ad, other, returnLoss];
  const total = sale != null && !inputErrors.length && !missingInputs.length ? sum(components) : null;
  return { sale, cost, domestic, commission, delivery, lastMile: fees?.lastMile ?? null,
    withdrawal: delivery == null ? null : fees?.withdrawalFee ?? null, payment, paymentConfigured,
    ad, other, returnLoss, singleReturnLoss, autoReturnLoss, returnLossOverridden, total,
    profit: total == null ? null : round(sale - total), shipping, shippingError,
    missingInputs, inputErrors, provisional: !paymentConfigured,
    modelVersion: WB_ORDER_ESTIMATE_MODEL_VERSION };
}
