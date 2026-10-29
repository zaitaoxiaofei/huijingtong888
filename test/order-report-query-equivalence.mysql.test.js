import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildOrderOutcomeSql } from '../src/services/order-outcome.js';
import { classifyOrderLogistics } from '../src/services/order-logistics-classification.js';
import { orderLogisticsSummarySql } from '../src/services/order-report-query-sql.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema, loadTenantOrderService, orderFunctionSource } from './helpers/tenant-order-service.js';

const methods=['profitRankingMysql','profitOrderedAtUtcRangeMysql','profitTimestampUtcRangeMysql','terminalOrderLossSqlMysql','returnLossTotalSqlMysql','roundMoneyMysql'];
const originalCount='mysqlQueryOne(`${outcomeCteSql} SELECT COUNT(*) AS total FROM (${baseSql}) ranking_rows`, params)';
const newCount='mysqlQueryOne(profitRankingGroupCountSql({ groupFields, joinSql, orderScope, dateWhereSql: dateFilter.whereSql, whereSql }), [...dateFilter.params, ...whereParams])';
const baselineLogistics=`SELECT o.id, o.posting_number, o.tracking_number, raw.raw_json,
 GROUP_CONCAT(DISTINCT summary_rule.name ORDER BY summary_rule.name SEPARATOR ' / ') AS billing_logistics_rule_name
 FROM orders o LEFT JOIN ozon_orders_raw raw ON raw.store_id=o.shop_id AND raw.posting_number=o.posting_number
 LEFT JOIN order_items summary_item ON summary_item.order_id=o.id
 LEFT JOIN logistics_fee_rules summary_rule ON summary_rule.id=summary_item.frozen_logistics_rule_id AND summary_rule.tenant_id = ?
 WHERE o.shop_id = ? GROUP BY o.id`;
