import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('bundle stocktakes use canonical child ledgers atomically with scope, revision and retry protection',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('bundle_stocktake');f.useEnvironment();const q=f.query;
 const legacy=await import('../src/services/mysql-cutover.js'),{closeMysqlPool}=await import('../src/mysql-pool.js');
 const owner={personId:1,tenant:{id:2,slug:'a',role:'member'}},reader={personId:2,tenant:{id:2,slug:'a',role:'member'}},foreign={personId:3,tenant:{id:3,slug:'b',role:'member'}};
 const context=()=>legacy.inventoryBundleContextMysql({product_id:200},owner);
 const body=ctx=>({product_id:200,revision:ctx.revision,request_key:randomUUID(),reason_code:'history_error',reason_note:'逐项清点',items:ctx.components.map(p=>({product_id:p.product_id,revision:p.revision,counted_quantity:p.product_id===210?12:0}))});
 const stock=async id=>Number((await q("SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_movements WHERE product_id=? AND tenant_id=2 AND status='posted'",[id]))[0].n);
 const counts=async()=>({movements:(await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n,actions:(await q('SELECT COUNT(*) n FROM procurement_ledger_actions'))[0].n});
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'Operator','procurement'),(2,'Reader','packing'),(3,'Foreign','procurement')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('procurement'),1),(2,2,'member',JSON_ARRAY('packing'),1),(3,3,'member',JSON_ARRAY('procurement'),1)");
  await legacy.prepareInventoryFlowMysql();
  await q("INSERT INTO products(id,tenant_id,name,inventory_number,purchase_cost) VALUES(200,2,'Kit','2-200',0),(201,2,'Nested kit','2-201',0),(202,2,'Shared kit','2-202',0),(210,2,'Child A','2-210',2),(211,2,'Child B','2-211',3),(300,3,'Foreign','3-300',9)");
  await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,200,201,2),(2,200,210,1),(2,201,210,3),(2,201,211,1),(2,202,210,1)');
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,source_ref,quantity_delta,stock_location) VALUES(2,210,'opening_stock','test-a',10,'LOCAL'),(2,211,'opening_stock','test-b',20,'LOCAL')");
  await t.test('all nested identities, images and merged physical quantities are readable without costs',async()=>{
   const ctx=await legacy.inventoryBundleContextMysql({product_id:200},reader);
   assert.deepEqual(ctx.components.map(c=>[c.product_id,c.per_set_quantity]),[[210,7],[211,2]]);
   assert.equal(ctx.structure.length,4);assert.ok(ctx.structure.some(c=>c.id===201&&c.is_bundle));
   for(const c of ctx.components){assert.ok(c.image_url.includes(`/products/${c.product_id}/image`));assert.ok(c.inventory_number);assert.ok(c.revision);assert.equal(c.purchase_cost,undefined);}
   assert.equal(ctx.components[0].physical_stock,10);assert.equal(ctx.components[1].physical_stock,20);
   await assert.rejects(legacy.inventoryBundleContextMysql({product_id:200},foreign),{statusCode:404});
   await assert.rejects(legacy.applyInventoryBundleStocktakeMysql(body(ctx),reader),{statusCode:403});
  });
  await t.test('late child conflict rolls back earlier child writes and audit rows',async()=>{
   const ctx=await context(),input=body(ctx),current=await legacy.inventoryLedgerMysql({product_id:211,include_flow:'local'},2);
   await legacy.applyInventoryStocktakeMysql({product_id:211,revision:current.revision,request_key:randomUUID(),action_type:'stocktake',stocktake_type:'physical',counted_quantity:30,reason_code:'history_error'},1,2);
   const before=await counts();await assert.rejects(legacy.applyInventoryBundleStocktakeMysql(input,owner),/已变化/);
   assert.equal(await stock(210),10);assert.equal(await stock(211),30);assert.deepEqual(await counts(),before);
  });
  await t.test('complete child IDs and current composition are mandatory; parent direct stocktakes are rejected',async()=>{
   const ctx=await context(),input=body(ctx),before=await counts();
   for(const items of [input.items.slice(0,1),[...input.items,input.items[0]],[{...input.items[0],product_id:300},input.items[1]],[{...input.items[0],product_id:200},input.items[1]],[{...input.items[0],counted_quantity:-1},input.items[1]]])await assert.rejects(legacy.applyInventoryBundleStocktakeMysql({...input,items,request_key:randomUUID()},owner));
   await q('UPDATE product_components SET quantity=2 WHERE product_id=200 AND component_product_id=210');
   await assert.rejects(legacy.applyInventoryBundleStocktakeMysql(input,owner),/组成已经变化/);
   await q('UPDATE product_components SET quantity=1 WHERE product_id=200 AND component_product_id=210');
   const parent=await legacy.inventoryLedgerMysql({product_id:200,include_flow:'local'},2);
   await assert.rejects(legacy.applyInventoryStocktakeMysql({product_id:200,revision:parent.revision,request_key:randomUUID(),action_type:'stocktake',stocktake_type:'physical',counted_quantity:9,reason_code:'history_error'},1,2),/父库存/);
   assert.deepEqual(await counts(),before);
  });
  await t.test('concurrent retries save each physical child once, retain zero, and never post parent stock',async()=>{
   const ctx=await context(),input=body(ctx),results=await Promise.all([legacy.applyInventoryBundleStocktakeMysql(input,owner),legacy.applyInventoryBundleStocktakeMysql(input,owner)]);
   assert.deepEqual(results[0],results[1]);assert.equal(results[0].results.length,2);
   assert.equal(await stock(210),12);assert.equal(await stock(211),0);assert.equal(await stock(200),0);assert.equal(await stock(201),0);assert.equal(await stock(202),0);
   assert.equal((await legacy.inventoryBundleContextMysql({product_id:202},reader)).components[0].physical_stock,12,'shared kits see the same updated child stock');
   await assert.rejects(legacy.applyInventoryBundleStocktakeMysql({...input,items:input.items.map(i=>({...i,counted_quantity:99}))},owner),/不同内容/);
   await q('DELETE FROM product_components WHERE product_id=200');
   assert.deepEqual(await legacy.applyInventoryBundleStocktakeMysql(input,owner),results[0],'successful retry survives later composition changes');
   await q("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=1");
   await assert.rejects(legacy.applyInventoryBundleStocktakeMysql(input,owner),{statusCode:403});
  });
 }finally{await closeMysqlPool();await f.cleanup();}
});
