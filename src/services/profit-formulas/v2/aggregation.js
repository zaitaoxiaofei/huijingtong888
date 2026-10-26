// All fields in these interfaces are CNY. The caller converts original-currency
// finance amounts with the frozen signed-day snapshot before aggregation.
// Bill completeness and formula dispatch are owned by the transaction layer.
export { estimatedProfitValue, aggregateEstimatedProfit, aggregateActualProfit } from "../v1/aggregation.js";
