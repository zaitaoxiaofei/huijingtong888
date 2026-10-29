import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('official sync supports direct, composition and recipe stocks; partial failure and changed bindings preserve snapshots', {
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout:180000
}, async () => {
  const fixture = await createTenantMysqlFixture('fbp_sync'); fixture.useEnvironment();
  const q = fixture.query;
  const service = await import('../src/services/mysql-cutover.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const oldFetch = globalThis.fetch;
  let failSecond = false, changed = false, calls = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/v4/product/info/stocks'));
    const offers = JSON.parse(options.body).filter.offer_id;
    calls.push(offers);
    if (changed) await q('UPDATE sku_mappings SET product_id=201 WHERE id=1');
    if (failSecond && offers.includes('B')) return new Response(JSON.stringify({message:'not authorized'}), {status:403});
    return new Response(JSON.stringify({result:{items:offers.map(offer_id => ({offer_id,sku:{A:'DIRECT',B:'COMBO',C:'RECIPE'}[offer_id],stocks:[{type:'fbo',warehouse_id:'1',warehouse_name:'FBP',present:3,reserved:1,available:2}]}))}}),{status:200});
  };
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await service.prepareInventoryFlowMysql();
    await q("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,api_key_hint) VALUES(20,2,'Z店','active','test-client','fixture-only-key'),(21,2,'M店','active','test-client','fixture-only-key'),(30,3,'B private','active','test-client','fixture-only-key')");
    await q("INSERT INTO products(id,tenant_id,name) VALUES(200,2,'part'),(201,2,'other'),(202,2,'two-pack'),(300,3,'private')");
    await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,offer_id,active) VALUES(1,2,200,20,'DIRECT','A',1),(2,2,202,21,'COMBO','B',1),(3,3,300,30,'PRIVATE','X',1)");
    await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,202,200,2)');
    await q("INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active) VALUES(1,20,'RECIPE',1)");
    await q('INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES(1,200,3)');
    await q("INSERT INTO online_products(shop_id,ozon_sku,offer_id,name) VALUES(20,'RECIPE','C','recipe')");
    await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,200,'purchase_inbound',193,'posted','LOCAL')");
    const movements = await q('SELECT id,quantity_delta FROM inventory_movements');
    const first = await service.syncInventoryFlowStocksMysql({product_id:200},{tenantId:2});
    assert.equal(first.ok,true,JSON.stringify(first));
    assert.equal(first.results.length,2);
    assert.deepEqual(calls.flat().sort(),['A','B','C']);
    const ledger = await service.inventoryLedgerMysql({product_id:200,view:'fbp'},2);
    assert.equal(ledger.fbp_inventory.present,18); // 3 direct + 3*2 composition + 3*3 recipe
    assert.equal(ledger.fbp_inventory.incomplete,false);
    assert.equal((await service.inventoryLedgerMysql({product_id:200,include_flow:'local'},2)).physical_estimate,193);
    assert.equal((await q("SELECT COUNT(*) AS n FROM ozon_stock_snapshots WHERE shop_id=30"))[0].n,0);
    const previous = await q("SELECT present,synced_at FROM ozon_stock_snapshots WHERE shop_id=21 AND ozon_sku='COMBO'");
    failSecond=true;
    const partial = await service.syncInventoryFlowStocksMysql({product_id:200},{tenantId:2});
    assert.equal(partial.ok,false);
    assert.equal(partial.results.find(row=>row.shop_id===20).ok,true);
    assert.deepEqual(await q("SELECT present,synced_at FROM ozon_stock_snapshots WHERE shop_id=21 AND ozon_sku='COMBO'"),previous);
    assert.deepEqual(await q('SELECT id,quantity_delta FROM inventory_movements'),movements);
    failSecond=false;changed=true;
    const directBefore=await q("SELECT present,synced_at FROM ozon_stock_snapshots WHERE shop_id=20 AND ozon_sku='DIRECT'");
    const stale=await service.syncInventoryFlowStocksMysql({product_id:200},{tenantId:2});
    assert.equal(stale.results.find(row=>row.shop_id===20).ok,false);
    assert.deepEqual(await q("SELECT present,synced_at FROM ozon_stock_snapshots WHERE shop_id=20 AND ozon_sku='DIRECT'"),directBefore);
    await assert.rejects(service.syncInventoryFlowStocksMysql({product_id:300},{tenantId:2}),{statusCode:404});
  } finally { globalThis.fetch=oldFetch; await closeMysqlPool(); await fixture.cleanup(); }
});
