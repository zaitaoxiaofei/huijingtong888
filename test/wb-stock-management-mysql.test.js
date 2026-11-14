import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { WB_SCHEMA } from '../src/services/wb-schema.js';
import { createWbPlatform } from '../src/services/wb-platform.js';

test('manual WB stock batches use real A/B enterprise shop and card ownership without requiring local mappings', { skip: !process.env.TENANT_TEST_MYSQL_SOCKET }, async () => {
  const f = await createTenantMysqlFixture('wb_manual_stocks');
  try {
    const { query } = f;
    for (const sql of WB_SCHEMA) await query(sql);
    await query("INSERT INTO tenants(id,slug,name,status,shop_limit) VALUES(2,'a','A','active',10),(3,'b','B','active',10)");
    await query("INSERT INTO people(id,name,active) VALUES(2,'A owner',1),(3,'B owner',1)");
    await query("INSERT INTO shops(id,tenant_id,name,platform,user_id,status) VALUES(20,2,'WB A','wb',2,'active'),(30,3,'WB B','wb',3,'active')");
    await query("INSERT INTO wb_shop_credentials(shop_id,tenant_id,token,environment,seller_id,checked_at,wb_warehouse_id) VALUES(20,2,'fixture-only','production','seller-a',UTC_TIMESTAMP(),55),(30,3,'fixture-only','production','seller-b',UTC_TIMESTAMP(),66)");
    for (const [tenant, shop, nm, chrt] of [[2,20,100,200],[3,30,300,400]]) await query('INSERT INTO wb_product_cards(tenant_id,shop_id,nm_id,vendor_code,title,raw_json,synced_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())', [tenant,shop,nm,'WB-'+nm,'Product',JSON.stringify({sizes:[{chrtID:chrt,skus:[]}]})]);
    const calls = [], stocks = new Map([[200,7],[400,9]]);
    const service = createWbPlatform({ query, request: async (a, service, path, options = {}) => {
      calls.push({ tenant: a.tenant_id, shop: a.shop_id, path, ...options });
      if (path === '/api/v3/warehouses') return [{ id: Number(a.wb_warehouse_id) }];
      if (options.method === 'PUT') { for (const row of options.body.stocks) stocks.set(row.chrtId,row.amount); return {}; }
      return { stocks: options.body.chrtIds.map(chrtId=>({chrtId,amount:stocks.get(chrtId)})) };
    }});
    const input = { shop_id:20,warehouse_id:55,items:[{nm_id:100,chrt_id:200,current:7,quantity:15}] };
    assert.equal((await service.setStockBatch(2,input)).ok,true);
    assert.equal((await query('SELECT COUNT(*) n FROM sku_mappings'))[0].n,0);
    const before = calls.length;
    await assert.rejects(service.setStockBatch(3,input),error=>error.statusCode===404);
    assert.equal(calls.length,before);
    await assert.rejects(service.setStockBatch(2,{...input,items:[{nm_id:300,chrt_id:400,current:9,quantity:0}]}),/不属于/);
    await assert.rejects(service.setStockBatch(2,{...input,warehouse_id:66}),/不属于/);
    assert.equal(calls.filter(call=>call.method==='PUT').length,1);
    assert.equal((await service.setStockBatch(3,{shop_id:30,warehouse_id:66,items:[{nm_id:300,chrt_id:400,current:9,quantity:0}]})).ok,true);
    assert.deepEqual(calls.filter(call=>call.method==='PUT').map(call=>[call.tenant,call.shop,call.path]),[[2,20,'/api/v3/stocks/55'],[3,30,'/api/v3/stocks/66']]);
    assert.equal((await query('SELECT COUNT(*) n FROM inventory_movements'))[0].n,0);
  } finally { await f.cleanup(); }
});
