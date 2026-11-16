import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('batch stocktakes atomically write physical stock, audit and cost tasks in sets',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('batch_stocktake');f.useEnvironment();const q=f.query;
 const {createInventoryBatchStocktake}=await import('../src/services/inventory-batch-stocktake.js');
 const legacy=await import('../src/services/mysql-cutover.js'),{withMysqlTransaction,closeMysqlPool}=await import('../src/mysql-pool.js');
 let writes=[],onProductLock=null;
 const {ensureProcurementLedgerSchema}=await import('../src/services/procurement-ledger.js');
 const service=createInventoryBatchStocktake({prepare:async()=>{await legacy.prepareInventoryFlowMysql();await ensureProcurementLedgerSchema(sql=>q(sql));},query:q,transaction:fn=>withMysqlTransaction(c=>fn({query:async(sql,args)=>{if(/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))writes.push(sql);if(onProductLock&&sql.includes('SELECT id FROM products p')&&sql.includes('FOR UPDATE'))onProductLock();return c.query(sql,args);}}))});
 const owner={personId:1,tenant:{id:2,slug:'a'}},reader={personId:2,tenant:{id:2,slug:'a'}},foreign={personId:3,tenant:{id:3,slug:'b'}};
 const context=()=>service.context({product_ids:[210,211]},owner);
 const body=ctx=>({request_key:randomUUID(),items:ctx.rows.map(r=>({product_id:r.product_id,revision:r.revision,counted_quantity:0,reason_code:'history_error',reason_note:'仓库实点'}))});
 const counts=async()=> (await q('SELECT (SELECT COUNT(*) FROM inventory_movements) movements,(SELECT COUNT(*) FROM procurement_ledger_actions) actions,(SELECT COUNT(*) FROM procurement_stock_cost_tasks) tasks'))[0];
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'Operator','procurement'),(2,'Reader','packing'),(3,'Foreign','procurement')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('procurement'),1),(2,2,'member',JSON_ARRAY('packing'),1),(3,3,'member',JSON_ARRAY('procurement'),1)");
  await legacy.prepareInventoryFlowMysql();
  await q("INSERT INTO products(id,tenant_id,name,inventory_number,purchase_cost) VALUES(200,2,'Kit','2-200',0),(210,2,'Child A','2-210',2),(211,2,'Child B','2-211',3),(300,3,'Foreign','3-300',9)");
  await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,200,210,1)');
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,movement_type) VALUES(2,210,'opening_stock',-3,'LOCAL','MANUAL_ADJUST'),(2,211,'opening_stock',5,'LOCAL','MANUAL_ADJUST'),(2,210,'fbp_fixture',50,'FBP','PURCHASE_IN')");
  await q("INSERT INTO shops(id,tenant_id,name) VALUES(20,2,'Local orders')");
  await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(500,2,20,210,'batch-child',1)");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(500,20,'BATCH-PENDING','awaiting_packaging','awaiting_packaging',UTC_TIMESTAMP())");
  await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(501,500,500,'batch-child',2,20)");
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,movement_type,related_order_item_id) VALUES(2,210,'order_outbound',-2,'LOCAL','ORDER_SHIPPED',501)");
  await q('INSERT INTO inventory_current(real_product_id,available_stock,reserved_stock,damaged_stock,in_transit_stock) VALUES(210,45,2,3,4),(211,5,7,8,9)');
  await t.test('new batch routes preserve exact enterprise gates and trusted session dispatch',async()=>{
   const {tenantIsolationDecision}=await import('../src/server/tenant-isolation.js');
   const {authorizeApiRequest}=await import('../src/server/authorization.js');
   const {createOperationsRoutes}=await import('../src/server/routes/operations.js');
   for(const slug of ['default','a'])for(const method of ['GET','POST']){
    const session={...owner,roles:['procurement'],tenant:{id:slug==='default'?1:2,slug,role:'member'}};
    const parts=['api','inventory','batch-stocktake'];assert.equal(tenantIsolationDecision(session,parts,method).allowed,true);assert.equal(authorizeApiRequest({_session:session,method},parts).allowed,true);
    const packing={...session,roles:['packing']};assert.equal(authorizeApiRequest({_session:packing,method},parts).allowed,method==='GET');
    assert.equal(tenantIsolationDecision(session,[...parts,'unexpected'],method).allowed,false);
   }
   const calls=[],payload={tenant_id:3,items:[]};const routes=createOperationsRoutes({services:{inventoryBatchStocktakeContext:(p,s)=>calls.push(['read',p,s]),applyInventoryBatchStocktake:(p,s)=>calls.push(['write',p,s])},readJson:async()=>payload});
   await routes['GET /api/inventory/batch-stocktake']({_session:owner},new URL('http://localhost/api/inventory/batch-stocktake?product_ids=210,211'));
   await routes['POST /api/inventory/batch-stocktake']({_session:owner});assert.equal(calls[0][2],owner);assert.equal(calls[1][2],owner);assert.equal(calls[1][1],payload);
  });
  await t.test('one context preserves canonical physical quantities and rejects foreign, deleted or virtual stock',async()=>{
   const ctx=await context();assert.equal(ctx.rows.length,2);assert.equal(ctx.rows[0].physical_estimate,-3);assert.equal(ctx.rows[0].open_order_demand,2);
   for(const row of ctx.rows){const single=await legacy.inventoryLedgerMysql({product_id:row.product_id,include_flow:'local'},2);assert.equal(row.physical_estimate,single.physical_estimate);assert.equal(row.fbp_reserved,single.fbp_reserved);assert.equal(row.purchase_cost,undefined);}
   await assert.rejects(service.context({product_ids:[300]},owner),{statusCode:404});
   await assert.rejects(service.context({product_ids:[200]},owner),/虚拟套装/);
   await assert.rejects(service.context({product_ids:[210]},foreign),{statusCode:404});
   assert.equal((await service.context({product_ids:[210]},reader)).rows.length,1);
  });
  await t.test('late conflict and invalid quantity roll back the entire batch',async()=>{
   const input=body(await context()),before=await counts();input.items[1].revision='stale';
   await assert.rejects(service.apply(input,owner),{statusCode:409});assert.deepEqual(await counts(),before);
   for(const n of [null,-1,0.5,'0']){const v=body(await context());v.items[1].counted_quantity=n;await assert.rejects(service.apply(v,owner));assert.deepEqual(await counts(),before);}
   await assert.rejects(service.apply(body(await context()),reader),{statusCode:403});
  });
  await t.test('one batch writes each table once and concurrent retries cannot duplicate adjustments',async()=>{
   const input=body(await context());writes=[];const results=await Promise.all([service.apply(input,owner),service.apply(input,owner)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].results.length,2);
   assert.equal(writes.filter(s=>s.includes('INSERT INTO inventory_movements')).length,1);
   assert.equal(writes.filter(s=>s.includes('INSERT INTO inventory_current')).length,1);
   assert.equal(writes.filter(s=>s.includes('INSERT INTO procurement_ledger_actions')).length,1);
   const stock=await q('SELECT * FROM inventory_current ORDER BY real_product_id');assert.equal(Number(stock[0].available_stock),48);assert.equal(Number(stock[1].available_stock),0);assert.equal(Number(stock[0].reserved_stock),2);assert.equal(Number(stock[1].damaged_stock),8);assert.equal(Number(stock[1].in_transit_stock),9);
   assert.deepEqual((await context()).rows.map(r=>r.physical_estimate),[0,0]);
   const before=await counts();await assert.rejects(service.apply({...input,items:input.items.map(i=>({...i,counted_quantity:9}))},owner),/不同内容/);assert.deepEqual(await counts(),before);
   await q('UPDATE products SET active=0 WHERE id=210');assert.deepEqual(await service.apply(input,owner),results[0]);await q('UPDATE products SET active=1 WHERE id=210');
  });
  await t.test('a failure after audit insertion rolls back every quantity and audit row',async()=>{
   const input=body(await context()),before=await counts(),stock=await q('SELECT * FROM inventory_current ORDER BY real_product_id');
   await f.connection.query("CREATE TRIGGER reject_second_batch_row BEFORE INSERT ON inventory_movements FOR EACH ROW BEGIN IF NEW.product_id=211 AND NEW.source_type='reconciliation_stocktake' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated late failure';END IF;END");
   try{await assert.rejects(service.apply(input,owner),/isolated late failure/);}finally{await f.connection.query('DROP TRIGGER reject_second_batch_row');}
   assert.deepEqual(await counts(),before);assert.deepEqual(await q('SELECT * FROM inventory_current ORDER BY real_product_id'),stock);
  });
  await t.test('permission revoked while waiting for a stock lock prevents the whole write',async()=>{
   const input=body(await context()),before=await counts();
   await f.connection.beginTransaction();await f.connection.query('SELECT id FROM products WHERE id=210 FOR UPDATE');
   let notify;const waiting=new Promise(r=>notify=r);onProductLock=notify;
   const pending=service.apply(input,owner);const rejected=assert.rejects(pending,{statusCode:403});await waiting;onProductLock=null;
   await f.connection.query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=1");await f.connection.commit();
   try{await rejected;assert.deepEqual(await counts(),before);}finally{await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=1");}
  });
  await t.test('missing purchase reason creates canonical follow-up cost tasks without touching FBP',async()=>{
   const input=body(await context());for(const row of input.items){row.counted_quantity=4;row.reason_code='missing_purchase';}
   await service.apply(input,owner);const tasks=await q('SELECT product_id,quantity FROM procurement_stock_cost_tasks ORDER BY product_id');assert.deepEqual(tasks.map(r=>[Number(r.product_id),Number(r.quantity)]),[[210,4],[211,4]]);
   assert.equal(Number((await q("SELECT SUM(quantity_delta) n FROM inventory_movements WHERE product_id=210 AND stock_location='FBP'"))[0].n),50);
  });
  await t.test('100 stocks have one audit insert, one movement insert and one quantity upsert',async()=>{
   const ids=Array.from({length:100},(_,i)=>1000+i);
   await q(`INSERT INTO products(id,tenant_id,name) VALUES ${ids.map(()=>"(?,2,'Bulk item')").join(',')}`,ids);
   const ctx=await service.context({product_ids:ids},owner);writes=[];await service.apply(body(ctx),owner);
   for(const table of ['procurement_ledger_actions','inventory_movements','inventory_current'])assert.equal(writes.filter(s=>s.includes('INSERT INTO '+table)).length,1);
   assert.equal((await q('SELECT COUNT(*) n FROM inventory_movements WHERE product_id BETWEEN 1000 AND 1099'))[0].n,100);
   t.diagnostic(`100 products: ${writes.length} set-based write statements`);
  });
 }finally{await closeMysqlPool();await f.cleanup();}
});
