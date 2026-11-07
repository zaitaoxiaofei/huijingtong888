import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('isolated MySQL keeps an order of 600 intact when 80 arrive and are received',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:180000
},async()=>{
 const f=await createTenantMysqlFixture('partial_arrival');f.useEnvironment();const q=f.query;
 const legacy=await import('../src/services/mysql-cutover.js');
 const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
 const {createProcurementArrivals}=await import('../src/services/procurement-arrivals.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(7,'Buyer','procurement'),(8,'Warehouse','packing')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,7,'member',JSON_ARRAY('procurement'),1),(2,8,'member',JSON_ARRAY('packing'),1)");
  await legacy.prepareInventoryFlowMysql();
  await q('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  await q("INSERT INTO products(id,tenant_id,name) VALUES(200,2,'Partial arrival stock'),(201,2,'Direct partial receipt stock')");
  const buyer={personId:7,roles:['procurement'],tenant:{id:2,slug:'a',role:'member'}},warehouse={...buyer,personId:8,roles:['packing']};
  const arrivals=createProcurementArrivals(),workflow=createInventoryWorkflowService({ledger:legacy.inventoryLedgerMysql,receiveRecords:legacy.batchUpdateInboundRecordsMysql,previewReceipts:legacy.previewInboundReceiptImpactMysql});
  await legacy.recordProcurementPurchaseMysql({items:[{product_id:200,quantity:600,amount:1200,shipping_amount:30}]},7,2);
  const [original]=await q("SELECT *,DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s') AS version_at FROM inbound_records WHERE product_id=200");
  const body={id:original.id,quantity:80,expected_quantity:600,expected_updated_at:original.version_at,note:'第一箱80件到货，其余520件商家后续发出',request_key:randomUUID()};
  const result=await arrivals.confirm(body,buyer);await arrivals.confirm(body,buyer);
  const batches=await q('SELECT * FROM inbound_records WHERE product_id=200 ORDER BY id');assert.equal(batches.length,2);
  assert.equal(Number(batches[0].quantity),80);assert.ok(batches[0].received_at);assert.equal(Number(batches[1].quantity),520);assert.equal(batches[1].received_at,null);assert.equal(Number(result.remaining_inbound_id),Number(batches[1].id));
  const [item]=await q('SELECT actual_quantity,amount,shipping_amount FROM purchase_order_items WHERE id=?',[original.purchase_order_item_id]);
  assert.equal(Number(item.actual_quantity),600);assert.equal(Number(item.amount),1200);assert.equal(Number(item.shipping_amount),30);
  const [header]=await q('SELECT total_quantity,total_amount FROM purchase_orders WHERE id=?',[original.purchase_order_id]);assert.equal(Number(header.total_quantity),600);assert.equal(Number(header.total_amount),1230);
  const zero=await q("SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_movements WHERE product_id=200 AND status='posted'");assert.equal(Number(zero[0].n),0);
  const receipt={product_id:200,receipt_mode:'new_arrival',request_key:randomUUID(),records:[{id:original.id,quantity:80,expected_quantity:80}]};
  const preview=await workflow.previewReceive(receipt,warehouse);await workflow.receive({...receipt,expected_revision:preview.revision},warehouse);
  const pending=await arrivals.list({status:'open',product_id:200},buyer);assert.equal(pending.rows.length,1);assert.equal(Number(pending.rows[0].quantity),520);assert.equal(pending.summary.arrived_quantity,0);assert.equal(pending.summary.open_quantity,520);
  const stock=await q("SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_movements WHERE product_id=200 AND status='posted'");assert.equal(Number(stock[0].n),80);
  assert.equal(Number((await q('SELECT actual_quantity FROM purchase_order_items WHERE id=?',[original.purchase_order_item_id]))[0].actual_quantity),600);
  await legacy.recordProcurementPurchaseMysql({items:[{product_id:201,quantity:600,amount:1200}]},7,2);
  const [direct]=await workflow.receipts(201,warehouse),partial={product_id:201,receipt_mode:'new_arrival',request_key:randomUUID(),records:[{id:direct.id,quantity:80,expected_quantity:600,reason:'分批到货，余量继续待到货'}]};
  const impact=await workflow.previewReceive(partial,warehouse);await workflow.receive({...partial,expected_revision:impact.revision},warehouse);
  const remaining=(await q("SELECT quantity,received_at FROM inbound_records WHERE product_id=201 AND status='pending_arrival'"))[0];assert.equal(Number(remaining.quantity),520);assert.equal(remaining.received_at,null,'direct partial receipt must not leave the unreceived remainder marked arrived');
 }finally{await closeMysqlPool();await f.cleanup();}
});
