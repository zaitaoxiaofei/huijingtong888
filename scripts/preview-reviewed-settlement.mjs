import fs from 'node:fs';
import {planReviewedDailySettlement} from '../src/services/profit-formulas/v6/settlement.js';
const option=n=>process.argv.find(x=>x.startsWith(n+'='))?.slice(n.length+1);
const inputs=JSON.parse(fs.readFileSync(option('--inputs'))),returns=JSON.parse(fs.readFileSync(option('--returns')));
const asOf=option('--as-of');if(!asOf)throw Error('Explicit review date required');
const ledgerScope=JSON.parse(fs.readFileSync(option('--ledger-scope')));
const review={reference:'chat:2026-11-14:confirmed costs, official returns and 5-percent fallback',order_ids:inputs.orders.map(x=>Number(x.order.id)),
 missing_collecting:{rate:.05,min_age_days:30,as_of:asOf,covered_shop_ids:[4,5,6,7,10],known_official_order_ids:ledgerScope.order_ids,coverage_reference:'official by-day 2026-08-14 through 2026-11-14, 465 shop-days'},
 returns:returns.rows.filter(x=>x.ok).map(x=>({shop_id:x.shop_id,posting_number:x.posting_number,return_id:x.return_id,sku:String(x.product_reference?.sku),state:x.state?.state,reason:x.reason?.name,source_endpoint:'/v2/returns/rfbs/get'}))};
const rows=[];for(const input of inputs.orders){const p=await planReviewedDailySettlement({...input,review});rows.push({order_id:input.order.id,shop_name:input.order.shop_name,posting_number:input.order.posting_number,ok:p.ok,code:p.code,formula_version:p.formulaVersion,quality:p.quality,full_refund:p.fullRefund,estimated_collecting:p.estimatedCollecting,actual_profit_cny:p.ok?Math.round(p.items.reduce((n,i)=>n+i.actualProfit,0)*100)/100:null,items:p.ok?p.items.map(i=>({id:i.item.id,sku:i.item.ozon_sku,sale:i.itemSale,purchase:i.purchaseCost,domestic:i.domesticShipping,shipping:i.actualInternationalShipping,packaging:i.packagingCost,commission:i.commissionFeeCny,collecting:i.otherFee,service:i.actualServiceFeeCny,aftersale:i.returnLoss,advertising:i.advertisingCost,profit:i.actualProfit})):[]});}
const summary={selected:rows.length,ready:rows.filter(x=>x.ok).length,quality:rows.filter(x=>x.ok).reduce((r,x)=>(r[x.quality]=(r[x.quality]||0)+1,r),{}),blocked:rows.filter(x=>!x.ok).reduce((r,x)=>(r[x.code]=(r[x.code]||0)+1,r),{}),boundary_validation:inputs.boundary_validation};
fs.writeFileSync(option('--output'),JSON.stringify({as_of:asOf,read_only:true,review,summary,rows},null,2));console.log(JSON.stringify(summary));
