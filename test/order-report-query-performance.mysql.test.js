import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { buildOrderOutcomeSql } from '../src/services/order-outcome.js';
import { orderLogisticsSummarySql } from '../src/services/order-report-query-sql.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema, loadTenantOrderService, orderFunctionSource } from './helpers/tenant-order-service.js';

// Representative scale, entirely synthetic. Never connect to an application DB.
test('31k-order fixture compares report plans and exact results without a flaky timing threshold',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('report_scale');const q=f.query;const count=31121;
 try{
  await createOrderFixtureSchema(f.connection);
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A')");
  await q("INSERT INTO shops(id,tenant_id,name) VALUES(20,2,'Synthetic shop')");
  await q("INSERT INTO products(id,tenant_id,name,code) VALUES(20,2,'Synthetic product','P')");
  await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,offer_id) VALUES(20,2,20,20,'shared','P')");
  await q("INSERT INTO logistics_fee_rules(id,tenant_id,name,carrier) VALUES(20,2,'OGL Economy Extra Small','OGL')");
  await q('SET SESSION cte_max_recursion_depth=40000');
  await q(`INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) WITH RECURSIVE n AS (SELECT 1 id UNION ALL SELECT id+1 FROM n WHERE id<${count}) SELECT id,20,CONCAT('synthetic-',id),IF(MOD(id,3)=0,'delivered','awaiting_packaging'),'2026-10-01 08:00:00' FROM n`);
  await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,ozon_name,quantity,sale_price,estimated_profit,frozen_logistics_rule_id) SELECT id,id,IF(MOD(id,2)=0,20,NULL),IF(MOD(id,2)=0,'shared',CONCAT('unbound-',MOD(id,31))),'Synthetic',1,31.17,8.09,20 FROM orders");
  await q("INSERT INTO ozon_orders_raw(store_id,posting_number,raw_json) SELECT shop_id,posting_number,JSON_OBJECT('delivery_method',JSON_OBJECT('name','OGL Economy Extra Small'),'irrelevant_payload',REPEAT('synthetic data ',200)) FROM orders");
  const {service}=loadTenantOrderService(f.connection,{extraMethods:['profitRankingMysql','profitOrderedAtUtcRangeMysql','profitTimestampUtcRangeMysql','terminalOrderLossSqlMysql','returnLossTotalSqlMysql','roundMoneyMysql'],buildOrderOutcomeSql});
  const {service:original}=loadTenantOrderService(f.connection,{extraMethods:['profitRankingMysql','profitOrderedAtUtcRangeMysql','profitTimestampUtcRangeMysql','terminalOrderLossSqlMysql','returnLossTotalSqlMysql','roundMoneyMysql'],buildOrderOutcomeSql});
  vm.runInContext(orderFunctionSource('profitRankingMysql').replace('mysqlQueryOne(profitRankingGroupCountSql({ groupFields, joinSql, orderScope, dateWhereSql: dateFilter.whereSql, whereSql }), [...dateFilter.params, ...whereParams])','mysqlQueryOne(`${outcomeCteSql} SELECT COUNT(*) AS total FROM (${baseSql}) ranking_rows`, params)'),original);
  const times=[];
  async function compare(label,before,after,normalize=value=>JSON.parse(JSON.stringify(value))){let t=performance.now();const a=await before();const oldMs=performance.now()-t;t=performance.now();const b=await after();const newMs=performance.now()-t;assert.deepEqual(normalize(b),normalize(a),label);times.push({label,baseline_ms:+oldMs.toFixed(1),candidate_ms:+newMs.toFixed(1)});}
  for(const dimension of ['sku','shop','product'])await compare('profit_'+dimension,()=>original.profitRankingMysql({dimension,pageSize:10},'2'),()=>service.profitRankingMysql({dimension,pageSize:10},'2'));
  const oldSql=`SELECT o.id,o.posting_number,o.tracking_number,raw.raw_json,GROUP_CONCAT(DISTINCT summary_rule.name ORDER BY summary_rule.name SEPARATOR ' / ') billing_logistics_rule_name FROM orders o LEFT JOIN ozon_orders_raw raw ON raw.store_id=o.shop_id AND raw.posting_number=o.posting_number LEFT JOIN order_items summary_item ON summary_item.order_id=o.id LEFT JOIN logistics_fee_rules summary_rule ON summary_rule.id=summary_item.frozen_logistics_rule_id AND summary_rule.tenant_id=2 WHERE o.shop_id=20 GROUP BY o.id`;
  await compare('order_logistics',()=>q(oldSql),()=>q(orderLogisticsSummarySql('o.shop_id=20','summary_rule.tenant_id=2')),rows=>rows.sort((a,b)=>a.id-b.id));
  const base={where:'o.shop_id=20',params:[]},scope={id:2,defaultTenant:false},coverage=new Map();
  const states=['awaiting_packaging','awaiting_deliver','ogl_dispatched','delivering','dispute','delivered','cancelled','unbound','pending_purchase','purchase_in_transit','purchase_records_missing'];
  const countsSql=`SELECT COUNT(*) all_count,${states.map(status=>`SUM(CASE WHEN ${service.orderStatusSqlMysql(status,coverage,scope,'ogl_count_evidence')} THEN 1 ELSE 0 END) ${status}`).join(',')} FROM orders o ${service.orderPagedOglEvidenceJoinMysql(scope)} WHERE ${base.where}`;
  await compare('order_status_counts',async()=>{const [r]=await q(countsSql);return {all:Number(r.all_count),...Object.fromEntries(states.map(s=>[s,Number(r[s])]))};},()=>service.orderPagedSqlCountsMysql(base,coverage,scope));
  t.diagnostic(JSON.stringify({orders:count,synthetic:true,timings:times}));
 }finally{await f.cleanup();}
});