const json=value=>JSON.parse(JSON.stringify(value));
test('real report SQL preserves exact totals, every monetary field, sorting, pages, dates and tenant boundaries',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('report_perf');const q=f.query;
 try{
  await createOrderFixtureSchema(f.connection);
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Default shop'),(20,2,'A shop'),(30,3,'B private')");
  await q("INSERT INTO products(id,tenant_id,name,code,active) VALUES(10,NULL,'Default','D',1),(20,2,'A product','A',1),(21,2,'Inactive','I',0),(30,3,'B private','B',1)");
  await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,offer_id,active) VALUES(10,NULL,10,10,'shared','D',1),(20,2,20,20,'shared','A',1),(21,2,20,21,'inactive','I',1),(30,3,30,30,'shared','B',1),(31,3,20,30,'poisoned','BP',1)");
  await q("INSERT INTO logistics_fee_rules(id,tenant_id,name,carrier) VALUES(20,2,'OGL Economy Extra Small','OGL'),(21,2,'GUOO Premium Big','GUOO'),(30,3,'B private tariff','CEL')");
  const states=[['delivered','delivered',null],['cancelled','cancelled','buyer'],['cancelled','delivering','rejected'],['returned','delivered','return'],['awaiting_packaging',null,null],['dispute',null,null]];
  let id=100;
  for(const shop of [10,20,30])for(let i=0;i<12;i++){
   const [status,stage,reason]=states[i%states.length];const order=++id;
   await q('INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,cancel_reason,ordered_at,delivered_at,cancelled_after_ship) VALUES(?,?,?,?,?,?,?,?,?)',[order,shop,`shared-${order}`,status,stage||'',reason,i===0?'2026-09-30 15:59:59':i===1?'2026-09-30 16:00:00':i===11?'2026-10-02 16:00:00':'2026-10-01 08:00:00',stage==='delivered'?'2026-10-03 08:00:00':null,i===2?1:0]);
   const payload=i%4===0?'{invalid':JSON.stringify(i%4===1?{raw:{fulfillment_schema:'FBP',delivery_method:{name:'FBP Hunchun'}}}:{delivery_method:{name:i%2?'GUOO Premium Big':'OGL Economy Extra Small'},description:'unrelated raw data '.repeat(100)});
   await q('INSERT INTO ozon_orders_raw(store_id,posting_number,raw_json) VALUES(?,?,?)',[shop,`shared-${order}`,payload]);
   for(let j=0;j<(i%3===0?2:1);j++){
    const item=order*10+j;const sku=i%4===0?'unmapped':i%4===1?'inactive':i%4===2?'poisoned':'shared';
    await q('INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,ozon_name,quantity,sale_price,estimated_profit,actual_profit,aftersale_loss,frozen_purchase_cost,frozen_logistics_rule_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[item,order,sku==='shared'?shop:sku==='poisoned'?31:sku==='inactive'?21:null,sku,'Report item '+sku,j+1,31.17+i,8.09+i,i%2?0:2.35,i%3?1.11:0,3.14,i%3===0?30:i%2?21:20]);
    if(i%2)await q('INSERT INTO order_profit_items(order_item_id,sale_amount_cny,net_profit_cny,profit_status,purchase_cost_cny,domestic_shipping_cny,international_shipping_cny,packaging_cost_cny,commission_fee_cny,ozon_service_fee_cny,return_loss_cny,advertising_cost_cny,other_fee_cny) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[item,21.19+i,-2.13+i,i%3?'pending':'accrued',3.13,1.01,2.02,0.1,1.2,0.4,0.9,0.33,0.17]);
   }
  }
  for(const shop of [10,20,30])await q("INSERT INTO ozon_ad_sku_daily(date_key,shop_id,ozon_sku,spend_cny,revenue_cny) VALUES('2026-10-01',?,'shared',3.17,22.19)",[shop]);
  const {service:after}=loadTenantOrderService(f.connection,{extraMethods:methods,buildOrderOutcomeSql});
  const {service:before}=loadTenantOrderService(f.connection,{extraMethods:methods,buildOrderOutcomeSql});
  assert.ok(orderFunctionSource('profitRankingMysql').includes(newCount));
  vm.runInContext(orderFunctionSource('profitRankingMysql').replace(newCount,originalCount),before);
  await t.test('complete ranking payload matches the original calculation for all dimensions and filter/page modes',async()=>{
   for(const tenant of ['admin','2','3'])for(const dimension of ['shop','product','sku'])for(const query of [{},{from:'2026-10-01',to:'2026-10-02'},{keyword:'shared'},{keyword:'private'},{from:'2026-10-01',to:'2026-10-01',sortBy:'revenue',sortOrder:'asc'},{page:2,pageSize:2},{page:99,pageSize:1},{fast:'1',pageSize:2},{shopId:30}]){
    const input={dimension,...query};assert.deepEqual(json(await after.profitRankingMysql(input,tenant)),json(await before.profitRankingMysql(input,tenant)),JSON.stringify({tenant,input}));
   }
   const a=await after.profitRankingMysql({dimension:'shop'},'2');assert.equal(a.total,1);assert.equal(a.rows[0].shop_id,20);assert.equal(a.rows[0].profit,-36.24);assert.equal(a.rows[0].revenue,339.74);assert.equal(Number(a.rows[0].order_count),12);assert.ok(!JSON.stringify(a).includes('B private'));
  });
  await t.test('narrow logistics aggregation preserves raw payload, tariff ordering, missing tariffs and classification',async()=>{
   for(const [tenant,shop] of [[1,10],[2,20],[3,30]]){
    const before=await q(baselineLogistics,[tenant,shop]);const after=await q(orderLogisticsSummarySql('o.shop_id = ?','summary_rule.tenant_id = ?'),[shop,tenant]);
    const sorted=rows=>rows.sort((a,b)=>a.id-b.id);assert.deepEqual(sorted(after),sorted(before));
    assert.deepEqual(after.map(classifyOrderLogistics),before.map(classifyOrderLogistics));
    const from='2026-09-30 16:00:00',to='2026-10-02 16:00:00';
    const narrowBefore=await q(baselineLogistics.replace('WHERE o.shop_id = ? GROUP BY','WHERE o.shop_id = ? AND o.ordered_at >= ? AND o.ordered_at < ? GROUP BY'),[tenant,shop,from,to]);
    const narrowAfter=await q(orderLogisticsSummarySql('o.shop_id = ? AND o.ordered_at >= ? AND o.ordered_at < ?','summary_rule.tenant_id = ?'),[shop,from,to,tenant]);
    assert.deepEqual(sorted(narrowAfter),sorted(narrowBefore));assert.equal(narrowAfter.length,10);
   }
  });
 }finally{await f.cleanup();}
});
