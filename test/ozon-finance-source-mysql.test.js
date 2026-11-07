import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { ensureOrderProfitDailyFx } from '../src/services/order-profit-daily-fx.js';
import { ORDER_PROFIT_FX_POLICY_KEY } from '../src/services/order-profit-fx-policy.js';

test('daily finance ingestion works without profit-policy activation, stays idempotent and preserves legacy/V1 facts', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async () => {
  const fixture = await createTenantMysqlFixture('finance_source');fixture.useEnvironment();const q=fixture.query;
  const service=await import('../src/services/mysql-cutover.js');const {closeMysqlPool}=await import('../src/mysql-pool.js');
  const oldFetch=globalThis.fetch;const calls=[];let rotate=false;
  globalThis.fetch=async(url,options)=>{
    const path=new URL(url).pathname;assert.equal(new URL(url).host,'api-seller.ozon.ru');calls.push(path);
    if(rotate)await q("UPDATE shops SET api_key_hint='replacement-key' WHERE id=20");
    if(path==='/v1/finance/accrual/types')return new Response(JSON.stringify({accrual_types:[{id:1,name:'Acquiring'}]}));
    assert.equal(path,'/v1/finance/accrual/by-day');const date=JSON.parse(options.body).date;
    return new Response(JSON.stringify({accruals:[{accrual_id:'17',date,accrued_category:'POSTING',unit_number:'123-456-1',
      total_amount:{amount:'90',currency:'CNY'},posting:{products:[{sku:'700',quantity:1,commission:{sale_amount:{amount:'100',currency:'CNY'},commission:{amount:'-10',currency:'CNY'}}}]}}],last_id:''}));
  };
  try{
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,api_key_hint) VALUES(20,2,'A','active','fixture-client','fixture-key'),(21,2,'A legacy boundary','active','fixture-client-2','fixture-key-2'),(30,3,'B','active','foreign-client','foreign-key')");
    const day='2026-10-26';
    await ensureOrderProfitDailyFx({query:q},day,{now:Date.parse(day+'T06:00:00Z'),fetchImpl:async()=>({ok:true,text:async()=>'<ValCurs Date="26.10.2026"><Valute><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>10,0000</Value></Valute></ValCurs>'})});
    await q("INSERT INTO ozon_finance_items(shop_id,operation_id,posting_number,operation_date,service_type,amount_cny) VALUES(21,'legacy-21','legacy-posting','2026-10-25','legacy-fee',-9),(30,'foreign-30','foreign-posting','2026-10-26','legacy-fee',-99)");
    const protectedRows=await q("SELECT * FROM ozon_finance_items WHERE shop_id IN(21,30) ORDER BY id");
    assert.equal((await q('SELECT COUNT(*) n FROM system_settings WHERE `key`=?',[ORDER_PROFIT_FX_POLICY_KEY]))[0].n,0);
    const first=await service.syncOzonFinanceRawMysql({shop_id:20,from:day,to:day},{tenantId:2});
    assert.equal(first.source_endpoint,'/v1/finance/accrual/by-day');assert.equal(first.errors.length,0);
    const rows=await q("SELECT id,operation_id,amount,amount_cny,currency_code FROM ozon_finance_items WHERE shop_id=20 ORDER BY id");
    assert.equal(rows.length,2);assert.ok(rows.every(row=>row.operation_id==='accrual_by_day:17'&&row.currency_code==='CNY'));
    assert.equal(rows.reduce((sum,row)=>sum+Number(row.amount_cny),0),90);
    await q('INSERT INTO system_settings (`key`,value_json) VALUES (?,?)',[ORDER_PROFIT_FX_POLICY_KEY,'{"broken":true}']);
    await service.syncOzonFinanceRawMysql({shop_id:20,from:day,to:day},{tenantId:2});
    assert.deepEqual(await q("SELECT id,operation_id,amount,amount_cny,currency_code FROM ozon_finance_items WHERE shop_id=20 ORDER BY id"),rows);
    await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(101,20,'123-456-1','delivered','2026-10-25 00:00:00')");
    await q("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,actual_profit) VALUES(1011,101,'700',1,100,88)");
    await q("INSERT INTO order_profit_items(order_item_id,net_profit_cny,profit_status) VALUES(1011,88,'accrued')");
    const frozen=await q('SELECT * FROM order_items WHERE id=1011');
    const full=await service.syncOzonFinanceMysql({shop_id:20,from:day,to:day},{tenantId:2});
    assert.equal(full.applied.items,0);assert.deepEqual(await q('SELECT * FROM order_items WHERE id=1011'),frozen);
    assert.equal(Number((await q('SELECT net_profit_cny FROM order_profit_items WHERE order_item_id=1011'))[0].net_profit_cny),88);
    const boundary=await service.syncOzonFinanceRawMysql({shop_id:21,from:'2026-10-25',to:day},{tenantId:2});
    assert.equal(boundary.shops[0].source_from,day);assert.equal(boundary.warnings.length,1);
    assert.deepEqual(await q("SELECT * FROM ozon_finance_items WHERE operation_id IN('legacy-21','foreign-30') ORDER BY id"),protectedRows);
    calls.length=0;await assert.rejects(service.syncOzonFinanceRawMysql({shop_id:30,from:day,to:day},{tenantId:2}),error=>error.statusCode===404);assert.equal(calls.length,0);
    const before=await q('SELECT * FROM ozon_finance_items WHERE shop_id=20 ORDER BY id');rotate=true;
    await assert.rejects(service.syncOzonFinanceRawMysql({shop_id:20,from:day,to:day},{tenantId:2}),/授权在财务读取期间发生变化/);
    assert.equal(calls.length,1);assert.deepEqual(await q('SELECT * FROM ozon_finance_items WHERE shop_id=20 ORDER BY id'),before);
  }finally{globalThis.fetch=oldFetch;await closeMysqlPool();await fixture.cleanup();}
});
