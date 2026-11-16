import {CURRENT_BILLING_REPORT} from './billing-report-versions.js';
// Reporting projection only. Published historical order formulas stay frozen.
export const BILLING_COST_FIELDS = ['purchase_cost','domestic_shipping_cost','international_shipping_cost','packaging_cost','commission_fee','ozon_service_fee','advertising_cost','other_fee','aftersale_fee'];
export const BILLING_ORDER_EXPENSE_CATEGORIES = ['domestic_shipping','packaging','order_payment'];
const cents=value=>Math.round(Number(value||0)*100);
export function billingProfitTotals(summary={},expenses=null) {
 const revenue=cents(summary.revenue),orderCosts=BILLING_COST_FIELDS.reduce((n,key)=>n+cents(summary[key]),0);
 const manual=expenses?expenses.reduce((n,row)=>n+cents(row.amount_cny),0):cents(summary.manual_expense)+cents(summary.salary_expense);
 const orderExtras=expenses?expenses.filter(row=>BILLING_ORDER_EXPENSE_CATEGORIES.includes(row.category)).reduce((n,row)=>n+cents(row.amount_cny),0):cents(summary.order_expense);
 const paymentCorrections=expenses?expenses.filter(row=>row.category==='order_payment').reduce((n,row)=>n+cents(row.amount_cny),0):cents(summary.payment_corrections);
 const platformCosts=['commission_fee','international_shipping_cost','ozon_service_fee','other_fee','advertising_cost','aftersale_fee'].reduce((n,key)=>n+cents(summary[key]),paymentCorrections);
 const withdrawalBase=Math.max(0,revenue-platformCosts),estimatedWithdrawal=Math.round(withdrawalBase*.012);
 const actualRows=expenses?.filter(row=>row.category==='withdrawal')||[];
 const actualWithdrawal=actualRows.reduce((n,row)=>n+cents(row.amount_cny),0);
 const withdrawal=actualRows.length?actualWithdrawal:estimatedWithdrawal;
 const scoped=summary.withdrawal_calculated===true;
 const effectiveWithdrawal=scoped?cents(summary.withdrawal_fee):withdrawal;
 const autoToDeduct=scoped?cents(summary.withdrawal_auto_to_deduct):(actualRows.length?0:withdrawal);
 const aiUnknown=Boolean(summary.ai_cost_applied&&summary.ai_usage_cost==null);
 const incomePending=Number(summary.income_pending_count)>0;
 const estimate=aiUnknown?null:(revenue-orderCosts-manual-autoToDeduct-(summary.ai_cost_applied?cents(summary.ai_usage_cost):0))/100;
 const net=incomePending?null:estimate;
 return {billing_formula_version:summary.ai_cost_applied?CURRENT_BILLING_REPORT.aiFormula:CURRENT_BILLING_REPORT.formula,order_profit:(revenue-orderCosts-orderExtras)/100,estimated_net_profit:incomePending?estimate:null,net_profit:net,net_profit_margin:net==null?null:revenue?net/(revenue/100):0,
  withdrawal_calculated:scoped,withdrawal_auto_to_deduct:autoToDeduct/100,withdrawal_base:scoped?Number(summary.withdrawal_base):withdrawalBase/100,withdrawal_rate:.012,withdrawal_fee:effectiveWithdrawal/100,withdrawal_estimate:scoped?Number(summary.withdrawal_estimate):estimatedWithdrawal/100,withdrawal_source:scoped?summary.withdrawal_source:actualRows.length?'recorded':'estimated'};
}

export const fixedAiExpenseTotal=rows=>rows.filter(r=>['ai_subscription','ai_tokens'].includes(r.category)).reduce((n,r)=>n+cents(r.amount_cny),0)/100;

// Keep unverified income separate from confirmed profit; never replace missing AI with zero.
export function billingNetProfitDisplay(summary={}) {
 const provisional=summary.net_profit==null&&Number(summary.income_pending_count)>0&&summary.estimated_net_profit!=null;
 return {value:provisional?summary.estimated_net_profit:summary.net_profit,provisional,pending_count:Number(summary.income_pending_count||0)};
}

export function billingMonthStatus(summary={},month,today) {
 if(month>today.slice(0,7))return 'not_started';
 if(month===today.slice(0,7))return 'in_progress';
 if(Number(summary.income_pending_count)>0||Number(summary.reconciliation_pending_count)>0||Number(summary.pending_order_count)>0||summary.net_profit==null)return 'pending';
 return 'completed';
}
