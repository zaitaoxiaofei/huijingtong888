import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readApprovedH1,withApprovedH1,approvedH1BaselineMatches,approvedH1Report,approvedH1ProjectionRanges} from '../src/services/billing-approved-h1.js';
import {billingDrilldown} from '../src/services/billing-drilldown.js';
import {billingProjectionDeltas} from '../src/services/billing-ledger-projection.js';
const costFields=['purchase_cost_cny','domestic_shipping_cny','international_shipping_cny','packaging_cost_cny','ozon_service_fee_cny','other_fee_cny','advertising_cost_cny','return_loss_cny'];
function fixture(){
 const raw={item_id:7,sale_amount_cny:'20.0000',commission_fee_cny:'2.0000',net_profit_cny:'8.0000',costs:Object.fromEntries(costFields.map(k=>[k,k==='purchase_cost_cny'?'10.0000':'0.0000'])),profit_status:'estimated',settlement_state:'pending'};
 const item={order_item_id:7,ozon_sku:'sku',quantity:1,sale_price:20,item_revenue:20,billing_revenue:20,sales_revenue:20,compensation_income:0,commission_fee:2,purchase_cost:10,adjustment_baseline:raw,costs:{purchase_cost:10,commission_fee:2}};
 const order={id:2,shop_id:4,month_key:'2026-04',posting_number:'p',revenue:20,billing_revenue:20,sales_revenue:20,items:[item],costs:{commission_fee:2},deltas:{revenue:0,commission_fee:0}};
 const j={id:1,tenant_id:1,company_id:1,shop_id:4,month_key:'2026-04',posting_number:'p',sku:'sku',before_json:{baseline:{item_ids:[7],revenue:20,commission:2,profit:8,other_costs:10},baseline_fingerprint:crypto.createHash('sha256').update(JSON.stringify([raw])).digest('hex')},after_json:{policy:'official-cny-zero-payment-h1-v1',currency:'CNY',net_revenue:19,commission_fee:1,net_profit_cny:8,other_costs_cny:10,payment_basis:{status:'verified_zero',amount_cny:0}},sources_json:[{document_id:1,sha256:'sha'}]};
 return {order,j};
}
test('applies approved item amounts once, preserves originals and other cost projection',()=>{
 const {order,j}=fixture(),before=JSON.stringify(order),result=withApprovedH1([order],[j,j])[0];
 assert.equal(result.billing_revenue,19);assert.equal(result.costs.commission_fee,1);assert.equal(result.items[0].costs.purchase_cost,10);assert.equal(result.items[0].approved_adjustments.length,1);assert.equal(JSON.stringify(order),before);
 const delta=[...billingProjectionDeltas([result]).values()][0];assert.equal(delta.revenue,-1);assert.equal(delta.commission_fee,-1);
 const detail=billingDrilldown([result],{field:'revenue'}).rows[0];assert.equal(detail.amount,19);assert.equal(detail.approved_adjustments[0].before.revenue,20);assert.equal(detail.approved_adjustments[0].after.payment_basis.amount_cny,0);
});
test('Q3, other shops/tenants/companies and unapproved policies remain unchanged',()=>{
 for(const change of [{tenant_id:2},{company_id:2},{shop_id:7},{month_key:'2026-07'},{after_json:{...fixture().j.after_json,policy:'unapproved'}}]){
  const {order,j}=fixture();assert.deepEqual(withApprovedH1([order],[{...j,...change}]),[order]);
 }
 const {order,j}=fixture();const third={...order,month_key:'2026-07'};assert.deepEqual(withApprovedH1([third],[j]),[third]);
});
test('changed baseline and unavailable/changed source cannot apply',()=>{
 const {order,j}=fixture();order.items[0].adjustment_baseline.net_profit_cny='9.0000';assert.equal(approvedH1BaselineMatches(j,order.items),false);
 let result=withApprovedH1([order],[j])[0];assert.equal(result.billing_revenue,20);assert.equal(result.approved_adjustments[0].status,'stale');
 const fresh=fixture();result=withApprovedH1([fresh.order],[{...fresh.j,source_valid:false}])[0];assert.equal(result.billing_revenue,20);assert.equal(result.items[0].approved_adjustments[0].status,'stale');
});
test('multi-SKU shipment only changes approved item and keeps compensation income',()=>{
 const {order,j}=fixture();order.items[0].compensation_income=3;order.items[0].billing_revenue=23;order.items.push({...order.items[0],order_item_id:8,ozon_sku:'other',item_revenue:10,billing_revenue:10,compensation_income:0,costs:{commission_fee:1}});order.billing_revenue=33;order.sales_revenue=30;order.costs.commission_fee=3;
 const result=withApprovedH1([order],[j])[0];assert.equal(result.billing_revenue,32);assert.equal(result.items[0].billing_revenue,22);assert.equal(result.items[1].billing_revenue,10);assert.equal(result.costs.commission_fee,2);
});
test('report reader scopes tenant/company/month and source identity before exposing originals',async()=>{
 const {j}=fixture();let calls=0;const query=async(sql,args)=>{calls++;if(sql.includes('FROM finance_import_documents')){assert.equal(args[0],1);return [{id:1,shop_key:4,sha256:'sha',original_name:'official.json',attachment_url:'/uploads/team-attachments/official.json'}];}assert.match(sql,/j.tenant_id=\?/);assert.match(sql,/EXISTS/);assert.deepEqual(args,[1,'2026-01','2026-06',4]);return [j];};
 const scope={tenantId:1,companyId:1,from:'2026-01',to:'2026-12',shopId:4};const records=await readApprovedH1(query,scope);assert.equal(records[0].source_valid,true);assert.match(records[0].sources_json,/official.json/);
 for(const change of [{tenantId:2},{companyId:2},{from:'2026-07'},{to:'2025-12'}])assert.deepEqual(await readApprovedH1(query,{...scope,...change}),[]);assert.equal(calls,2);
 const invalid=await readApprovedH1(async sql=>sql.includes('FROM finance_import_documents')?[{id:1,shop_key:5,sha256:'sha',attachment_url:'/uploads/team-attachments/foreign.json'}]:[j],scope);assert.equal(invalid[0].source_valid,false);assert.doesNotMatch(invalid[0].sources_json,/foreign/);
});
test('ledger page rechecks current originals and returns visible before/after values',async()=>{
 const {order,j}=fixture(),raw=order.items[0].adjustment_baseline;
 const query=async sql=>sql.includes('FROM finance_import_documents')?[{id:1,shop_key:4,sha256:'sha'}]:sql.includes('FROM order_items oi')?[{order_item_id:7,shop_id:4,posting_number:'p',ordered_month:'2026-04',ozon_sku:'sku',saved_sale:raw.sale_amount_cny,saved_commission:raw.commission_fee_cny,saved_profit:raw.net_profit_cny,saved_status:raw.profit_status,saved_settlement:raw.settlement_state,...Object.fromEntries(costFields.map(k=>['saved_'+k,raw.costs[k]]))}]:[j];
 const result=await approvedH1Report(query,{tenantId:1,companyId:1,from:'2026-01',to:'2026-06'},{keyword:'sku'});assert.equal(result.summary.applied,1);assert.equal(result.summary.revenue_delta,-1);assert.equal(result.rows[0].before.revenue,20);assert.equal(result.rows[0].after.net_revenue,19);
});

