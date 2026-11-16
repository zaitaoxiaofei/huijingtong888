// Reporting version only: historical order calculation versions remain unchanged.
export const BILLING_COST_FIELDS = ['purchase_cost','domestic_shipping_cost','international_shipping_cost','packaging_cost','commission_fee','ozon_service_fee','advertising_cost','other_fee'];
export const BILLING_ORDER_EXPENSE_CATEGORIES = ['domestic_shipping','packaging','order_payment'];
const cents=value=>Math.round(Number(value||0)*100);
export function billingProfitTotals(summary={},expenses=null) {
  const revenue=cents(summary.revenue),orderCosts=BILLING_COST_FIELDS.reduce((n,key)=>n+cents(summary[key]),0);
  const manual=expenses?expenses.reduce((n,row)=>n+cents(row.amount_cny),0):cents(summary.manual_expense)+cents(summary.salary_expense);
  const orderExtras=expenses?expenses.filter(row=>BILLING_ORDER_EXPENSE_CATEGORIES.includes(row.category)).reduce((n,row)=>n+cents(row.amount_cny),0):cents(summary.order_expense);
  const orderProfit=(revenue-orderCosts-orderExtras)/100,net=summary.ai_cost_applied&&summary.ai_usage_cost==null?null:(revenue-orderCosts-manual-(summary.ai_cost_applied?cents(summary.ai_usage_cost):0))/100;
  return {billing_formula_version:summary.ai_cost_applied?'revenue-less-recorded-costs-ai-v2':'revenue-less-recorded-costs-v1',order_profit:orderProfit,net_profit:net,net_profit_margin:net==null?null:revenue?net/(revenue/100):0};
}

export const fixedAiExpenseTotal=rows=>rows.filter(r=>['ai_subscription','ai_tokens'].includes(r.category)).reduce((n,r)=>n+cents(r.amount_cny),0)/100;
