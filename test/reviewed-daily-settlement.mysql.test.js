import test from 'node:test';import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {rows} from './helpers/legacy-daily-fixture.js';
import {settleLegacyDailyOrder} from '../src/services/legacy-daily-accrual-settlement.js';
test('reviewed V6 settlement preserves estimates, retains provisional provenance and automatically replaces estimated acquiring with official fee', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET,timeout:180000},async()=>{
 const f=await createTenantMysqlFixture('reviewed_daily');f.useEnvironment();const q=f.query;
 const {withMysqlTransaction,mysqlQuery,closeMysqlPool}=await import('../src/mysql-pool.js');
 const {withVersionedOrderProfitWrite}=await import('../src/services/mysql-order-profit-version-write.js');
 try{
  await q('ALTER TABLE order_items ADD COLUMN frozen_logistics_rule_id BIGINT NULL');
  await q("INSERT INTO tenants(id,slug,name) VALUES(2,'review','Review')");await q("INSERT INTO shops(id,tenant_id,name)VALUES(5,2,'Review')");
  await q("INSERT INTO orders(id,shop_id,posting_number,order_number,status,tracking_stage,ordered_at)VALUES(1,5,'100-200-1','100-200','delivered','posting_received','2026-09-25')");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,frozen_purchase_cost,frozen_domestic_shipping,estimated_profit,frozen_international_shipping)VALUES(11,1,'a',1,100,20,2,60,5)");
  await q("INSERT INTO order_profit_items(order_item_id,purchase_cost_cny,domestic_shipping_cny,packaging_cost_cny,advertising_cost_cny,profit_status)VALUES(11,20,2,1,0,'estimated')");
  await q("INSERT INTO order_profit_daily_fx_rates(id,business_date,currency_from,currency_to,rate,source,source_date,source_nominal,source_value,source_url,source_sha256,fetched_at)VALUES(1,'2026-10-01','CNY','RUB',10,'cbr','2026-10-01',1,10,'https://www.cbr.ru/',REPEAT('a',64),NOW(3))");
  const ledger=rows().map(r=>{r.operation_date='2026-10-01 00:00:00';const raw=JSON.parse(r.raw_json);raw._erp_fx_archive.business_date='2026-10-01';raw._erp_fx_archive.source_date='2026-10-01';r.raw_json=JSON.stringify(raw);return r;});
  const insert=async r=>{const keys=Object.keys(r);await q(`INSERT INTO ozon_finance_items(${keys.join(',')})VALUES(${keys.map(()=>'?')})`,keys.map(k=>r[k]));};for(const r of ledger.slice(0,3))await insert(r);
  const deps={query:mysqlQuery,transaction:withMysqlTransaction,shopPredicate:'s.tenant_id=2',assertAuthorized:async()=>{},classifyCategory:r=>r.service_type.split(':')[1],packagingFeeForSaleAmount:async()=>1,writeVersioned:withVersionedOrderProfitWrite};
  const review={reference:'explicit user 5 percent fallback',order_ids:[1],missing_collecting:{rate:.05,min_age_days:30,as_of:'2026-11-14',coverage_reference:'verified official daily coverage',covered_shop_ids:[5]}};
  let p=await settleLegacyDailyOrder(deps,1,{preview:true,reviewed_settlement_policy:review});assert.equal(p.ok,true,JSON.stringify(p));assert.equal(p.items[0].actualProfit,47);assert.equal(p.quality,'estimated_acquiring');
  await settleLegacyDailyOrder(deps,1,{preview:false,preview_token:p.preview_token,reviewed_settlement_policy:review});
  assert.equal((await q('SELECT formula_version FROM order_profit_calc_state'))[0].formula_version,'V6');assert.equal((await q('SELECT lock_reason FROM order_profit_items'))[0].lock_reason,'finance_reviewed_daily_provisional');assert.equal(Number((await q('SELECT estimated_profit FROM order_items'))[0].estimated_profit),60);
  const n=(await q('SELECT * FROM order_profit_calc_revisions')).length;await new Promise(r=>setTimeout(r,1100));await settleLegacyDailyOrder(deps,1,{preview:false});assert.equal((await q('SELECT * FROM order_profit_calc_revisions')).length,n,'same-source retry is idempotent after clock advances');
  assert.equal((await q('SELECT settlement_state FROM order_items'))[0].settlement_state,'reviewed_provisional');assert.equal((await q('SELECT profit_status FROM order_profit_items'))[0].profit_status,'reviewed_provisional');
  await insert(ledger[3]);p=await settleLegacyDailyOrder(deps,1,{preview:true});assert.equal(p.quality,'official');assert.equal(p.items[0].actualProfit,50);await settleLegacyDailyOrder(deps,1,{preview:false,preview_token:p.preview_token});
  assert.equal((await q('SELECT lock_reason FROM order_profit_items'))[0].lock_reason,'finance_reviewed_daily');assert.equal(Number((await q('SELECT actual_profit FROM order_items'))[0].actual_profit),50);
 }finally{await closeMysqlPool();await f.cleanup();}
});
