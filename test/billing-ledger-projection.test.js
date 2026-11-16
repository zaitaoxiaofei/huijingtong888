import test from 'node:test';import assert from 'node:assert/strict';
import {projectBillingOrder,billingProjectionDeltas,splitLegacyPayment} from '../src/services/billing-ledger-projection.js';
import {billingDrilldown} from '../src/services/billing-drilldown.js';
import {billingProfitTotals} from '../src/shared/billing-profit.js';
const item=(extra={})=>({order_item_id:1,quantity:1,sale_price:100,ozon_sku:'SKU',product_id:8,inventory_number:'11-1-4',inventory_name:'库存商品',purchase_cost:20,international_shipping_cost:30,domestic_shipping_cost:3,commission_fee:12,other_fee:3,ozon_service_fee:0,aftersale_fee:0,profit_status:'estimated',formula_version:'V1',outcome_type:'rejected_unclaimed',estimate_inputs:{estimate:{paymentFee:2,withdrawalFee:1}},...extra});
const order={id:1,shop_id:2,posting_number:'P-1',month_key:'2026-10',outcome_type:'rejected_unclaimed'};
const fee=(category,amount,id=1)=>({billing_category:category,amount_cny:amount,amount,currency_code:'CNY',id,operation_id:'accrual_by_day:'+id,service_name:category});
test('signed official charge and reversal replace one estimated component, preserving missing freight and original source',()=>{
 const source=item();const result=projectBillingOrder(order,[source],{ok:true,rows:[fee('collecting_fee',-5),fee('collecting_fee',5,2)]});
 assert.equal(result.costs.other_fee,0);assert.equal(result.costs.international_shipping_cost,30);assert.equal(result.original_costs.other_fee,3);assert.equal(source.other_fee,3);assert.equal(result.reconciliation_status,'partial');assert.equal(result.fee_evidence.length,2);assert.equal(result.deltas.other_fee,-3);
 const credit=projectBillingOrder(order,[source],{ok:true,rows:[fee('commission',3)]});assert.equal(credit.costs.commission_fee,-3);
});
test('complete official components and explicit aftersale fees reconcile without rewriting historical profits',()=>{
 const result=projectBillingOrder(order,[item()],{ok:true,income_rows:[{}],sale_accrual_cny:0,rows:[fee('income',0),fee('commission',0),fee('collecting_fee',-2),fee('international_transport',-10),fee('platform_delivery',0),fee('aftersale_loss',-4)]});
 assert.equal(result.reconciliation_status,'official');assert.equal(result.costs.aftersale_fee,4);assert.equal(result.deltas.aftersale_fee,4);assert.equal(result.costs.commission_fee,0);
 const delta=billingProjectionDeltas([result]).get('2026-10:2');assert.equal(delta.international_shipping_cost,-20);assert.equal(delta.aftersale_fee,4);
});
test('missing or invalid official evidence never zeros estimated cost and immutable snapshots remove embedded withdrawal once',()=>{
 const result=projectBillingOrder(order,[item()],{ok:false,code:'FX_FINANCE_CURRENCY_UNKNOWN'});assert.equal(result.costs.other_fee,2);assert.equal(result.costs.international_shipping_cost,30);assert.equal(result.reconciliation_reason,'FX_FINANCE_CURRENCY_UNKNOWN');assert.equal(result.legacy_withdrawal_removed,1);
 assert.equal(splitLegacyPayment(item({profit_status:'accrued'})).amount,0);
 const active=projectBillingOrder({...order,outcome_type:'active'},[item({outcome_type:'active',ozon_service_fee:3,other_fee:0})]);assert.equal(active.costs.ozon_service_fee,0);assert.equal(active.costs.other_fee,2);
});
test('SKU and inventory summaries conserve multi-item costs, use the entire cohort denominator, sort before pagination and keep unbound identities distinct',()=>{
 const first=projectBillingOrder(order,[item()]);const delivered=projectBillingOrder({...order,id:2,outcome_type:'active'},[item({outcome_type:'active'})]);
 const second=projectBillingOrder({...order,id:3,shop_id:3},[item({product_id:9,ozon_sku:'SKU',purchase_cost:40})]);
 let result=billingDrilldown([first,delivered,second],{groupBy:'inventory',outcomeType:'returns',pageSize:20,sortBy:'amount'});assert.equal(result.total,2);assert.equal(result.summary.order_count,2);assert.equal(result.rows[0].product_id,9);assert.equal(result.rows.find(r=>r.product_id===8).rate,.5);assert.equal(result.summary.quantity,2);
 result=billingDrilldown([first,delivered,second],{groupBy:'sku',outcomeType:'returns'});assert.equal(result.total,2);
 result=billingDrilldown([first,delivered,second],{groupBy:'order',outcomeType:'returns',productId:8});assert.equal(result.total,1);assert.equal(result.rows[0].posting_number,'P-1');
});
test('withdrawal uses platform net receipts, deducts monthly ads once, excludes company costs and clamps negative payout base',()=>{
 const summary={revenue:100,commission_fee:12,international_shipping_cost:30,other_fee:2,advertising_cost:6,purchase_cost:20,domestic_shipping_cost:3,packaging_cost:1};
 const result=billingProfitTotals(summary,[{category:'salary',amount_cny:5}]);assert.equal(result.withdrawal_base,50);assert.equal(result.withdrawal_fee,.6);assert.equal(result.order_profit,26);assert.equal(result.net_profit,20.4);
 assert.equal(billingProfitTotals({...summary,revenue:0}).withdrawal_fee,0);
 const actual=billingProfitTotals(summary,[{category:'withdrawal',amount_cny:.5}]);assert.equal(actual.net_profit,25.5);assert.equal(actual.withdrawal_fee,.5);
});

