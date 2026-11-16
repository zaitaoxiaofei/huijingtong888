import {billingProfitTotals} from './billing-profit.js';
const round=x=>Math.round((Number(x||0)+Number.EPSILON)*100)/100;
// Actual monthly fees replace only their owned company bucket. One company's
// manual entry must never suppress estimates for another company's shops.
export function scopedBillingWithdrawal(rows,expenses,assignments=[],companyId=0){
 const buckets=new Map();
 for(const row of rows){
  const month=row.month_key,from=month+'-01',last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate(),to=month+'-'+last;
  const company=Number(companyId)||Number(assignments.find(a=>Number(a.shop_id)===Number(row.shop_id)&&a.effective_from<=from&&(!a.effective_to||a.effective_to>=to))?.company_id)||0;
  const key=month+':'+(company?'company:'+company:'shop:'+row.shop_id),bucket=buckets.get(key)||{month,company,shop_id:row.shop_id,summary:{},shops:new Set()};
  for(const field of ['revenue','commission_fee','international_shipping_cost','ozon_service_fee','other_fee','advertising_cost','aftersale_fee'])bucket.summary[field]=round(Number(bucket.summary[field]||0)+Number(row[field]||0));
  bucket.shops.add(Number(row.shop_id));buckets.set(key,bucket);
 }
 for(const e of expenses.filter(e=>e.category==='withdrawal')){const month=String(e.expense_date||e.month_key||'').slice(0,7),company=Number(e.company_id);if(month&&company){const key=month+':company:'+company;if(!buckets.has(key))buckets.set(key,{month,company,summary:{},shops:new Set()});}}
 let base=0,estimate=0,fee=0,auto=0,recorded=false;
 for(const bucket of buckets.values()){
  const records=expenses.filter(e=>(String(e.expense_date||e.month_key||'').slice(0,7)===bucket.month||!e.expense_date&&!e.month_key)&&
   (bucket.company?Number(e.company_id)===bucket.company:bucket.shops.has(Number(e.shop_id))));
  const calculated=billingProfitTotals(bucket.summary,records.filter(e=>e.category==='order_payment'||e.category==='withdrawal'));
  base=round(base+calculated.withdrawal_base);estimate=round(estimate+calculated.withdrawal_estimate);fee=round(fee+calculated.withdrawal_fee);
  if(calculated.withdrawal_source==='recorded')recorded=true;else auto=round(auto+calculated.withdrawal_fee);
 }
 return {withdrawal_calculated:true,withdrawal_base:base,withdrawal_estimate:estimate,withdrawal_fee:fee,withdrawal_auto_to_deduct:auto,withdrawal_source:recorded?'recorded_or_mixed':'estimated',withdrawal_rate:.012};
}