test('later approved entry supersedes earlier amount, and applying projection twice is idempotent',()=>{const {order,j}=fixture(),later={...j,id:2,after_json:{...j.after_json,net_revenue:18,net_profit_cny:7}};const first=withApprovedH1([order],[j,later])[0];assert.equal(first.billing_revenue,18);assert.equal(first.items[0].approved_adjustments.length,1);assert.equal(first.items[0].approved_adjustments[0].id,2);assert.equal(withApprovedH1([first],[j,later])[0].deltas.revenue,-2);});

test('ledger totals do not double count superseded adjustment history',async()=>{const {order,j}=fixture(),raw=order.items[0].adjustment_baseline,later={...j,id:2,after_json:{...j.after_json,net_revenue:18,net_profit_cny:7}};const query=async sql=>sql.includes('FROM finance_import_documents')?[{id:1,shop_key:4,sha256:'sha'}]:sql.includes('FROM order_items oi')?[{order_item_id:7,shop_id:4,posting_number:'p',ordered_month:'2026-04',ozon_sku:'sku',saved_sale:raw.sale_amount_cny,saved_commission:raw.commission_fee_cny,saved_profit:raw.net_profit_cny,saved_status:raw.profit_status,saved_settlement:raw.settlement_state,...Object.fromEntries(costFields.map(k=>['saved_'+k,raw.costs[k]]))}]:[j,later];const result=await approvedH1Report(query,{tenantId:1,companyId:1,from:'2026-01',to:'2026-06'});assert.equal(result.summary.count,2);assert.equal(result.summary.applied,1);assert.equal(result.summary.superseded,1);assert.equal(result.summary.revenue_delta,-2);assert.equal(result.rows[0].status,'superseded');});

test('annual selection splits H1 from unchanged later quarters and preserves other enterprises',()=>{assert.deepEqual(approvedH1ProjectionRanges({tenantId:1,companyId:1,from:'2026-01-01',to:'2026-12-31'}),[{from:'2026-01-01',to:'2026-06-30',approvedH1:true},{from:'2026-07-01',to:'2026-12-31',approvedH1:false}]);for(const tenantId of [1,2]){const result=approvedH1ProjectionRanges({tenantId,companyId:1,from:'2026-07-01',to:'2026-09-30'});assert.deepEqual(result,[{from:'2026-07-01',to:'2026-09-30',approvedH1:false}]);}assert.equal(approvedH1ProjectionRanges({tenantId:2,from:'2026-01-01',to:'2026-06-30'})[0].approvedH1,false);});