test('actual withdrawal replaces only its company/month estimate and preserves other companies and months',async()=>{
 const {scopedBillingWithdrawal}=await import('../src/shared/billing-withdrawal.js');
 const rows=[{month_key:'2026-10',shop_id:1,revenue:100},{month_key:'2026-10',shop_id:2,revenue:100},{month_key:'2026-11',shop_id:1,revenue:100}];
 const assignments=[{shop_id:1,company_id:1,effective_from:'2026-01-01'},{shop_id:2,company_id:2,effective_from:'2026-01-01'}];
 const expenses=[{company_id:1,category:'withdrawal',expense_date:'2026-10-20',amount_cny:1}];
 const value=scopedBillingWithdrawal(rows,expenses,assignments);assert.equal(value.withdrawal_fee,3.4);assert.equal(value.withdrawal_auto_to_deduct,2.4);assert.equal(value.withdrawal_estimate,3.6);
 const totals=billingProfitTotals({revenue:300,...value},expenses);assert.equal(totals.net_profit,296.6);
 assert.equal(splitLegacyPayment(item({formula_version:'V6',ozon_service_fee:.58})).amount,0);
});

test('a partial official shipping component cannot erase an unverified cross-border estimate',()=>{
 const result=projectBillingOrder(order,[item()],{ok:true,rows:[fee('platform_delivery',-8)]});assert.equal(result.costs.international_shipping_cost,30);assert.equal(result.reconciliation_status,'partial');
});

test('manual order-cost corrections appear in drilldown totals once without altering original amounts',async()=>{
 const {withBillingCostAdjustments}=await import('../src/services/billing-drilldown.js');const source=projectBillingOrder(order,[item()]);
 const projected=withBillingCostAdjustments([source],[{source_type:'billing_cost_adjustment',cost_order_id:1,cost_field:'domestic_shipping_cost',amount_cny:-1}]);
 const detail=billingDrilldown(projected,{groupBy:'order',outcomeType:'returns'});assert.equal(detail.rows[0].billing_costs.domestic_shipping_cost,2);assert.equal(detail.rows[0].domestic_shipping_cost,3);assert.equal(detail.rows[0].adjustments_included,true);assert.equal(source.items[0].costs.domestic_shipping_cost,3);
});

