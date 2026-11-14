const round=x=>Math.round((Number(x)+Number.EPSILON)*100)/100;
const pending=code=>({ok:false,code,items:[]});
const finite=x=>x!=null&&x!==''&&Number.isFinite(Number(x));
// Signed, already reconciled finance facts remain signed: a refund is a
// negative sale, and a returned commission is a negative cost, never zeroed.
export async function planReviewedDailySettlement({order,items,finance,accounting,review,now=new Date()}){
 if(!finance?.ok)return pending(finance?.code||'REVIEWED_FINANCE_PENDING');
 if(finance.income_mode!=='signed_accruals'||!finance.income_rows?.length)return pending('REVIEWED_INCOME_ANCHOR_MISSING');
 if(!review?.reference||!Array.isArray(review.order_ids)||!review.order_ids.includes(Number(order.id)))return pending('REVIEWED_ORDER_SCOPE_REQUIRED');
 if(!items.length||items.some(i=>!['V1','V5','V6'].includes(i.formula_version||'V1')))return pending('REVIEWED_FORMULA_MIXED');
 if(accounting.outcome_type!=='delivered_signed')return pending('REVIEWED_OUTCOME_PENDING');
 if(items.some(i=>!(Number(i.purchase_cost_cny)>0||Number(i.frozen_purchase_cost)>0)))return pending('REVIEWED_PURCHASE_COST_PENDING');
 if(items.some(i=>!finite(i.packaging_cost_cny)||!finite(i.advertising_cost_cny)))return pending('REVIEWED_LOCAL_COST_PENDING');
 const signed=finance.category_signed_totals_cny;
 if(!signed||!finite(finance.sale_accrual_cny)||!Object.hasOwn(signed,'commission')
  ||!['platform_delivery','international_transport'].some(k=>Object.hasOwn(signed,k)))return pending('REVIEWED_FINAL_BILL_INCOMPLETE');
 if(Object.entries(signed).some(([k,v])=>!['income','commission','platform_delivery','international_transport','collecting_fee','other','aftersale_loss'].includes(k)||!finite(v)))return pending('REVIEWED_FEE_CATEGORY_PENDING');
 const amounts=Object.fromEntries(Object.entries(signed).filter(([k])=>k!=='income').map(([k,v])=>[k,round(-Number(v))]));
 const sale=Number(finance.sale_accrual_cny),flags=[];
 const originalIncome=new Map();let incomePositive=false,incomeNegative=false;
 for(const r of finance.income_rows){const v=Number(r.accruals_for_sale);if(!Number.isFinite(v)||!['CNY','RUB'].includes(r.currency_code))return pending('REVIEWED_INCOME_CURRENCY_PENDING');originalIncome.set(r.currency_code,(originalIncome.get(r.currency_code)||0)+v);incomePositive||=v>0;incomeNegative||=v<0;}
 const fullRefund=incomePositive&&incomeNegative&&[...originalIncome.values()].every(x=>Math.abs(x)<.0001);
 const returnEvidence=(review.returns||[]).filter(r=>Number(r.shop_id)===Number(order.shop_id)&&r.posting_number===order.posting_number&&r.source_endpoint==='/v2/returns/rfbs/get'&&r.return_id&&['MoneyReturned','UtilizedByOzon','PartialCompensationReturnedByOzon','Solved'].includes(r.state));
 if(fullRefund){
  if(!returnEvidence.some(r=>['MoneyReturned','UtilizedByOzon'].includes(r.state)))return pending('REVIEWED_REFUND_EVIDENCE_PENDING');
  // A money refund does not establish that inventory was physically recovered.
  // Retain historical cost and expose uncertainty instead of inventing recovery.
  if(!items.every(i=>returnEvidence.some(r=>r.state==='UtilizedByOzon'&&String(r.sku)===String(i.ozon_sku)&&(Number(i.quantity)===1||Number(r.quantity)>=Number(i.quantity)))))flags.push('refund_inventory_pending');
 }
 let estimatedCollecting=null;
 if(!Object.hasOwn(signed,'collecting_fee')){
  const policy=review.missing_collecting;
  if(policy?.known_official_order_ids?.includes(Number(order.id)))return pending('REVIEWED_OFFICIAL_BILL_NOT_IMPORTED');
  const today=new Date(new Date(now).getTime()+8*3600000).toISOString().slice(0,10);
  if(!policy||policy.rate!==.05||!Number.isInteger(policy.min_age_days)||policy.min_age_days<30||!/^\d{4}-\d{2}-\d{2}$/.test(policy.as_of)||!Number.isFinite(Date.parse(policy.as_of))||new Date(policy.as_of).toISOString().slice(0,10)!==policy.as_of||policy.as_of>today||!policy.coverage_reference||!policy.covered_shop_ids?.includes(Number(order.shop_id))||!(sale>0)||fullRefund)return pending('REVIEWED_COLLECTING_PENDING');
  const financeDates=finance.rows.map(r=>String(r.operation_date instanceof Date?r.operation_date.toISOString():r.operation_date).slice(0,10));
  const delivered=order.delivered_at?new Date(new Date(order.delivered_at).getTime()+8*3600000).toISOString().slice(0,10):null;
  const last=[...financeDates,...(delivered?[delivered]:[])].filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)).sort().at(-1);
  if(!last)return pending('REVIEWED_COLLECTING_AGE_UNKNOWN');
  const age=Math.floor((Date.parse(policy.as_of)-Date.parse(last))/86400000);
  if(!Number.isFinite(age)||age<policy.min_age_days)return pending('REVIEWED_COLLECTING_GRACE_PENDING');
  amounts.collecting_fee=round(sale*policy.rate);estimatedCollecting={rate:policy.rate,base_cny:round(sale),amount_cny:amounts.collecting_fee,age_days:age,last_finance_day:last,as_of:policy.as_of,coverage_reference:policy.coverage_reference};flags.push('estimated_acquiring');
 }
 const weights=items.map(i=>Number(i.sale_price)*Number(i.quantity));if(weights.some(w=>!Number.isFinite(w)||w<=0))return pending('REVIEWED_ALLOCATION_PENDING');const totalWeight=weights.reduce((a,b)=>a+b,0);
 const allocate=total=>{let used=0;return weights.map((w,n)=>{const value=n===weights.length-1?round(total-used):round(total*w/totalWeight);used=round(used+value);return value;});};
 const sales=allocate(sale),commission=allocate(amounts.commission),shipping=allocate(round((amounts.platform_delivery||0)+(amounts.international_transport||0))),collecting=allocate(amounts.collecting_fee||0),service=allocate(amounts.other||0),aftersale=allocate(amounts.aftersale_loss||0);
 const quality=flags.length?flags.join('+'):'official';
 const projections=items.map((item,n)=>{
  const purchaseCost=round(Number(item.purchase_cost_cny)>0?Number(item.purchase_cost_cny):Number(item.frozen_purchase_cost)*Number(item.quantity));
  const domesticShipping=round(Number(item.domestic_shipping_cny)||Number(item.frozen_domestic_shipping||0)*Number(item.quantity));
  const packagingCost=Number(item.packaging_cost_cny),advertisingCost=Number(item.advertising_cost_cny);
  const actualProfit=round(sales[n]-purchaseCost-domesticShipping-shipping[n]-packagingCost-commission[n]-service[n]-aftersale[n]-advertisingCost-collecting[n]);
  return {item,itemSale:sales[n],purchaseCost,domesticShipping,actualInternationalShipping:shipping[n],packagingCost,advertisingCost,commissionFeeCny:commission[n],commissionRate:sales[n]?commission[n]/sales[n]:0,actualServiceFeeCny:service[n],returnLoss:aftersale[n],otherFee:collecting[n],actualProfit,grossProfit:round(actualProfit+advertisingCost),totalFinanceFeeCny:round(shipping[n]+commission[n]+service[n]+aftersale[n]+collecting[n])};
 });
 return {ok:true,code:null,formulaVersion:'V6',financeFxPolicy:'archived_operation_day_signed_cash_flows',categoryTotals:amounts,saleAmount:round(sale),allocation:finance.allocation,quality,qualityFlags:flags,fullRefund,estimatedCollecting,returnEvidence,items:projections};
}
