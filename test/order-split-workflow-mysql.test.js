import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import {randomBytes} from 'node:crypto';
import {createOrderFixtureSchema,loadTenantOrderService,loadOrderProfitWriter} from './helpers/tenant-order-service.js';
import {createOrderSplitService,validateSplitReceipt} from '../src/services/order-split.js';
const socketPath=process.env.TENANT_TEST_MYSQL_SOCKET;
const allocation=[{products:[{order_item_id:20,quantity:1}]},{products:[{order_item_id:20,quantity:1}]}];
const products=q=>[{product_id:100,quantity:q}];
const receipt={parent_posting:{posting_number:'PARENT',products:products(1)},postings:[{posting_number:'CHILD',products:products(1)}]};
test('split receipt accepts a retained parent and checks exact package multiplicity',()=>{
 assert.deepEqual(validateSplitReceipt(receipt,'PARENT',[{products:products(1)},{products:products(1)}]).postings.map(p=>p.posting_number),['PARENT','CHILD']);
 assert.throws(()=>validateSplitReceipt({result:false},'PARENT',allocation),/未返回/);
 assert.throws(()=>validateSplitReceipt({...receipt,postings:[{posting_number:'CHILD',products:products(2)}]},'PARENT',[{products:products(1)},{products:products(1)}]),/不符/);
 const rows=[{posting_number:'A',products:[{product_id:1,quantity:1}]},{posting_number:'B',products:[{product_id:2,quantity:2}]},{posting_number:'C',products:[{product_id:1,quantity:1}]}];
 assert.throws(()=>validateSplitReceipt({parent_posting:{posting_number:'PARENT'},postings:rows},'PARENT',[{products:[{product_id:1,quantity:1}]},{products:[{product_id:2,quantity:1}]},{products:[{product_id:1,quantity:1},{product_id:2,quantity:1}]}]),/不符/);
});
test('split-only SQL workflow never prepares on failure or success and keeps owned idempotent evidence',{skip:!socketPath},async t=>{
 const db='ozon_split_'+randomBytes(8).toString('hex'),c=await mysql.createConnection({socketPath,user:'root',dateStrings:true});
 const query=async(s,p=[])=> (await c.query(s,p))[0],execute=async(s,p=[])=> (await c.execute(s,p))[0];
 try{
  assert.equal(Number((await query('SELECT @@skip_networking AS n'))[0].n),1);await query(`CREATE DATABASE \`${db}\``);await c.changeUser({database:db});await createOrderFixtureSchema(c);
  await query("INSERT INTO tenants(id,slug,name,status) VALUES(2,'a','A','active'),(3,'b','B','active')");
  await query("INSERT INTO people(id,name,role) VALUES(2,'A packer','packing')");
  await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,2,'member',JSON_ARRAY('packing','technical'))");
  await query("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,ozon_api_key) VALUES(20,2,'Own','active','fixture','fixture'),(30,3,'Foreign','active','fixture','fixture')");
  await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(20,20,'PARENT','awaiting_packaging','2026-10-31'),(30,30,'FOREIGN','awaiting_packaging','2026-10-31')");
  await query("INSERT INTO order_items(id,order_id,ozon_sku,ozon_product_id,quantity,sale_price) VALUES(20,20,'S',100,2,10),(30,30,'FOREIGN',200,2,99)");
  let splitCalls=0,imports=0,authorized=true,remote=(number)=>({posting_number:number,status:'awaiting_packaging',items:[{ozon_sku:'S',ozon_product_id:100,quantity:splitCalls?1:2}]}),mutate=async()=>receipt;
  const authorize=async id=>{if(!authorized)throw Object.assign(Error('revoked'),{statusCode:403});const order=(await query('SELECT o.* FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=? AND s.tenant_id=2',[id]))[0];if(!order)throw Object.assign(Error('foreign'),{statusCode:404});return{tenantId:2,shop:{id:20},order,items:await query('SELECT * FROM order_items WHERE order_id=?',[id])};};
  const service=createOrderSplitService({query,execute,authorize,fetchRemote:async(_s,n)=>remote(n),splitRemote:async()=>{splitCalls++;return mutate();},importPostings:async(_ctx,rows)=>{imports++;return rows.map((p,i)=>({id:20+i,posting_number:p.posting_number,status:p.status}));},fetchSiblings:async()=>['PARENT','CHILD'].map(n=>remote(n))});
  const body={order_id:20,client_request_id:'test-split-request',packages:allocation};
  const reset=async()=>{await query('DELETE FROM order_split_operations WHERE tenant_id=2');splitCalls=0;imports=0;authorized=true;remote=n=>({posting_number:n,status:'awaiting_packaging',items:[{ozon_sku:'S',ozon_product_id:100,quantity:splitCalls?1:2}]});mutate=async()=>receipt;};
  const before=await query('SELECT * FROM orders ORDER BY id'),itemsBefore=await query('SELECT * FROM order_items ORDER BY id');
  await t.test('authorization and already-prepared orders cannot become split success',async()=>{
   await reset();await assert.rejects(service({...body,order_id:30},2),/foreign/);remote=()=>({posting_number:'PARENT',status:'awaiting_deliver',items:[]});await assert.rejects(service(body,2),/不在待备货/);assert.equal(splitCalls,0);
  });
  await t.test('vendor rejection leaves order status and quantities unchanged',async()=>{
   await reset();mutate=async()=>{throw Object.assign(Error('expired key'),{statusCode:403});};await assert.rejects(service(body,2),e=>e.message.includes('expired')&&e.validation?.split_retry_safe===true);assert.equal(imports,0);assert.equal((await query('SELECT state FROM order_split_operations'))[0].state,'failed');assert.deepEqual(await query('SELECT * FROM orders ORDER BY id'),before);assert.deepEqual(await query('SELECT * FROM order_items ORDER BY id'),itemsBefore);
  });
  await t.test('confirmed split imports every child but does not prepare, and repeated requests never split twice',async()=>{
   await reset();const result=await service(body,2);assert.equal(result.ok,true);assert.equal(result.prepared,false);assert.deepEqual(result.posting_numbers,['PARENT','CHILD']);await service(body,2);assert.equal(splitCalls,1);assert.deepEqual(await query('SELECT * FROM orders ORDER BY id'),before);assert.deepEqual(await query('SELECT * FROM order_items ORDER BY id'),itemsBefore);
  });
  await t.test('lost response blocks preparation/resubmission and can reconcile authoritative siblings',async()=>{
   await reset();mutate=async()=>{throw Error('network timeout');};await assert.rejects(service(body,2),e=>e.message.includes('timeout')&&e.validation?.split_retry_safe===false);const saved=await service({order_id:20,action:'inspect'},2);assert.equal(saved.request_key,body.client_request_id);assert.deepEqual(saved.packages,allocation);assert.equal(saved.items[0].quantity,2);const result=await service({...body,action:'reconcile'},2);assert.equal(result.ok,true);assert.equal(splitCalls,1);assert.equal(result.prepared,false);
  });
  await t.test('a process interruption can resume stale submitted evidence without repeating the mutation',async()=>{
   await reset();mutate=async()=>{throw Error('network timeout');};await assert.rejects(service(body,2));
   await query("UPDATE order_split_operations SET state='submitting',created_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MINUTE) WHERE tenant_id=2");
   const result=await service({...body,action:'reconcile'},2);assert.equal(result.ok,true);assert.equal(result.prepared,false);assert.equal(splitCalls,1);
  });
  await t.test('false or malformed upstream success never imports or changes local orders',async()=>{
   for(const response of [{result:false},{}, {...receipt,postings:[]}]){await reset();mutate=async()=>response;await assert.rejects(service(body,2),/未返回/);assert.equal(imports,0);assert.equal((await query('SELECT state FROM order_split_operations'))[0].state,'unknown');assert.deepEqual(await query('SELECT * FROM orders ORDER BY id'),before);}
  });
  await t.test('child detail failure retains confirmed receipt for safe read-only retry',async()=>{
   await reset();const old=remote;remote=n=>{if(splitCalls&&n==='CHILD')throw Error('read unavailable');return old(n);};const result=await service(body,2);assert.equal(result.sync_pending,true);assert.equal(result.prepared,false);assert.equal(imports,0);remote=old;assert.equal((await service(body,2)).ok,true);assert.equal(splitCalls,1);
  });
  await t.test('membership revocation after official mutation cannot import private order facts',async()=>{
   await reset();mutate=async()=>{authorized=false;return receipt;};await assert.rejects(service(body,2),/revoked/);assert.equal(imports,0);assert.equal((await query('SELECT state FROM order_split_operations'))[0].state,'confirmed');
  });
  await t.test('changed allocation cannot reuse the same request key and concurrent attempts emit only one mutation',async()=>{
   await reset();await service(body,2);await assert.rejects(service({...body,packages:[...allocation,{products:[]}]},2),/同一拆单/);await reset();const results=await Promise.allSettled([service(body,2),service(body,2)]);assert.equal(splitCalls,1);assert.ok(results.some(r=>r.status==='fulfilled'));
  });
  await t.test('officially removed original SKU becomes an audited zero row once, preserving child and foreign facts',async()=>{
   authorized=true;
   await query("INSERT INTO products(id,tenant_id,name,code) VALUES(20,2,'Own','OWN'),(30,3,'Foreign','FOREIGN')");
   await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,offer_id,person_id) VALUES(22,2,20,20,'MOVED','MOVED',2)");
   await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,ozon_product_id,quantity,sale_price,estimated_profit,settlement_state) VALUES(22,20,22,'MOVED',200,1,30,20,'pending')");
   await query("INSERT INTO order_profit_items(order_item_id,sale_amount_cny,purchase_cost_cny,gross_profit_cny,net_profit_cny,profit_status) VALUES(22,30,10,20,20,'estimated')");
   await query("INSERT INTO outbound_records(product_id,shop_id,order_ref,order_item_id,ozon_sku,quantity,stock_location,status) VALUES(20,20,'PARENT',22,'MOVED',1,'LOCAL','deducted')");
   await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(21,20,'CHILD','awaiting_packaging','2026-10-31')");
   await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,ozon_product_id,quantity,sale_price) VALUES(23,21,22,'MOVED',200,1,30)");
   await query("INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES(20,'CHILD','awaiting_packaging',?)",[JSON.stringify({parent_posting_number:'PARENT',products:[{sku:'MOVED',quantity:1}]})]);
   await query('INSERT INTO inventory_current(real_product_id,available_stock) VALUES(20,9)');
   const writer=loadOrderProfitWriter(c);let compensated=0;
   const {service}=loadTenantOrderService(c,{extraMethods:['reconcileRemovedPostingItemsMysql'],withVersionedOrderProfitWrite:writer.withVersionedOrderProfitWrite,postProductInventoryWithComponentsMysql:async(connection,body,tenant)=>{assert.equal(connection,c);assert.equal(tenant,2);assert.equal(body.quantity_delta,1);compensated++;await execute('UPDATE inventory_current SET available_stock=available_stock+? WHERE real_product_id=?',[body.quantity_delta,body.product_id]);}});
   const original={posting_number:'PARENT',status:'awaiting_packaging',raw:{products:[{sku:'S',quantity:2}]},items:[{ozon_sku:'S',quantity:2}]};
   const options={session:{personId:2,tenant:{id:2,slug:'a'}}};
   const foreignBefore=await query('SELECT * FROM order_items WHERE order_id=30');
   await query("UPDATE ozon_orders_raw SET raw_json=JSON_SET(raw_json,'$.parent_posting_number','UNRELATED') WHERE store_id=20 AND posting_number='CHILD'");
   await service.reconcileRemovedPostingItemsMysql({id:20},original,20,{id:2,defaultTenant:false},options);
   assert.equal(Number((await query('SELECT quantity FROM order_items WHERE id=22'))[0].quantity),1);assert.equal(compensated,0);
   await query("UPDATE ozon_orders_raw SET raw_json=JSON_SET(raw_json,'$.parent_posting_number','PARENT') WHERE store_id=20 AND posting_number='CHILD'");
   await query("UPDATE orders SET status='delivering' WHERE id=20");
   await assert.rejects(service.reconcileRemovedPostingItemsMysql({id:20},original,20,{id:2,defaultTenant:false},options),/发运/);
   assert.equal(Number((await query('SELECT quantity FROM order_items WHERE id=22'))[0].quantity),1);
   assert.equal(compensated,0);
   // Acceptance is still pre-transport; official split evidence can reconcile it.
   await query("UPDATE orders SET status='acceptance_in_progress',tracking_stage='posting_acceptance_in_progress' WHERE id=20");
   await service.reconcileRemovedPostingItemsMysql({id:20},original,20,{id:2,defaultTenant:false},options);
   assert.equal(Number((await query('SELECT quantity FROM order_items WHERE id=22'))[0].quantity),0);
   assert.equal(Number((await query('SELECT net_profit_cny FROM order_profit_items WHERE order_item_id=22'))[0].net_profit_cny),0);
   assert.equal((await query('SELECT formula_version FROM order_profit_calc_state WHERE order_item_id=22'))[0].formula_version,'V1');
   const revisions=await query('SELECT * FROM order_profit_calc_revisions WHERE order_item_id=22 ORDER BY id');
   assert.ok(revisions.length>=2);assert.ok(revisions.some(r=>JSON.parse(r.outputs_json).quantity===1));assert.ok(revisions.some(r=>JSON.parse(r.outputs_json).quantity===0));
   await service.reconcileRemovedPostingItemsMysql({id:20},original,20,{id:2,defaultTenant:false},options);assert.equal(compensated,1);assert.equal(Number((await query('SELECT available_stock FROM inventory_current WHERE real_product_id=20'))[0].available_stock),10);
   assert.deepEqual(await query('SELECT * FROM order_items WHERE order_id=30'),foreignBefore);
   const {service:outbound}=loadTenantOrderService(c,{extraMethods:['syncOutboundForOpenOrdersMysql','orderOutboundSyncScopeMysql'],invalidateOrderProcurementCoverage(){}});
   await outbound.syncOutboundForOpenOrdersMysql({tenantId:'2',order_item_id:22,session:options.session});
   assert.equal(Number((await query('SELECT available_stock FROM inventory_current WHERE real_product_id=20'))[0].available_stock),10,'outbound reconciliation must never resurrect a removed zero row');
   assert.equal((await query('SELECT status FROM outbound_records WHERE order_item_id=22'))[0].status,'split_transferred');
   await query("UPDATE order_items SET quantity=1 WHERE id=22");await query("UPDATE order_profit_items SET is_locked=1,profit_status='accrued' WHERE order_item_id=22");
   await assert.rejects(service.reconcileRemovedPostingItemsMysql({id:20},original,20,{id:2,defaultTenant:false},options),/账单/);assert.equal(Number((await query('SELECT quantity FROM order_items WHERE id=22'))[0].quantity),1);assert.equal(compensated,1);
  });
  await t.test('syncing one exact child reads its official parent and imports child before parent',async()=>{
    const fetched=[],saved=[];
    const {service}=loadTenantOrderService(c,{extraMethods:['syncOzonPostingsByNumberMysql','activeShopForTenantMysql'],
      shopsMysql:async()=>[{id:20,status:'active'}],fetchOzonPostingByNumber:async(shop,number)=>{
        assert.equal(shop.id,20);fetched.push(number);return{posting_number:number,status:'awaiting_packaging',raw:{parent_posting_number:number==='CHILD'?'PARENT':''}};
      },upsertPostingMysql:async(shop,p)=>{assert.equal(shop.id,20);saved.push(p.posting_number);return{inserted:0,updated:1,insertedItems:0};},syncOutboundForOpenOrdersMysql:async()=>{},refreshTenantOrderAnalyticsMysql:async()=>{}
    });
    const result=await service.syncOzonPostingsByNumberMysql({posting_numbers:['CHILD'],shop_id:20},{tenantId:'2',session:{personId:2,tenant:{id:2,slug:'a'}}});
    assert.deepEqual(fetched,['CHILD','PARENT']);assert.deepEqual(saved,['CHILD','PARENT']);assert.equal(result.fetched,2);assert.equal(result.ok,true);
  });
 }finally{await c.query(`DROP DATABASE IF EXISTS \`${db}\``);await c.end();}
});
