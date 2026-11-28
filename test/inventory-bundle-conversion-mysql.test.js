import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('bundle conversion conserves parts, starts at zero, rejects occupied stock and retries atomically',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('bundle_convert');f.useEnvironment();const q=f.query;
 const legacy=await import('../src/services/mysql-cutover.js'),{closeMysqlPool}=await import('../src/mysql-pool.js');
 const owner={personId:1,tenant:{id:2,slug:'a',role:'member'}},foreign={personId:3,tenant:{id:3,slug:'b',role:'member'}};
 const context=id=>legacy.inventoryBundleConversionContextMysql({product_id:id||200},owner);
 const input=(ctx,action,quantity,batch_id=null)=>({product_id:200,revision:ctx.revision,action,quantity,batch_id,request_key:randomUUID()});
 const stock=async id=>Number((await q("SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_movements WHERE product_id=? AND tenant_id=2 AND status='posted'",[id]))[0].n);
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'Operator','procurement'),(3,'Foreign','procurement')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('procurement'),1),(3,3,'member',JSON_ARRAY('procurement'),1)");
  await legacy.prepareInventoryFlowMysql();
  await q("INSERT INTO products(id,tenant_id,name,inventory_number,purchase_cost) VALUES(200,2,'Kit A','2-200',0),(202,2,'Shared kit B','2-202',0),(210,2,'Child X','2-210',2),(211,2,'Child Y','2-211',3)");
  await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,200,210,2),(2,200,211,1),(2,202,210,1)');
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,source_ref,quantity_delta,stock_location) VALUES(2,210,'opening_stock','test-x',100,'LOCAL'),(2,211,'opening_stock','test-y',80,'LOCAL'),(2,200,'opening_stock','legacy-parent',999,'LOCAL')");
  await t.test('existing parent balances do not invent prepacked stock',async()=>{const c=await context();assert.equal(c.finished_physical,0);assert.equal(c.assemblable,50);assert.equal(c.components[0].unit_cost,undefined);await assert.rejects(legacy.inventoryBundleConversionContextMysql({product_id:200},foreign),{statusCode:404});});
  await t.test('assembly and retry convert once, and shared kits lose access to consumed parts',async()=>{
   const c=await context(),body=input(c,'assemble',30);const results=await Promise.all([legacy.applyInventoryBundleConversionMysql(body,owner),legacy.applyInventoryBundleConversionMysql(body,owner)]);assert.deepEqual(results[0],results[1]);
   const next=await context();assert.equal(next.finished_physical,30);assert.equal(next.finished_available,30);assert.equal(next.assemblable,20);assert.equal(await stock(210),40);assert.equal(await stock(211),50);assert.equal((await context(202)).assemblable,40);
   const capital=await legacy.financeInventoryCapitalMysql({},2);assert.equal(capital.local_inventory_value,440,'assembly transfers asset value into finished stock without losing or duplicating it');
   await assert.rejects(legacy.applyInventoryBundleConversionMysql({...body,quantity:29},owner),/不同内容/);
  });
  await t.test('stale or excessive requests leave both sides unchanged',async()=>{const c=await context();await assert.rejects(legacy.applyInventoryBundleConversionMysql(input(c,'assemble',21),owner),/不足/);await assert.rejects(legacy.applyInventoryBundleConversionMysql({...input(c,'assemble',1),revision:'old'},owner),/已变化/);assert.equal((await context()).finished_physical,30);});
  await t.test('disassembly returns the saved batch BOM with paired cost amounts',async()=>{const c=await context();await legacy.applyInventoryBundleConversionMysql(input(c,'disassemble',5,c.batches[0].id),owner);assert.equal((await context()).finished_physical,25);assert.equal(await stock(210),50);assert.equal(await stock(211),55);const sums=await q("SELECT source_ref,SUM(CASE WHEN quantity_delta>0 THEN amount ELSE -amount END) net FROM inventory_movements WHERE source_type IN ('bundle_assembly','bundle_disassembly') GROUP BY source_ref");assert.ok(sums.every(s=>Number(s.net)===0));});
  await t.test('open orders take finished units first without consuming the same loose parts twice',async()=>{
   await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'Local shop','active')");
   await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(500,2,20,200,'KIT-A',1)");
   await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(500,20,'KIT-ORDER','awaiting_packaging','awaiting_packaging',UTC_TIMESTAMP())");
   await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(501,500,500,'KIT-A',10,20)");
   let c=await context();assert.equal(c.finished_physical,25);assert.equal(c.finished_available,15);assert.equal(c.assemblable,25);
   await legacy.repairOrderOutboundMysql(2);
   c=await context();assert.equal(c.finished_physical,25);assert.equal(c.finished_available,15);assert.equal(await stock(210),50);
   await assert.rejects(legacy.applyInventoryBundleConversionMysql(input(c,'disassemble',16,c.batches[0].id),owner),/不足/);
   const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
   const quantities=await createInventoryWorkflowService({query:q}).localQuantities([200,202,210],2);
   assert.equal(quantities[0].finished_available,15);assert.equal(quantities[0].assemblable_stock,25);assert.equal(quantities[0].maximum_available,40);assert.equal(quantities[1].assemblable_stock,50);
   const availability=await legacy.orderInventoryAvailabilityMysql({orderIds:'500'},2);
   const finishedFact=availability.rows[0].inventory_availability.find(i=>i.product_id===200);assert.equal(finishedFact.physical_stock,25);assert.equal(finishedFact.available_stock,15);

   const {loadOrderProcurementCoverage}=await import('../src/services/mysql-order-procurement-coverage.js');
   let projection=await loadOrderProcurementCoverage(q,'',{tenantId:2,productId:210});
   assert.equal(projection.get(500).items[0].finished_bundle,true);assert.equal(projection.get(500).items[0].quantity,10);
   await q("UPDATE order_items SET quantity=30 WHERE id=501");await legacy.repairOrderOutboundMysql(2);
   c=await context();assert.equal(c.finished_available,0);assert.equal(c.assemblable,20);assert.equal(c.finished_physical,25);
   assert.equal(await stock(210),40);assert.equal(await stock(211),50);
   projection=await loadOrderProcurementCoverage(q,'',{tenantId:2});
   assert.deepEqual(projection.get(500).items.map(i=>[i.product_id,i.quantity]),[[200,25],[210,10],[211,5]]);
   const liveOnly=await loadOrderProcurementCoverage(q,'',{tenantId:2,outboundOnly:true});
   const outboundUnits=coverage=>[...coverage.values()]
     .filter(order=>order.needs_fulfillment&&order.stock_location!=='FBP')
     .flatMap(order=>order.items.map(item=>[order.order_id,item.order_item_id,item.product_id,item.quantity,item.finished_bundle]));
   assert.deepEqual(outboundUnits(liveOnly),outboundUnits(projection));

   await q("UPDATE orders SET status='cancelled',tracking_stage='cancelled' WHERE id=500");
   const repair=await legacy.repairOrderOutboundMysql(2);assert.deepEqual(repair.cancellation_review_required,[]);
   c=await context();assert.equal(c.finished_physical,25);assert.equal(c.finished_available,25);assert.equal(await stock(210),50);assert.equal(await stock(211),55);
   await legacy.repairOrderOutboundMysql(2);assert.equal((await context()).finished_physical,25);assert.equal(await stock(210),50);
  });
  await t.test('assembly transfers this kits existing order reservation to finished units and shipping never re-deducts parts',async()=>{
   await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(502,20,'KIT-ORDER-2','awaiting_packaging','awaiting_packaging',UTC_TIMESTAMP())");
   await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(503,502,500,'KIT-A',30,20)");
   await legacy.repairOrderOutboundMysql(2);
   const before=await context();assert.equal(before.finished_available,0);assert.equal(before.assemblable,20);assert.equal(before.assembly_capacity,25);
   await legacy.applyInventoryBundleConversionMysql(input(before,'assemble',5),owner);
   const after=await context();assert.equal(after.finished_physical,30);assert.equal(after.finished_available,0);assert.equal(await stock(210),40);assert.equal(await stock(211),50);
   const {orderInventoryPickingMysql}=await import('../src/services/order-inventory-picking.js');const picking=await orderInventoryPickingMysql([502],2);assert.equal(picking.get(502).length,1);assert.equal(picking.get(502)[0].finished_bundle,true);assert.equal(picking.get(502)[0].required_quantity,30);
   await q("UPDATE orders SET status='delivered',tracking_stage='delivered',delivered_at=UTC_TIMESTAMP() WHERE id=502");
   await legacy.repairOrderOutboundMysql(2);
   assert.equal((await context()).finished_physical,0);assert.equal(await stock(210),40);assert.equal(await stock(211),50);
   const {loadOrderProcurementCoverage}=await import('../src/services/mysql-order-procurement-coverage.js');const history=await loadOrderProcurementCoverage(q,'',{tenantId:2});assert.equal(history.get(502).items[0].missing_purchase_quantity,0,'finished shipment retains its assembly batch as its recorded source');
  });
  await t.test('a late parent write failure rolls back child consumption and its batch audit',async()=>{
   const c=await context(),beforeX=await stock(210),beforeY=await stock(211),count=await q('SELECT COUNT(*) n FROM inventory_flow_events');
   await f.connection.query("CREATE TRIGGER reject_finished BEFORE INSERT ON inventory_movements FOR EACH ROW BEGIN IF NEW.product_id=200 AND NEW.source_type='bundle_assembly' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='simulated finished write failure'; END IF; END");
   await assert.rejects(legacy.applyInventoryBundleConversionMysql(input(c,'assemble',1),owner),/simulated/);
   assert.equal(await stock(210),beforeX);assert.equal(await stock(211),beforeY);assert.deepEqual(await q('SELECT COUNT(*) n FROM inventory_flow_events'),count);await f.connection.query('DROP TRIGGER reject_finished');
  });
  await t.test('finished batches scope related BOM families while matching full-ledger facts and revisions',async()=>{
   await q("INSERT INTO products(id,tenant_id,name,inventory_number,purchase_cost) VALUES(900,2,'Unrelated kit','2-900',0),(901,2,'Unrelated part','2-901',2)");
   await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,900,901,1)');
   await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,source_ref,quantity_delta,stock_location) VALUES(2,901,'opening_stock','unrelated',10,'LOCAL')");
   const other=await context(900);await legacy.applyInventoryBundleConversionMysql({...input(other,'assemble',2),product_id:900},owner);
   await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(90,2,'Unrelated shop','active')");
   await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(900,2,90,900,'OTHER-KIT',1)");
   await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(900,90,'OTHER-ORDER','awaiting_packaging',UTC_TIMESTAMP())");
   await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(900,900,900,'OTHER-KIT',3,10)");
   const sibling=await context(202);await legacy.applyInventoryBundleConversionMysql({...input(sibling,'assemble',1),product_id:202},owner);
   const c=await context();const ids=[200,...c.components.map(p=>p.product_id)];
   for(const id of ids){const full=await legacy.procurementLedgerMysql({product_id:id,include_fbp:false},2),part=c.components.find(p=>p.product_id===id);assert.equal(part?part.physical_stock:c.finished_physical,full.physical_estimate);assert.equal(part?part.available_stock:c.finished_available,full.available_estimate);if(part)assert.equal(part.revision,full.revision);}
   const {loadOrderProcurementCoverage}=await import('../src/services/mysql-order-procurement-coverage.js');let demandSql='';
   const q2=async(sql,args)=>{if(sql.startsWith('SELECT STRAIGHT_JOIN o.id'))demandSql=sql;return q(sql,args);};
   const projection=await loadOrderProcurementCoverage(q2,'',{tenantId:2,productIds:ids,includeTrace:true,targetedDemands:true});
   assert.ok(demandSql.includes('candidate_items'),'finished history must retain the targeted order scan');
   assert.ok(!projection.inventory_stocks.some(p=>Number(p.product_id)===900||Number(p.product_id)===901),'unrelated finished stock must not force full-tenant coverage');
   assert.ok(projection.inventory_stocks.some(p=>Number(p.product_id)===202),'the shared sibling kit stays inside the scope');
  });
 }finally{await closeMysqlPool();await f.cleanup();}
});
