import { calculatePricing, calculateProfit } from './pricing-tool.js';

const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
export function wbLogisticsQuote(rule, input) {
  if (!rule) throw new Error('请选择 WB 物流渠道及揽收仓');
  const weight = Number(input.weight);
  const dimensions = ['length', 'width', 'height'].map(key => Number(input[key]));
  if (!(weight > 0) || !Number.isFinite(weight) || dimensions.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('请填写大于 0 的包裹实重和长宽高');
  const chargeableWeightG = Math.ceil(weight / 100) * 100;
  if (chargeableWeightG > rule.maxWeightG) throw new Error(`该 WB 仓库单件计费重不能超过 ${rule.maxWeightG / 1000} 公斤`);
  if (!rule.maxSideCm || !rule.maxSumCm) throw new Error('该线路缺少官方尺寸限制，暂不能自动报价');
  if (Math.max(...dimensions) > rule.maxSideCm || dimensions.reduce((a,b) => a+b,0) > rule.maxSumCm) throw new Error(`包裹超出该仓限制：单边≤${rule.maxSideCm}cm，三边和≤${rule.maxSumCm}cm`);
  const [perKg, perTicket] = chargeableWeightG <= 300 ? rule.light : rule.heavy;
  return { chargeableWeightG, perKg, perTicket, freight: round(chargeableWeightG / 1000 * perKg + perTicket) };
}
export function calculateWbQuote(mode, input, rule) {
  const shipping = wbLogisticsQuote(rule, input);
  if (input.commissionRate === null || input.commissionRate === undefined || input.commissionRate === '' || !Number.isFinite(Number(input.commissionRate))) throw new Error('请选择 WB 类目佣金或填写后台确认的中国跨境佣金');
  const form = { ...input, freight: shipping.freight };
  const result = mode === 'pricing' ? calculatePricing(form) : calculateProfit(form);
  return { ...result, ...(mode === 'pricing' ? { listCny: round(result.saleCny / (1 - Number(input.discountRate) / 100)) } : {}), shipping };
}
