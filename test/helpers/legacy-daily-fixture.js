import {readLegacyDailyFinance,planLegacyDailySettlement} from '../../src/services/legacy-daily-accrual-settlement.js';
export const order={id:1,shop_id:5,posting_number:'100-200-1',order_number:'100-200',status:'delivered'};
export const items=[{id:11,order_id:1,quantity:1,sale_price:100,frozen_purchase_cost:20,frozen_domestic_shipping:2,packaging_cost_cny:1,formula_version:'V1'}];
export function row(id,category,amount,{posting='100-200-1',rate=10,currency='RUB',income=0,operation=id}={}){
 const r={id,shop_id:5,operation_id:`accrual_by_day:${operation}`,posting_number:posting,service_type:`accrual:${category}:${String(id).padStart(20,'a')}`,service_name:category,operation_date:'2026-11-12 00:00:00',currency_code:currency,amount,accruals_for_sale:income,sale_commission:0,delivery_charge:0,return_delivery_charge:0};
 for(const key of ['amount','accruals_for_sale','sale_commission','delivery_charge','return_delivery_charge'])r[key+'_cny']=r[key]/(currency==='RUB'?rate:1);
 r.raw_json=JSON.stringify({_source_endpoint:'/v1/finance/accrual/by-day',_normalization:{reconciliation:{ok:true,total_amount:amount}},_erp_fx_archive:{id:1,rate,business_date:'2026-11-12',source_date:'2026-11-12',currency_from:'CNY',currency_to:'RUB',source:'cbr'}});return r;
}
export const classifyCategory=r=>r.service_type.split(':')[1];
export const rows=()=>[row(1,'income',1000,{income:1000}),row(2,'commission',-100),row(3,'international_transport',-150),row(4,'collecting_fee',-20,{posting:'100-200'})];
export const siblings=()=>[{shop_id:5,posting_number:'100-200-1',order_id:1,order_item_id:11,sale_price:100,quantity:1},{shop_id:5,posting_number:'100-200-2',order_id:2,order_item_id:21,sale_price:100,quantity:1}];
export async function plan(source=rows(),its=items){const finance=await readLegacyDailyFinance({order,items:its,classifyCategory,query:async sql=>sql.includes('FROM ozon_finance_items')?source:sql.includes('FROM order_profit_daily_fx')?[JSON.parse(source[0].raw_json)._erp_fx_archive]:siblings()});return planLegacyDailySettlement({order,items:its,finance,accounting:{outcome_type:'delivered_signed'},packagingFeeForSaleAmount:async()=>1});}

