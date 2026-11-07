import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('reviewed procurement cancellation survives SQL refresh without changing fulfillment or stock',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated MySQL',timeout:180000
},async()=>{
  const f=await createTenantMysqlFixture('demand_cancel');f.useEnvironment();const q=f.query;
  const api=await import('../src/services/mysql-cutover.js');
  const {closeMysqlPool}=await import('../src/mysql-pool.js');
  const {createProcurementDemandDetails}=await import('../src/services/procurement-demand-details.js');
  const {createProcurementDemandCancellation}=await import('../src/services/procurement-demand-cancellation.js');
  const buyer={personId:2,tenant:{id:2,slug:'a'}},foreign={personId:3,tenant:{id:3,slug:'b'}};
  const details=createProcurementDemandDetails(),cancel=createProcurementDemandCancellation();
  try{
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name,role) VALUES(2,'Buyer','procurement'),(3,'Foreign buyer','procurement')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,2,'member',JSON_ARRAY('procurement'),1),(3,3,'member',JSON_ARRAY('procurement'),1)");
    await api.prepareInventoryFlowMysql();
    await q('CREATE TABLE inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
    await api.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
    await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A shop','active'),(30,3,'B shop','active')");
    await q("INSERT INTO products(id,tenant_id,name,owner_person_id) VALUES(200,2,'Cancellation stock',2),(300,3,'Foreign stock',3)");
    await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(200,2,200,20,'SKU200',1),(300,3,300,30,'SKU300',1)");
    await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(11,20,'CANCEL-SOURCE','awaiting_packaging',UTC_TIMESTAMP()),(12,20,'OTHER-SOURCE','awaiting_packaging',UTC_TIMESTAMP())");
    await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(11,11,'SKU200',200,3),(12,12,'SKU200',200,2)");
    await api.refreshProcurementDemandMysql(2,{session:buyer});
    const before=await details.details(200,buyer),stock=await q('SELECT * FROM inventory_movements');
    assert.equal(before.state.supply_plan.required_fbs,5);
    const body={product_id:200,order_item_ids:[11],cause:'supplier_out_of_stock',note:'厂家断货，运营另行处理订单',request_key:randomUUID(),expected_revision:before.cancellation_revision};
    const saved=await cancel(body,buyer);assert.equal(saved.state.supply_plan.required_fbs,2);assert.equal(saved.state.supply_plan.cancelled_fbs,3);
    assert.equal((await cancel(body,buyer)).duplicate,true);
    await assert.rejects(cancel({...body,request_key:randomUUID()},foreign),{statusCode:404});
    for(let i=0;i<2;i++)await api.refreshProcurementDemandMysql(2,{session:buyer});
    const current=await details.details(200,buyer);
    assert.equal(current.orders.find(row=>row.order_item_id===11).shortage_quantity,3);
    assert.equal(current.orders.find(row=>row.order_item_id===11).cancelled_purchase_quantity,3);
    assert.equal(current.state.supply_plan.required_fbs,2);
    assert.equal((await q("SELECT COUNT(*) n FROM procurement_requests WHERE product_id=200 AND source_order_item_id=11 AND status IN('pending','suggested','submitted')"))[0].n,0);
    assert.deepEqual(await q('SELECT * FROM inventory_movements'),stock);
    assert.ok((await q('SELECT status FROM orders')).every(row=>row.status==='awaiting_packaging'));
    assert.equal((await q('SELECT COUNT(*) n FROM purchase_orders'))[0].n,0);
    await cancel({...body,operation:'restore',note:'运营已确认继续采购',request_key:randomUUID(),expected_revision:current.cancellation_revision},buyer);
    await api.refreshProcurementDemandMysql(2,{session:buyer});
    assert.equal((await details.details(200,buyer)).state.supply_plan.required_fbs,5);
    assert.ok((await q("SELECT id FROM procurement_requests WHERE product_id=200 AND source_order_item_id=11 AND status='suggested'")).length>0);
    // No refresh/request materialization precedes this purchase of another source.
    await q("INSERT INTO products(id,tenant_id,name,owner_person_id) VALUES(201,2,'New source stock',2)");
    await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(201,2,201,20,'SKU201',1)");
    await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(13,20,'OLDER-CANCELLED','awaiting_packaging',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR)),(14,20,'NEWER-ACTIVE','awaiting_packaging',UTC_TIMESTAMP())");
    await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(13,13,'SKU201',201,3),(14,14,'SKU201',201,2)");
    const fresh=await details.details(201,buyer);
    await cancel({...body,product_id:201,order_item_ids:[13],request_key:randomUUID(),expected_revision:fresh.cancellation_revision},buyer);
    const bought=await api.recordProcurementPurchaseMysql({workspace_batch:true,request_key:randomUUID(),person_id:2,
      items:[{product_id:201,quantity:2,actual_quantity:2,amount:20,shipping_amount:0,purchase_mode:'shortage_purchase'}]},2,2);
    const allocations=await q('SELECT a.order_item_id,a.allocated_quantity FROM procurement_order_allocations a JOIN procurement_requests r ON r.id=a.procurement_request_id WHERE r.purchase_order_id=?',[bought.purchase_order_id]);
    assert.deepEqual(allocations.map(row=>[Number(row.order_item_id),Number(row.allocated_quantity)]),[[14,2]]);
    const afterPurchase=await details.details(201,buyer);
    assert.equal(afterPurchase.orders.find(row=>row.order_item_id===14).shortage_quantity,0);
    assert.equal(afterPurchase.orders.find(row=>row.order_item_id===13).shortage_quantity,3);
    assert.equal(afterPurchase.state.supply_plan.required_fbs,0);
    assert.equal(afterPurchase.state.supply_plan.cancelled_fbs,3);
    // Sales SKU sets and physical children use different units. The allocation
    // must preserve all six purchased children for the active two-set order.
    await q("INSERT INTO products(id,tenant_id,name,owner_person_id) VALUES(202,2,'Physical BOM child',2),(220,2,'BOM parent',2)");
    await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,220,202,3)');
    await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(220,2,220,20,'BOM220',1)");
    await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(15,20,'BOM-OLDER-CANCELLED','awaiting_packaging',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR)),(16,20,'BOM-NEWER-ACTIVE','awaiting_packaging',UTC_TIMESTAMP())");
    await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(15,15,'BOM220',220,1),(16,16,'BOM220',220,2)");
    const bom=await details.details(202,buyer);assert.equal(bom.state.supply_plan.required_fbs,9);
    await cancel({...body,product_id:202,order_item_ids:[15],request_key:randomUUID(),expected_revision:bom.cancellation_revision},buyer);
    const bomBought=await api.recordProcurementPurchaseMysql({workspace_batch:true,request_key:randomUUID(),person_id:2,
      items:[{product_id:202,quantity:6,actual_quantity:6,amount:60,shipping_amount:0,purchase_mode:'shortage_purchase'}]},2,2);
    const bomAllocations=await q('SELECT a.order_item_id,a.allocated_quantity FROM procurement_order_allocations a JOIN procurement_requests r ON r.id=a.procurement_request_id WHERE r.purchase_order_id=?',[bomBought.purchase_order_id]);
    assert.deepEqual(bomAllocations.map(row=>[Number(row.order_item_id),Number(row.allocated_quantity)]),[[16,6]]);
    const afterBom=await details.details(202,buyer);
    assert.equal(afterBom.orders.find(row=>row.order_item_id===16).shortage_quantity,0);
    assert.equal(afterBom.orders.find(row=>row.order_item_id===16).incoming_quantity,6);
    assert.equal(afterBom.orders.find(row=>row.order_item_id===15).shortage_quantity,3);
    assert.equal(afterBom.state.supply_plan.cancelled_fbs,3);
    assert.equal(afterBom.state.supply_plan.required_fbs,0);
    await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
    await assert.rejects(cancel({...body,request_key:randomUUID()},buyer),{statusCode:403});
  }finally{await closeMysqlPool();await f.cleanup();}
});
