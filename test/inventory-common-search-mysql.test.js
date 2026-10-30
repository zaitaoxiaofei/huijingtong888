import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('inventory pages share exact, structured and tenant-scoped search before pagination', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET,timeout:180000}, async t => {
  const f=await createTenantMysqlFixture('common_search');f.useEnvironment();
  const {inventoryProductSearch,filterInventoryProductRows,inventoryBusinessSearch}=await import('../src/services/inventory-product-search.js');
  const {resolveInventoryTenantScope}=await import('../src/services/inventory-tenant-scope.js');
  const legacy=await import('../src/services/mysql-cutover.js');
  const {closeMysqlPool}=await import('../src/mysql-pool.js');
  const q=f.query;
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A shop','active'),(30,3,'B shop','active')");
    await legacy.prepareInventoryFlowMysql();
    await q("INSERT INTO products(id,tenant_id,name,inventory_number,inventory_category,vehicle_brand,vehicle_model,accessory_name,color,material,surface_process) VALUES(200,2,'黑色 钥匙壳','1-2','钥匙壳','TENET','T4/T7','普通','黑色','TPU/皮革','印花'),(201,2,'红色 钥匙壳','1-23','钥匙壳','TENET','T4','普通','红色','TPU','印花'),(300,3,'黑色 钥匙壳','1-2','钥匙壳','TENET','T4','普通','黑色','TPU','印花')");
    await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,offer_id,active) VALUES(200,2,200,20,'20001','OFFER200',1),(201,2,201,20,'20002','OFFER201',1),(300,3,300,30,'30001','PRIVATE',1)");
    const scope=await resolveInventoryTenantScope(2,q);
    const number=(await q('SELECT inventory_number FROM products WHERE id=200'))[0].inventory_number;
    const rows=[{product_id:200},{product_id:201},{product_id:300}];
    for(const [query,expected] of [
      [{searchMode:'inventory_id',query:number},[200]],
      [{searchMode:'sku',query:'20001'},[200]],
      [{searchMode:'sku',query:'2000'},[]],
      [{searchMode:'sku',query:'30001'},[]],
      [{searchMode:'name',query:'钥匙壳 黑色'},[200]],
      [{inventoryCategory:'钥匙壳',vehicleBrand:'TENET',vehicleModel:'T7',color:'黑色',material:'皮革',process:'印花'},[200]],
      [{inventoryCategory:'不存在'},[]],
      [{productName:'%_'},[]]
    ]) {
      await t.test(JSON.stringify(query),async()=>{
        const match=await filterInventoryProductRows(rows,query,scope,q);
        assert.deepEqual(match.map(r=>r.product_id),expected);
        const criteria=inventoryProductSearch(query,scope);
        assert.equal(criteria.sql.match(/\?/g)?.length||0,criteria.params.length);
      });
    }
    await t.test('default reads add no search query and preserve page-specific keywords',async()=>{
      const same=await filterInventoryProductRows(rows,{query:'采购单号'},scope,()=>{throw Error('Unexpected product lookup');});
      assert.equal(same,rows);assert.equal(inventoryBusinessSearch({query:'申请人'}).query,'申请人');
      assert.equal(inventoryBusinessSearch({searchMode:'name',query:'黑色'}).query,'');
    });
    await t.test('goods and mappings apply common criteria in SQL before count and limit',async()=>{
      for (const [read,key] of [[legacy.productsMysql,'id'],[legacy.mappingsMysql,'product_id']]) {
        const found=await read({paged:'1',view:'inventory',includeStock:'0',searchMode:'inventory_id',query:number,pageSize:1},2);
        assert.equal(found.total,1);assert.equal(Number(found.rows[0][key]),200);
        const structured=await read({paged:'1',view:'inventory',includeStock:'0',vehicleModel:'T7',material:'皮革',pageSize:1},2);
        assert.equal(structured.total,1);assert.equal(Number(structured.rows[0][key]),200);
      }
    });
    await t.test('one SKU search never brings back a sibling SKU of the same product',async()=>{
      await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,offer_id,active) VALUES(202,2,200,20,'20003','SIBLING',1)");
      const mapped=await legacy.mappingsMysql({paged:'1',searchMode:'sku',query:'20001'},2);
      assert.equal(mapped.total,1);assert.equal(mapped.rows[0].ozon_sku,'20001');
      await q("INSERT INTO ozon_stock_snapshots(shop_id,ozon_sku,warehouse_id,warehouse_name,stock_type,present,available) VALUES(20,'20001','fbp','FBP','fbp_real',2,2),(20,'20003','fbp','FBP','fbp_real',3,3)");
      const stocks=await legacy.stockAlertsMysql({mode:'fbp',paged:'1',searchMode:'sku',query:'20001'},2);
      assert.equal(stocks.total,1);assert.equal(stocks.rows[0].ozon_sku,'20001');
    });
    await t.test('FBP requests combine product filters with status and shop before paging',async()=>{
      await legacy.fbpReplenishmentOrdersMysql({pageSize:1},2);
      await q("INSERT INTO fbp_replenishment_orders(id,order_no,shop_id,status) VALUES(200,'A-FBP',20,'draft'),(201,'A-FBP-RED',20,'sent'),(300,'B-FBP',30,'draft')");
      await q("INSERT INTO fbp_replenishment_order_items(order_id,shop_id,product_id,mapping_id,ozon_sku,requested_qty) VALUES(200,20,200,200,'20001',5),(201,20,201,201,'20002',5),(300,30,300,300,'30001',5)");
      const found=await legacy.fbpReplenishmentOrdersMysql({searchMode:'sku',query:'20001',color:'黑色',status:'draft',pageSize:1},2);
      assert.equal(found.total,1);assert.equal(Number(found.rows[0].id),200);
      assert.equal((await legacy.fbpReplenishmentOrdersMysql({searchMode:'sku',query:'20001',status:'sent'},2)).total,0);
      assert.equal((await legacy.fbpReplenishmentOrdersMysql({searchMode:'sku',query:'30001'},2)).total,0);
    });
    await t.test('hidden products keep structured search and cannot expose another enterprise',async()=>{
      await q('UPDATE products SET active=0 WHERE id IN (200,300)');
      const found=await legacy.hiddenProductsMysql({paged:'1',searchMode:'sku',query:'20001',color:'黑色'},2);
      assert.equal(found.total,1);assert.equal(Number(found.rows[0].id),200);
      const foreign=await legacy.hiddenProductsMysql({paged:'1',searchMode:'sku',query:'30001'},2);assert.equal(foreign.total,0);
    });
  } finally {await closeMysqlPool();await f.cleanup();}
});