test('inventory defaults to returned pieces descending and independently sorts by piece rate or allocated loss',()=>{
 const many=projectBillingOrder(order,[item({quantity:2,purchase_cost:20})]);
 const expensive=projectBillingOrder({...order,id:3},[item({product_id:9,quantity:1,purchase_cost:100})]);
 const sales=projectBillingOrder({...order,id:4,outcome_type:'active'},[item({quantity:8,outcome_type:'active'})]);
 const data=[many,expensive,sales];
 assert.equal(billingDrilldown(data,{groupBy:'inventory',outcomeType:'returns'}).rows[0].product_id,8);
 const byRate=billingDrilldown(data,{groupBy:'inventory',outcomeType:'returns',sortBy:'rate'});assert.equal(byRate.rows[0].product_id,9);assert.equal(byRate.rows.find(r=>r.product_id===8).rate,.2);
 assert.equal(billingDrilldown(data,{groupBy:'inventory',outcomeType:'returns',sortBy:'amount'}).rows[0].product_id,9);
});

test('disposed return reporting v4 removes revenue, retains goods, nets reversals once and isolates compensation',async()=>{
 const {billingReturnItem}=await import('../src/services/billing-ledger-projection.js');
 const source=billingReturnItem(item({item_revenue:100,aftersale:{observations:[{return_id:'1',product:{sku:'SKU'},state:{state:'Utilizing'}}]}}));
 assert.equal(source.disposed_return,true);assert.equal(source.return_quantity,1);
 const finance={ok:true,rows:[fee('collecting_fee',-5),fee('collecting_fee',5,2),{...fee('aftersale_loss',7,3),service_name:'ItemCompensation'}]};
 const r=projectBillingOrder({...order,revenue:100,official_return_flag:true},[source],finance);
 assert.equal(r.sales_revenue,0);assert.equal(r.compensation_income,7);assert.equal(r.billing_revenue,7);assert.equal(r.costs.purchase_cost,20);assert.equal(r.costs.other_fee,0);assert.equal(r.costs.aftersale_fee,0);assert.equal(r.income_pending_count,0);assert.equal(r.disposed_revenue_removed,100);assert.equal(r.fee_evidence.at(-1).category,'compensation');
 const repeat=projectBillingOrder({...order,revenue:100,official_return_flag:true},[source],finance);assert.deepEqual(repeat,r);
 const legacy=projectBillingOrder({...order,revenue:100,official_return_flag:true},[source],finance,'official-net-fees-and-withdrawal-v2');assert.equal(legacy.billing_revenue,100);assert.equal(legacy.income_pending_count,1);
 const withIncome=projectBillingOrder({...order,revenue:100,official_return_flag:true},[source],{...finance,income_rows:[{}],sale_accrual_cny:100});assert.equal(withIncome.billing_revenue,7);
 assert.equal(billingDrilldown([r],{outcomeType:'returns'}).rows[0].billing_revenue,7);
});
test('partial disposed SKU removes only its returned quantity and does not zero unrelated items',async()=>{
 const {billingReturnItem}=await import('../src/services/billing-ledger-projection.js');
 const source=billingReturnItem(item({quantity:2,item_revenue:200,aftersale:{observations:[{return_id:'1',product:{sku:'SKU',quantity:1},state:{state:'Utilized'}}]}}));
 const other=item({order_item_id:2,ozon_sku:'OTHER',item_revenue:50,sale_price:50,outcome_type:'active',billing_return:false});
 const r=projectBillingOrder({...order,revenue:250,official_return_flag:true},[source,other]);assert.equal(r.billing_revenue,150);assert.equal(r.income_pending_count,0);assert.equal(r.items[0].billing_revenue,100);assert.equal(r.items[1].billing_revenue,50);assert.equal(r.costs.purchase_cost,40);
 const unknown=billingReturnItem(item({quantity:2,item_revenue:200,aftersale:{observations:[{return_id:'2',product:{sku:'SKU'},state:{state:'Utilizing'}}]}}));
 const pending=projectBillingOrder({...order,revenue:200,official_return_flag:true},[unknown]);assert.equal(pending.billing_revenue,200);assert.equal(pending.income_pending_count,1);
});
