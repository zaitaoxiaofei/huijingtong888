import test from'node:test';import assert from'node:assert/strict';
import{buildCompanyPurchaseCosts,summarizePurchaseCostLines,readCompanyPurchaseCosts}from'../src/services/company-purchase-costs.js';import{financeMatrix}from'../src/shared/company-finance-report.js';
const period={from:'2026-01',to:'2026-12'};
const row=(over={})=>({posting_number:'123-456-1',sku:'9',row_number:1,sold:100,returned:0,partner:0,partner_returned:0,bonus:0,bonus_returned:0,sold_quantity:1,returned_quantity:0,standard_fee:10,standard_fee_returned:0,...over});
const doc=(month='2026-05',rows=[row()],over={})=>({id:1,shop_key:7,month_key:month,original_name:'official.json',attachment_url:'/uploads/team-attachments/order.json',parse_status:'preview',payload_json:{kind:'order-sales',facts:[],order_rows:rows},...over});
const item=(over={})=>({shop_id:7,posting_number:'123-456-1',ozon_sku:'9',order_id:100,item_id:20,quantity:1,purchase_cost_cny:12,frozen_purchase_cost:10,ordered_month:'2026-01',...over});
const build=(documents,items=[item()],extra={})=>buildCompanyPurchaseCosts({documents,items,period,...extra});
test('sales report month uses stored item cost, not order date, stock purchasing or current product price',()=>{
 const r=build([doc()]);assert.equal(r.complete,true);assert.equal(r.known_amount_cny,12);assert.equal(r.lines[0].month,'2026-05');assert.equal(r.lines[0].cost_origins[0].source,'order_profit_items.purchase_cost_cny');assert.deepEqual(r.lines[0].item_ids,[20]);
 const frozen=build([doc()],[item({purchase_cost_cny:null,quantity:2,frozen_purchase_cost:10})]);assert.equal(frozen.known_amount_cny,10);
 const missing=build([doc()],[item({purchase_cost_cny:null,frozen_purchase_cost:null,current_purchase_price:999})]);assert.equal(missing.complete,false);assert.equal(missing.lines[0].amount,null);assert.equal(missing.issues[0].code,'missing-historical-cost');
});
test('overlapping originals deduplicate; conflicting amounts and excess cross-month quantities stay unknown',()=>{
 const d=doc(),duplicate={...doc(),id:2};assert.equal(build([d,duplicate]).known_amount_cny,12);assert.equal(build([d,duplicate]).lines.length,1);assert.equal(build([d,duplicate]).lines[0].linked_evidence.length,2);
 assert.equal(build([d,doc('2026-05',[row({sold:101})],{id:3})]).issues[0].code,'conflicting-order-report');
 const excess=build([d,doc('2026-06',[row()],{id:4})]);assert.equal(excess.complete,false);assert.equal(excess.lines.every(l=>l.amount==null),true);
});
test('refunds retain original goods costs until physical restock is proven and do not deduct them twice',()=>{
 const r=build([doc('2026-05',[row({returned:100,returned_quantity:1})]),doc('2026-06',[row({sold:0,sold_quantity:0,returned:100,returned_quantity:1})],{id:2})]);
 assert.equal(r.known_amount_cny,12);assert.deepEqual(r.lines.map(l=>l.amount),[12,0]);assert.equal(r.lines[1].inventory_reversal,'not_assumed');
});
test('partial quantities allocate historical cents consistently across report windows',()=>{
 const ds=[doc('2026-01'),doc('2026-02',[row()],{id:2}),doc('2026-03',[row()],{id:3})],items=[item({quantity:3,purchase_cost_cny:1})];
 const all=build(ds,items);assert.deepEqual(all.lines.map(l=>l.amount),[.33,.34,.33]);
 const feb=build(ds,items,{period:{from:'2026-02',to:'2026-02'}});assert.equal(feb.known_amount_cny,.34);
});
test('missing report, unmatched and ambiguous SKU matches and mismatched monthly controls remain explicit',()=>{
 const monthly={...doc(),payload_json:{kind:'sales',facts:[{metric:'已确认商品销售额',amount:99,currency:'CNY'}]}};
 assert.equal(build([monthly]).issues[0].code,'missing-order-report');assert.equal(build([monthly]).pending_sources.length,1);
 assert.equal(build([doc()],[]).issues[0].code,'unmatched-order');assert.equal(build([doc()],[item(),item({order_id:101,item_id:21})]).issues[0].code,'ambiguous-order');
 assert.equal(build([doc(),{...monthly,id:2}]).issues[0].code,'sales-control-mismatch');
 assert.equal(build([doc()],[item({authorized_months:['2026-01']})]).lines[0].amount,null);
});
test('unknown cost poisons its own summary cell, real zero remains zero, references do not enter confirmed costs',()=>{
 const missing=build([doc()],[]),known=build([doc('2026-06',[row({sold:0,sold_quantity:0})])]);
 const summary=summarizePurchaseCostLines([...missing.lines,...known.lines]),matrix=financeMatrix(summary,'2026','month');assert.equal(matrix.rows[1].cells['2026-05'],null);assert.equal(matrix.rows[1].cells['2026-06'],0);assert.equal(summary[0].missing_count,1);
 assert.equal(build([doc()],[item()],{confirmedOnly:true}).lines.length,0);
});
test('SQL reader scopes legacy access, shop and original posting independently of order creation month',async()=>{
 const ctx={tenantId:2,companyId:10,s:{tenant:{slug:'tenant-a'}}};const calls=[];
 const query=async(sql,params)=>{calls.push({sql,params});if(sql.includes('FROM ozon_orders_raw'))return[];if(sql.includes('FROM finance_import_documents'))return[];if(sql.startsWith('SELECT shop_id'))return[{shop_id:7,effective_from:'2026-01-01',effective_to:null}];assert.match(sql,/s\.tenant_id=\?/);assert.match(sql,/a\.company_id=\?/);assert.match(sql,/o\.posting_number IN/);assert.ok(!sql.includes('o.ordered_at>='));assert.equal(params[1],2);assert.equal(params[2],0);assert.ok(params.includes(10));return[item()];};
 const r=await readCompanyPurchaseCosts({query,documents:[doc()],ctx,period});assert.equal(r.reference.known_amount_cny,12);assert.equal(calls.length,3);
});
test('unlisted financial SKU keeps its cost unresolved rather than silently dropping or moving it',()=>{
 const r=buildCompanyPurchaseCosts({documents:[doc()],items:[item(),item({item_id:21,ozon_sku:'10',purchase_cost_cny:8})],period,rawPostings:[{shop_id:7,posting_number:'123-456-1',raw_json:{raw:{posting_number:'123-456-1',products:[{sku:9,quantity:1},{sku:10,quantity:1}],financial_data:{products:[{product_id:9,payout:20,commission_amount:-2},{product_id:10,payout:0,commission_amount:0}]}}}}]});
 assert.equal(r.known_amount_cny,12);assert.equal(r.complete,false);assert.equal(r.issues[0].code,'unlisted-sku-cost');assert.equal(r.lines.find(l=>l.sku==='10').amount,null);
});
