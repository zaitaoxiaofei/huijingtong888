import test from 'node:test';import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {row,rows} from './helpers/legacy-daily-fixture.js';
import {settleLegacyDailyOrder} from '../src/services/legacy-daily-accrual-settlement.js';

test('isolated legacy backfill writes actual profit with atomic V5 migration, preserves estimates, isolates tenants and retries idempotently', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET,timeout:180000}, async()=>{
 const f=await createTenantMysqlFixture('legacy_daily');f.useEnvironment();const q=f.query;
 const {withMysqlTransaction,mysqlQuery,closeMysqlPool}=await import('../src/mysql-pool.js');
 const {withVersionedOrderProfitWrite}=await import('../src/services/mysql-order-profit-version-write.js');
 const deps={query:mysqlQuery,transaction:withMysqlTransaction,shopPredicate:'s.tenant_id=2',assertAuthorized:async()=>{},classifyCategory:r=>r.service_type.split(':')[1],packagingFeeForSaleAmount:async()=>1,writeVersioned:withVersionedOrderProfitWrite};
 try{
  await q("ALTER TABLE order_items ADD COLUMN frozen_logistics_rule_id BIGINT NULL");
  await q("INSERT INTO tenants(id,slug,name) VALUES(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO shops(id,tenant_id,name) VALUES(5,2,'A'),(6,3,'B')");
  await q("INSERT INTO orders(id,shop_id,posting_number,order_number,status,tracking_stage,ordered_at) VALUES(1,5,'100-200-1','100-200','delivered','posting_received','2026-10-20'),(2,5,'100-200-2','100-200','delivered','posting_received','2026-10-20'),(3,6,'100-200-1','100-200','delivered','posting_received','2026-10-20')");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,frozen_purchase_cost,frozen_domestic_shipping,estimated_profit,frozen_international_shipping) VALUES(11,1,'a',1,100,20,2,60,5),(21,2,'b',1,100,30,2,50,5),(31,3,'c',1,100,30,2,70,5)");
  await q("INSERT INTO order_profit_items(order_item_id,purchase_cost_cny,domestic_shipping_cny,packaging_cost_cny,profit_status) VALUES(11,20,2,1,'estimated'),(21,30,2,1,'estimated'),(31,30,2,1,'estimated')");
  await q("INSERT INTO order_profit_daily_fx_rates(id,business_date,currency_from,currency_to,rate,source,source_date,source_nominal,source_value,source_url,source_sha256,fetched_at) VALUES(1,'2026-11-12','CNY','RUB',10,'cbr','2026-11-12',1,10,'https://www.cbr.ru/',REPEAT('a',64),NOW(3))");
  const evidence=[{shop_id:5,operation_id:'legacy-acquiring-4',finance_item_id:4,verified:true,currency_code:'RUB',source:'user_confirmation',reference:'chat:2026-11-14:confirmed legacy acquiring RUB'}];
  const ledger=rows();ledger[3]={...ledger[3],operation_id:'legacy-acquiring-4',operation_date:'2026-11-10 00:00:00',currency_code:'',exchange_rate:10,raw_json:'{}'};for(const r of ledger){const keys=Object.keys(r);await q(`INSERT INTO ozon_finance_items(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,keys.map(k=>r[k]));}
  await q("UPDATE order_items SET actual_profit=9 WHERE id=11");
  const preview=await settleLegacyDailyOrder(deps,1,{legacy_currency_evidence:evidence});assert.equal(preview.ok,true,JSON.stringify(preview));assert.equal(preview.items[0].actualProfit,51);assert.equal((await q('SELECT * FROM order_profit_calc_revisions')).length,0,'preview never writes baselines');
  await assert.rejects(settleLegacyDailyOrder(deps,3),{statusCode:404});
  const applied=await settleLegacyDailyOrder(deps,1,{preview:false,preview_token:preview.preview_token,legacy_currency_evidence:evidence});assert.equal(applied.updated,1);
  const [saved]=await q('SELECT * FROM order_items WHERE id=11');assert.equal(Number(saved.actual_profit),51);assert.equal(Number(saved.estimated_profit),60);assert.equal(Number(saved.frozen_international_shipping),5);
  assert.equal((await q('SELECT formula_version FROM order_profit_calc_state WHERE order_item_id=11'))[0].formula_version,'V5');
  const history=await q('SELECT layer,formula_version,inputs_json,outputs_json FROM order_profit_calc_revisions ORDER BY revision_no');assert.equal(history[0].formula_version,'V1');assert.equal(history[0].layer,'estimate');assert.equal(JSON.parse(history[0].outputs_json).estimated_profit,'60.0000');assert.equal(history.at(-1).formula_version,'V5');assert.equal(JSON.parse(history.at(-1).inputs_json).finance_rows.find(r=>r.operation_id==='legacy-acquiring-4').currency_source,'user_confirmation');assert.equal(JSON.parse(history.find(row=>row.layer==='actual'&&row.formula_version==='V1').outputs_json).actual_profit,'9.0000');
  await settleLegacyDailyOrder(deps,1,{preview:false});assert.equal((await q('SELECT * FROM order_profit_calc_revisions')).length,history.length,'retry has no new revision');
  assert.equal(Number((await q('SELECT actual_profit FROM order_items WHERE id=31'))[0].actual_profit),0);
  // Full transaction rollback includes the V1 -> V5 metadata and baseline write.
  const second=rows().slice(0,3).map((r,n)=>({...r,id:r.id+100,operation_id:`accrual_by_day:${r.id+100}`,posting_number:'100-200-2'}));
  for(const r of second){const keys=Object.keys(r);await q(`INSERT INTO ozon_finance_items(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,keys.map(k=>r[k]));}
  const failed={...deps,writeVersioned:(id,options,project)=>withVersionedOrderProfitWrite(id,options,async args=>{await project(args);throw Error('injected projection failure');})};
  await assert.rejects(settleLegacyDailyOrder(failed,2,{preview:false,legacy_currency_evidence:evidence}),/injected/);assert.equal((await q('SELECT * FROM order_profit_calc_state WHERE order_item_id=21')).length,0);assert.equal(Number((await q('SELECT actual_profit FROM order_items WHERE id=21'))[0].actual_profit),0);
  const old=await settleLegacyDailyOrder(deps,2,{legacy_currency_evidence:evidence});await q('UPDATE order_items SET frozen_purchase_cost=31 WHERE id=21');await assert.rejects(settleLegacyDailyOrder(deps,2,{preview:false,preview_token:old.preview_token,legacy_currency_evidence:evidence}),{code:'LEGACY_DAILY_PREVIEW_STALE'});
 }finally{await closeMysqlPool();await f.cleanup();}
});
