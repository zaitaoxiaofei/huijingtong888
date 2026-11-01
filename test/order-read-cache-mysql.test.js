import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {createOrderFixtureSchema,loadTenantOrderService} from './helpers/tenant-order-service.js';
import {cachedOrderRead,invalidateOrderReadCache} from '../src/services/order-read-cache.js';
import {invalidateInventoryWorkflow} from '../src/services/inventory-workflow-cache.js';

test('real summary cache invalidates on order marks and inventory changes, preserves clones and enterprise ownership',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:120000
},async()=>{
 const f=await createTenantMysqlFixture('order_read_cache');
 try{
  await createOrderFixtureSchema(f.connection);invalidateOrderReadCache();
  const {service,query,calls}=loadTenantOrderService(f.connection,{cachedOrderRead,invalidateOrderReadCache});
  await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await query("INSERT INTO shops(id,tenant_id,name) VALUES(20,2,'Shop A'),(30,3,'Shop B')");
  await query("INSERT INTO products(id,tenant_id,name,code) VALUES(20,2,'A part','P-20')");
  await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,ozon_sku,product_id) VALUES(20,2,20,'same-sku',20)");
  await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(1,20,'CACHE-1','awaiting_packaging','2026-11-01')");
  await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(1,1,20,'same-sku',1,100)");
  const rows=tenant=>service.orderRowsByIdsMysql([1],null,tenant,{summaryOnly:true});
  const summaries=()=>calls.filter(call=>call.sql.includes('WITH scoped_order_items')).length;
  const first=await rows('2');first[0].shop_name='must not leak into cached object';
  assert.equal((await rows('2'))[0].shop_name,'Shop A');assert.equal(summaries(),1);
  await service.updateOrderMarkMysql(1,{mark_type:'follow',note:'review'},null,'2');
  assert.equal((await rows('2'))[0].mark_type,'follow');assert.equal(summaries(),2);
  await query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type) VALUES(2,20,11,'opening_stock')");
  invalidateInventoryWorkflow({tenantId:2,productIds:[20]});
  assert.match((await rows('2'))[0].sku_stock_summaries,/:0:0:11/);assert.equal(summaries(),3);
  const printed=await service.markOrderLabelsPrintedMysql({order_ids:[1]},null,'2');
  assert.equal((await rows('2'))[0].print_batch_id,printed.print_batch_id);
  await service.removeFailedOrderLabelPrintBatchMysql({print_batch_id:printed.print_batch_id},null,'2');
  assert.equal((await rows('2'))[0].printed_at,null);
  assert.equal((await rows('3')).length,0);
  assert.equal((await rows('2'))[0].shop_name,'Shop A');
 }finally{invalidateOrderReadCache();await f.cleanup();}
});
