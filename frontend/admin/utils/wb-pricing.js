import { calculatePricing, calculateProfit } from './pricing-tool.js';
import { wbLogisticsQuote } from '../../../src/shared/wb-logistics-quote.js';

export { wbLogisticsQuote };

const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
export function calculateWbQuote(mode, input, rule) {
  const shipping = wbLogisticsQuote(rule, input);
  if (input.commissionRate === null || input.commissionRate === undefined || input.commissionRate === '' || !Number.isFinite(Number(input.commissionRate))) throw new Error('请选择 WB 类目佣金或填写后台确认的中国跨境佣金');
  const form = { ...input, freight: shipping.freight };
  const result = mode === 'pricing' ? calculatePricing(form) : calculateProfit(form);
  return { ...result, ...(mode === 'pricing' ? { listCny: round(result.saleCny / (1 - Number(input.discountRate) / 100)) } : {}), shipping };
}
