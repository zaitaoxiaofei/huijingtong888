import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {inspectWarehouseRepair,applyWarehouseRepair} from '../scripts/lib/reviewed-warehouse-location.mjs';
test('reviewed warehouse repair preserves amounts, balances and holds; reruns are idempotent and stale evidence rolls back',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async()=>{
 const f=await createTenantMysqlFixture('warehouse_review');
 try{
  const q=f.query,db=f.connection;
  await q("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'foreign','Foreign','active')");
  await q("INSERT INTO products(id,tenant_id,name,code,purchase_cost) VALUES(1,1,'Domestic receipt','W1',3),(2,1,'FBP cancellation','W2',5),(3,2,'Foreign','W3',999)");
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(1,1,'Owned','active'),(2,2,'Foreign','active')");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(10,1,'POST-10','cancelled','2026-06-01')");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price) VALUES(10,10,'SKU10',1,30)");
  await q("INSERT INTO ozon_orders_raw(store_id,posting_number,raw_json) VALUES(1,'POST-10',JSON_OBJECT('raw',JSON_OBJECT('delivery_method',JSON_OBJECT('warehouse','CEL Hunchun 2','name','CEL FBP Standard','tpl_provider','CEL'))))");
  await q("INSERT INTO inbound_records(id,tenant_id,product_id,quantity,amount,status) VALUES(1,1,1,4,12,'approved')");
  await q("INSERT INTO inventory_movements(id,tenant_id,product_id,shop_id,source_type,source_ref,quantity_delta,unit_cost,amount,status,stock_location,stock_location_source,related_order_item_id) VALUES(1,1,1,NULL,'purchase_inbound','inbound_1',4,3,12,'posted','UNKNOWN','legacy_unknown',NULL),(2,1,2,1,'return_in','cancel_10',1,5,5,'posted','UNKNOWN','legacy_unknown',10),(3,1,2,NULL,'manual_adjustment','hold',2,0,0,'posted','UNKNOWN','legacy_unknown',NULL),(4,2,3,NULL,'purchase_inbound','foreign',99,999,999,'posted','UNKNOWN','legacy_unknown',NULL)");
  await q("INSERT INTO inventory_current(real_product_id,available_stock,reserved_stock,damaged_stock,in_transit_stock) VALUES(1,4,0,0,0),(2,3,0,0,0)");
  const entries=(await q('SELECT id,product_id,source_type,source_ref,quantity_delta,unit_cost,amount FROM inventory_movements WHERE id IN(1,2) ORDER BY id')).map(r=>({...r,target:r.id===1?'LOCAL':'FBP',basis:r.id===1?'purchase_receipt':'order_raw',...(r.id===1?{inbound_id:1}:{order_item_id:10})}));
  const plan={tenant_id:1,entries,protected_ids:[3]};
  assert.equal((await inspectWarehouseRepair(db,plan)).changes.length,2);
  await q("UPDATE inbound_records SET quantity=5 WHERE id=1");
  await assert.rejects(applyWarehouseRepair(db,plan),/Receipt evidence changed/);
  assert.equal((await q('SELECT stock_location FROM inventory_movements WHERE id=1'))[0].stock_location,'UNKNOWN');
  await q("UPDATE inbound_records SET quantity=4 WHERE id=1");
  const wrong=structuredClone(plan);wrong.entries[1].target='LOCAL';
  await assert.rejects(applyWarehouseRepair(db,wrong),/Raw warehouse evidence changed/);
  await q("INSERT INTO inventory_movements(id,tenant_id,product_id,shop_id,source_type,source_ref,quantity_delta,status,stock_location,stock_location_source,related_order_item_id) VALUES(5,1,2,1,'return_in','cancel_10_2',1,'posted','FBP','order_warehouse_rule',10)");
  await assert.rejects(applyWarehouseRepair(db,plan),/Duplicate cancellation restoration/);
  await q('DELETE FROM inventory_movements WHERE id=5');
  const wrongTenant=structuredClone(plan);wrongTenant.tenant_id=2;
  await assert.rejects(applyWarehouseRepair(db,wrongTenant),/ownership or coverage/);
  const result=await applyWarehouseRepair(db,plan);assert.equal(result.changed,2);assert.equal(result.protected_count,1);
  assert.deepEqual((await q('SELECT id,stock_location FROM inventory_movements ORDER BY id')).map(r=>[r.id,r.stock_location]),[[1,'LOCAL'],[2,'FBP'],[3,'UNKNOWN'],[4,'UNKNOWN']]);
  const again=await applyWarehouseRepair(db,plan);assert.equal(again.changed,0);assert.equal(again.already,2);assert.equal(again.current_digest,result.current_digest);assert.equal(again.protected_digest,result.protected_digest);
 }finally{await f.cleanup();}
});
