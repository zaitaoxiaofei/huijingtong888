import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { loadTenantOrderService } from './helpers/tenant-order-service.js';
import { prepareInventoryNumberingV2Schema, installInventoryNumberingV2Triggers } from '../src/services/inventory-numbering-v2.js';

test('V2 consumers keep old numbers, prefixes, hidden records and enterprise ownership separate', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET,timeout:180000},async t=>{
  const f=await createTenantMysqlFixture('number_consumers');f.useEnvironment();
  const api=await import('../src/services/mysql-cutover.js');
  const {inventoryProductSearch,filterInventoryProductRows}=await import('../src/services/inventory-product-search.js');
  const {resolveInventoryTenantScope,inventoryTenantSql}=await import('../src/services/inventory-tenant-scope.js');
  const {procurementDailyReport}=await import('../src/services/procurement-daily-report.js');
  const {skuOrderTrackingList}=await import('../src/services/sku-order-tracking.js');
  const {closeMysqlPool}=await import('../src/mysql-pool.js');
  const q=f.query;
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(10,1,'Default shop','active'),(20,2,'A shop','active'),(30,3,'B shop','active')");
    await prepareInventoryNumberingV2Schema(f.connection);
    await q('INSERT INTO inventory_numbering_state(id,version) VALUES(1,2) ON DUPLICATE KEY UPDATE version=2');
    await q("INSERT INTO inventory_number_core_categories_v2(id,core_name) VALUES(1,'门槛条')");
    await q("INSERT INTO inventory_number_brands_v2(id,brand_key) VALUES(2,'TENET')");
    await installInventoryNumberingV2Triggers(f.connection);
    await q('SET @inventory_numbering_v2_migration=1');
    await q(`INSERT INTO products(id,tenant_id,name,code,inventory_category,vehicle_brand,fitment_type,vehicle_model,inventory_number,inventory_number_category,inventory_number_brand,inventory_number_sequence,inventory_number_version,active) VALUES
      (200,2,'黑色 门槛条','P-200','门槛条','TENET','specific','T4','1-2-1',1,2,1,2,1),
      (201,2,'隐藏 门槛条','P-201','门槛条','TENET','specific','T4','1-2-2',1,2,2,2,0),
      (202,2,'红色 门槛条','P-202','门槛条','TENET','specific','T4','1-2-10',1,2,10,2,1),
      (300,3,'Foreign','P-300','门槛条','TENET','specific','T4','1-2-11',1,2,11,2,1),
      (400,NULL,'Legacy default','P-400','门槛条','TENET','specific','T4','1-2-12',1,2,12,2,1)`);
    await q('SET @inventory_numbering_v2_migration=0');
    await q("INSERT INTO inventory_number_sequences_v2(category_id,brand_id,last_sequence) VALUES(1,2,12)");
    await q("INSERT INTO inventory_number_aliases(alias_number,product_id,tenant_id) VALUES('99-1',200,2),('99-2',300,3),('99-3',200,3),('99-4',400,1),('99-5',400,2),('99-6',201,2)");
    await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,offer_id,active) VALUES(200,2,20,200,'A-SKU','A-OFFER',1),(201,2,20,201,'HIDDEN-SKU','HIDDEN-OFFER',1),(202,2,20,202,'A-SKU-10','A-OFFER-10',1),(300,3,30,300,'B-SKU','B-OFFER',1),(400,1,10,400,'DEFAULT-SKU','DEFAULT-OFFER',1)");
    await api.prepareInventoryFlowMysql();
    const scope=await resolveInventoryTenantScope(2,q);
    const find=async(query,tenantScope=scope)=>{
      const criteria=inventoryProductSearch(query,tenantScope);
      return (await q(`SELECT p.id FROM products p WHERE p.active=1 AND ${inventoryTenantSql(tenantScope,'p')} AND ${criteria.sql}`,criteria.params)).map(r=>Number(r.id));
    };
    await t.test('new, old and P codes are exact; current category/brand prefixes are explicit',async()=>{
      for(const [query,expected] of [
        [{searchMode:'inventory_id',query:'99-1'},[200]], [{query:'99-1'},[200]],
        [{searchMode:'inventory_id',query:'P-200'},[200]], [{query:'1-2-1'},[200]],
        [{searchMode:'inventory_prefix',query:'1-2'},[200,202]], [{query:'1-2-'},[200,202]],
        [{searchMode:'inventory_prefix',query:'1-2-1'},[200,202]], [{query:'1-2'},[]],
        [{searchMode:'inventory_prefix',query:'1-20'},[]], [{searchMode:'inventory_id',query:'99-6'},[]]
      ]) assert.deepEqual((await find(query)).sort((a,b)=>a-b),expected,JSON.stringify(query));
      const list=await api.productsMysql({paged:'1',view:'inventory',includeStock:'0',searchMode:'inventory_prefix',query:'1-2',sortKey:'inventory_number',sortDir:'asc'},2);
      assert.deepEqual(list.rows.map(r=>Number(r.id)),[200,202]);
    });
    await t.test('foreign, corrupt-ownership and legacy NULL aliases fail closed',async()=>{
      for(const query of ['99-2','99-3','99-4','99-5']) assert.deepEqual(await find({searchMode:'inventory_id',query}),[],query);
      const defaultScope=await resolveInventoryTenantScope('admin',q);
      assert.deepEqual(await find({searchMode:'inventory_id',query:'99-4'},defaultScope),[400]);
      assert.deepEqual(await find({searchMode:'inventory_id',query:'99-5'},defaultScope),[]);
      const hidden=await api.hiddenProductsMysql({paged:'1',searchMode:'inventory_id',query:'99-6'},2);
      assert.deepEqual(hidden.rows.map(r=>Number(r.id)),[201]);
      assert.equal((await api.productsMysql({paged:'1',query:'99-6'},2)).total,0);
      assert.equal((await api.hiddenProductsMysql({paged:'1',query:'99-2'},2)).total,0);
    });
    await t.test('cached alerts resolve old aliases without expanding payloads or bypassing the snapshot',async()=>{
      const rows=[{product_id:200,inventory_number:'1-2-1'},{product_id:202,inventory_number:'1-2-10'}];
      assert.deepEqual(await filterInventoryProductRows(rows,{query:'99-1'},scope,q),[rows[0]]);
      assert.deepEqual(await filterInventoryProductRows(rows,{query:'99-'},scope,q),[rows[0]]);
      assert.deepEqual(await filterInventoryProductRows(rows,{query:'99-6'},scope,q),[]);
      assert.deepEqual(await filterInventoryProductRows([...rows,{product_id:201,inventory_number:'1-2-2'}],{query:'99-6'},scope,q),[]);
      assert.deepEqual(await filterInventoryProductRows(rows,{query:'99-3'},scope,q),[]);
      assert.equal(rows[0].aliases,undefined);
    });
    await t.test('mappings, ledger and procurement exports search aliases but preserve immutable IDs',async()=>{
      const mappings=await api.mappingsMysql({paged:'1',query:'99-1'},2);
      assert.deepEqual(mappings.rows.map(r=>Number(r.product_id)),[200]);
      await q("INSERT INTO inventory_movements(id,tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(1,2,200,'test',5,'posted','LOCAL'),(2,3,300,'test',99,'posted','LOCAL')");
      assert.deepEqual((await api.inventoryMysql({paged:'1',query:'99-1'},2)).rows.map(r=>Number(r.product_id)),[200]);
      assert.equal((await api.inventoryMysql({paged:'1',query:'99-2'},2)).total,0);
      await q("INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at) VALUES(1,2,'PO-A','purchased','2026-11-05 01:00:00'),(2,3,'PO-B','purchased','2026-11-05 01:00:00')");
      await q("INSERT INTO purchase_order_items(id,tenant_id,purchase_order_id,product_id,actual_quantity,amount,status) VALUES(1,2,1,200,5,10,'purchased'),(2,3,2,300,99,999,'purchased')");
      const report=await procurementDailyReport({date:'2026-11-05',query:'99-1'},2,q);
      assert.deepEqual(report.rows.map(r=>Number(r.product_id)),[200]);
      assert.equal((await procurementDailyReport({date:'2026-11-05',query:'99-2'},2,q)).rows.length,0);
      assert.equal((await q('SELECT quantity_delta FROM inventory_movements WHERE id=1'))[0].quantity_delta,5);
    });
    await t.test('order product keyword SQL resolves old aliases without crossing shop/product scope',async()=>{
      await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(1,20,'ORDER-A','awaiting_packaging','2026-11-05'),(2,30,'ORDER-B','awaiting_packaging','2026-11-05')");
      await q("INSERT INTO order_items(order_id,sku_mapping_id,ozon_sku,quantity) VALUES(1,200,'A-SKU',1),(2,300,'B-SKU',1)");
      const {service}=loadTenantOrderService(f.connection);
      const tenantScope=await service.orderListTenantScopeMysql(2);
      for(const [value,expected] of [['99-1',[1]],['99-2',[]],['99-3',[]]]){
        const where=[],params=[];service.addOrderSearchSqlMysql(where,params,{searchType:'product',searchQuery:value},tenantScope);
        assert.equal((where.join(' ').match(/\?/g)||[]).length,params.length);
        const rows=await q(`SELECT o.id FROM orders o JOIN shops s ON s.id=o.shop_id WHERE s.tenant_id=2 AND ${where.join(' AND ')}`,params);
        assert.deepEqual(rows.map(r=>Number(r.id)),expected,value);
      }
    });
    await t.test('SKU tracking honors default legacy aliases and retains the existing customer-enterprise gate',async()=>{
      await q("INSERT INTO online_products(shop_id,ozon_sku,name,archived) VALUES(10,'DEFAULT-SKU','Default listing',0),(20,'A-SKU','A listing',0)");
      const found=await skuOrderTrackingList({skuScope:'all',inventoryKeyword:'99-4'},'admin');
      assert.deepEqual(found.rows.map(r=>String(r.ozon_sku)),['DEFAULT-SKU']);
      assert.equal((await skuOrderTrackingList({skuScope:'all',inventoryKeyword:'99-5'},'admin')).total,0);
      assert.equal((await skuOrderTrackingList({skuScope:'all',inventoryKeyword:'99-1'},2)).total,0);
    });
  } finally {await closeMysqlPool();await f.cleanup();}
});
