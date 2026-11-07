import { estimatedProfitValue as previous } from '../v1/aggregation.js';
import { classifyOrderOutcome } from './order-outcome.js';
export { aggregateEstimatedProfit, aggregateActualProfit } from '../v1/aggregation.js';

export function estimatedProfitValue(input) {
  const outcome = classifyOrderOutcome(input.order || input.item || {});
  if (['cancelled_pre_fulfillment', 'cargo_lost'].includes(outcome)) return -Number(input.returnLossEstimate || 0);
  return previous(input);
}
