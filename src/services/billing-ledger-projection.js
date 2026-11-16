import {officialReturnReportRow} from './ozon-return-report.js';
import {readLegacyDailyFinance} from './legacy-daily-accrual-settlement.js';
import {calculateFinalMileBankFee} from './profit-formulas/v1/pricingFormula.js';
import {CURRENT_BILLING_REPORT,BILLING_REPORT_VERSIONS} from '../shared/billing-report-versions.js';
const round=n=>Math.round((Number(n||0)+Number.EPSILON)*100)/100;
export const BILLING_PROJECTION_VERSION=CURRENT_BILLING_REPORT.projection;
export const billingCostKeys=['purchase_cost','domestic_shipping_cost','international_shipping_cost','packaging_cost','commission_fee','ozon_service_fee','advertising_cost','other_fee','aftersale_fee'];
const terminal=new Set(['rejected_unclaimed','after_delivery_return','cancelled_pre_fulfillment','cargo_lost']);
const parse=x=>{try{return typeof x==='string'?JSON.parse(x):x||{};}catch{return {};}};
export function billingAllocationSale(row){
 if(!['V2','V4'].includes(row.formula_version))return Number(row.sale_price);
 const prices=parse(row.frozen_prices),price=Array.isArray(prices)?prices.find(p=>String(p.ozon_sku)===String(row.ozon_sku)):null;
 if(!price||!Number.isFinite(Number(price.amount)))return null;
 if(price.currency==='CNY')return Number(price.amount);
 if(price.currency==='RUB'&&Number(row.frozen_order_rate)>0)return Number(price.amount)/Number(row.frozen_order_rate);
 return null;
}
export function splitLegacyPayment(row){
 if(row.profit_status==='accrued'||['V5','V6'].includes(row.formula_version))return {amount:0,source:'not_estimated'};
 const field=terminal.has(row.outcome_type)?'other_fee':'ozon_service_fee',mixed=Number(row[field]||0),estimate=parse(row.estimate_inputs).estimate;
 if(!(mixed>0))return {amount:0,source:'none'};
 if(estimate&&estimate.withdrawalFee!=null&&estimate.paymentFee!=null&&Number.isFinite(Number(estimate.withdrawalFee))&&Number.isFinite(Number(estimate.paymentFee))&&Math.abs(mixed-Number(estimate.withdrawalFee)-Number(estimate.paymentFee))<.011)return {amount:round(estimate.withdrawalFee),field,source:'frozen_estimate'};
 // V1's immutable bank-fee schedule and frozen order price prove the retained
 // payment component; never consult today's inventory pricing/settings.
 if((!row.formula_version||row.formula_version==='V1')&&Number(row.sale_price)>0&&Number(row.quantity)>0){
  const payment=round(calculateFinalMileBankFee(Number(row.sale_price))*Number(row.quantity));
  if(mixed>=payment)return {amount:round(mixed-payment),field,source:'frozen_v1_payment_residual'};
 }
 return {amount:0,source:'unresolved',field};
}
export function projectBillingOrder(order,items,finance=null,version=BILLING_PROJECTION_VERSION){
 const policy=Object.values(BILLING_REPORT_VERSIONS).find(p=>p.projection===version);if(!policy)throw Error('Unknown billing report version');
 const compensationRows=policy.disposedReturns&&finance?.ok?(finance.rows||[]).filter(r=>r.service_name==='ItemCompensation'):[];
 const compensationIncome=round(compensationRows.reduce((n,r)=>n+Number(r.amount_cny),0));
 const rows=items.map(item=>{
  const costs=Object.fromEntries(billingCostKeys.map(k=>[k,Number(item[k]||0)])),split=splitLegacyPayment(item);
  if(split.field)costs[split.field]=round(costs[split.field]-split.amount);
  if(split.field==='ozon_service_fee'&&split.source!=='unresolved'){costs.other_fee=round(costs.other_fee+costs.ozon_service_fee);costs.ozon_service_fee=0;}
  const {estimate_inputs,frozen_prices,frozen_order_rate,...identity}=item;
  return {...identity,allocation_sale:billingAllocationSale(item),costs,legacy_withdrawal_removed:split.amount,withdrawal_split_source:split.source,fee_evidence:[]};
 });
 const totals=()=>Object.fromEntries(billingCostKeys.map(k=>[k,round(rows.reduce((n,r)=>n+r.costs[k],0))]));
 let status=!terminal.has(order.outcome_type)&&items.every(r=>r.profit_status==='accrued')?'recorded':'estimated',reason=finance?.code||(status==='recorded'?'SAVED_ACCRUAL':'OFFICIAL_BILL_PENDING');
 if(finance?.ok&&finance.rows?.length){
  const categoryFields={commission:'commission_fee',collecting_fee:'other_fee',other:'ozon_service_fee',aftersale_loss:'aftersale_fee'};
  const signed={};for(const r of finance.rows){const category=compensationRows.includes(r)?'compensation':r.billing_category;signed[category]=(signed[category]||0)+Number(r.amount_cny);}
  const replacements={};for(const [category,field] of Object.entries(categoryFields))if(Object.hasOwn(signed,category))replacements[field]=-signed[category];
  const hasDelivery=Object.hasOwn(signed,'platform_delivery'),hasInternational=Object.hasOwn(signed,'international_transport');
  if(hasDelivery&&hasInternational)replacements.international_shipping_cost=-signed.platform_delivery-signed.international_transport;
  else if(hasDelivery||hasInternational){
   // The stored shipping field combines two components. A partial official
   // component cannot erase the unknown other half of a frozen estimate.
   const known=-Number(signed.platform_delivery||0)-Number(signed.international_transport||0),saved=rows.reduce((n,r)=>n+r.costs.international_shipping_cost,0);
   replacements.international_shipping_cost=Math.max(saved,known);
  }
  const weights=rows.map(r=>r.allocation_sale===null?0:Math.max(0,Number(r.allocation_sale??r.sale_price)*Number(r.quantity))),weight=weights.reduce((a,b)=>a+b,0);
  if(weight>0&&!rows.some(r=>r.allocation_sale===null)){for(const [field,value] of Object.entries(replacements)){let allocated=0;rows.forEach((r,i)=>{const amount=i===rows.length-1?round(value-allocated):round(value*weights[i]/weight);allocated=round(allocated+amount);r.costs[field]=amount;});}
   const evidence=finance.rows.map(r=>({id:r.id,operation_id:r.operation_id,posting_number:r.posting_number,service_name:r.service_name,service_type:r.service_type,operation_date:r.operation_date,currency_code:r.currency_code,amount:Number(r.amount),amount_cny:Number(r.amount_cny),category:compensationRows.includes(r)?'compensation':r.billing_category,parent_allocation_share:r.parent_allocation_share??null,source_endpoint:String(r.operation_id).startsWith('accrual_by_day:')?'/v1/finance/accrual/by-day':'legacy_finance_ledger'}));
   for(const row of rows)row.fee_evidence=evidence;
   const complete=['income','commission','collecting_fee'].every(k=>Object.hasOwn(signed,k))&&hasDelivery&&hasInternational;
   status=complete?'official':'partial';reason=complete?'OFFICIAL_COMPONENTS_PRESENT':'MISSING_OFFICIAL_COMPONENTS';
  }else reason='ALLOCATION_WEIGHT_PENDING';
 }
 if(rows.some(r=>r.withdrawal_split_source==='unresolved')){status='partial';reason='LEGACY_PAYMENT_SPLIT_PENDING';}
 const original=Object.fromEntries(billingCostKeys.map(k=>[k,round(items.reduce((n,r)=>n+Number(r[k]||0),0))]));
 const costs=totals();const officialIncome=terminal.has(order.outcome_type)&&finance?.ok&&finance.income_rows?.length;
 const originalRevenue=Number(order.revenue||0),legacyRevenue=officialIncome?round(finance.sale_accrual_cny):originalRevenue;
 // Only known disposed SKU quantities are removed. Other items and unknown
 // quantities retain their pending status; no order-profit ledger is rewritten.
 const disposedItems=policy.disposedReturns?rows.filter(r=>r.disposed_return&&!r.return_quantity_unknown):[];
 const removedRevenue=round(disposedItems.reduce((n,r)=>n+Number(r.item_revenue||0)*Math.min(1,Number(r.return_quantity)/Number(r.quantity)),0));
 const retainedRevenue=round(Math.max(0,originalRevenue-removedRevenue));
 const salesRevenue=disposedItems.length?(officialIncome?Math.max(0,Math.min(retainedRevenue,legacyRevenue)):retainedRevenue):legacyRevenue;
 const incomePending=Boolean(order.official_return_flag&&retainedRevenue>0&&!officialIncome&&(!disposedItems.length||rows.some(r=>r.official_return_flag&&!r.disposed_return)||rows.some(r=>r.disposed_return&&r.return_quantity_unknown)));
 const billingRevenue=round(salesRevenue+compensationIncome);
 const retainedWeights=rows.map(r=>Math.max(0,Number(r.item_revenue??Number(r.sale_price)*Number(r.quantity)))*(disposedItems.includes(r)?1-Math.min(1,Number(r.return_quantity)/Number(r.quantity)):1));
 const allocate=(total,weights,field)=>{const sum=weights.reduce((n,v)=>n+v,0);let used=0;rows.forEach((r,i)=>{const value=i===rows.length-1?round(total-used):round(total*(sum?weights[i]/sum:1/rows.length));used=round(used+value);r[field]=value;});};
 allocate(salesRevenue,retainedWeights,'sales_revenue');allocate(compensationIncome,rows.map(r=>Math.max(0,Number(r.allocation_sale??r.sale_price)*Number(r.quantity))),'compensation_income');
 for(const row of rows)row.billing_revenue=round(row.sales_revenue+row.compensation_income);
 return {...order,income_pending_count:incomePending?1:0,billing_projection_version:version,disposed_return_count:disposedItems.length?1:0,disposed_revenue_removed:removedRevenue,compensation_income:compensationIncome,sales_revenue:salesRevenue,billing_revenue:billingRevenue,items:rows,costs,original_costs:original,deltas:{...Object.fromEntries(billingCostKeys.map(k=>[k,round(costs[k]-original[k])])),revenue:round(billingRevenue-Number(order.revenue||0))},reconciliation_status:status,reconciliation_reason:reason,legacy_withdrawal_removed:round(rows.reduce((n,r)=>n+r.legacy_withdrawal_removed,0)),fee_evidence:rows[0]?.fee_evidence||[]};
}
export function billingReturnItem(item){
 const inputRecords=item.aftersale?.observations||[],seen=new Map();let quantityConflict=false;
 for(const record of inputRecords){const key=String(record.return_id)+':'+String(record.product?.sku??'unknown'),previous=seen.get(key);if(previous&&previous.product?.quantity!==record.product?.quantity)quantityConflict=true;if(!previous||String(record.observed_at||'')>String(previous.observed_at||''))seen.set(key,record);}
 const records=[...seen.values()];
 const matched=records.filter(r=>r.product?.sku==null||String(r.product.sku)===String(item.ozon_sku));
 const completeSkuEvidence=records.length>0&&records.every(r=>r.product?.sku!=null);
 const report=officialReturnReportRow({...item,aftersale:item.aftersale?{...item.aftersale,observations:records}:undefined},{outcome_type:item.outcome_type});
 const official=report.official_return_record&&report.outcome_type==='after_delivery_return';
 const legacy=['rejected_unclaimed','after_delivery_return'].includes(item.outcome_type);
 const isReturn=official||(legacy&&(!completeSkuEvidence||matched.length>0));
 return {...item,billing_return:isReturn,return_quantity:isReturn?(official?report.quantity:Number(item.quantity)):0,return_quantity_unknown:Boolean(isReturn&&official&&(report.return_quantity_unknown||quantityConflict)),official_return_flag:Boolean(official),disposed_return:Boolean(official&&['disposing','disposed'].includes(report.aftersale?.goods)),outcome_type:official?'after_delivery_return':item.outcome_type};
}
export async function readBillingProjection({query,itemRows,classifyCategory}){
 const orders=new Map();for(const source of itemRows){const item=billingReturnItem(source);const id=Number(item.order_id);if(!orders.has(id))orders.set(id,{id,shop_id:item.shop_id,shop_name:item.shop_name,posting_number:item.posting_number,order_number:item.order_number,ordered_at:item.ordered_at,month_key:item.month_key,outcome_type:item.outcome_type,items:[]});orders.get(id).items.push(item);if(item.billing_return)orders.get(id).outcome_type=item.outcome_type;orders.get(id).official_return_flag||=item.official_return_flag;}
 const result=[];
 for(const order of orders.values()){
  let finance=null;
  if(terminal.has(order.outcome_type)||order.items.some(r=>r.profit_status==='accrued'&&Number(r.saved_aftersale_fee)!==0)){
   finance=await readLegacyDailyFinance({query,order,items:order.items,classifyCategory});
   if(finance.ok)finance={...finance,rows:finance.rows.map(r=>({...r,billing_category:classifyCategory(r)}))};
  }
  order.revenue=round(order.items.reduce((n,r)=>n+Number(r.item_revenue||0),0));
  const {items,...identity}=order;result.push(projectBillingOrder(identity,items,finance));
 }
 return result;
}
export function billingProjectionDeltas(orders){
 const grouped=new Map();for(const order of orders){const key=`${order.month_key}:${order.shop_id}`,value=grouped.get(key)||{month_key:order.month_key,shop_id:Number(order.shop_id),reconciliation_pending_count:0,income_pending_count:0,legacy_withdrawal_removed:0};
  for(const field of [...billingCostKeys,'revenue'])value[field]=round(Number(value[field]||0)+order.deltas[field]);value.legacy_withdrawal_removed=round(value.legacy_withdrawal_removed+order.legacy_withdrawal_removed);value.income_pending_count+=Number(order.income_pending_count||0);
  for(const field of ['compensation_income','disposed_revenue_removed','disposed_return_count'])value[field]=round(Number(value[field]||0)+Number(order[field]||0));
  if(terminal.has(order.outcome_type)&&order.reconciliation_status!=='official')value.reconciliation_pending_count++;
  grouped.set(key,value);
 }return grouped;
}
