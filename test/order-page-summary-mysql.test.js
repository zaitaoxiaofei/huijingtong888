import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import test from 'node:test';
import mysql from 'mysql2/promise';
import {loadOrderInventoryAvailability} from '../src/services/mysql-order-inventory-availability.js';
import {createOrderFixtureSchema,loadTenantOrderService} from './helpers/tenant-order-service.js';
const socketPath=process.env.TENANT_TEST_MYSQL_SOCKET;
test('order page summary keeps profit, quantities, kit stock and tenant ownership while details stay lazy',{skip:!socketPath&&'Requires isolated MySQL socket'},async t=>{
 const database='ozon_page_summary_'+randomBytes(8).toString('hex');
 const c=await mysql.createConnection({socketPath,user:'root',dateStrings:true});let created=false;
 try{
  assert.equal(Number((await c.query('SELECT @@skip_networking isolated'))[0][0].isolated),1);
  await c.query('CREATE DATABASE `'+database+'`');created=true;await c.changeUser({database});await createOrderFixtureSchema(c);
  const {service,query,calls}=loadTenantOrderService(c);
  await query("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','active')");
  await query("INSERT INTO shops(id,tenant_id,name) VALUES(20,2,'A'),(30,3,'B')");
  await query("INSERT INTO people(id,name) VALUES(2,'Buyer A'),(3,'Secret B')");
  await query("INSERT INTO tenant_members(tenant_id,person_id,role) VALUES(2,2,'member'),(3,3,'member')");
  await query("INSERT INTO products(id,tenant_id,name,code) VALUES(20,2,'Direct','P-20'),(21,2,'Kit','P-21'),(22,2,'Shared part','P-22'),(23,2,'Other part','P-23'),(24,2,'Recipe parent','P-24'),(30,3,'Secret B','P-30')");
  await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku) VALUES(20,2,20,20,'old-sku'),(21,2,20,21,'sku'),(22,2,20,22,'part'),(24,2,20,24,'recipe'),(30,3,30,30,'sku')");
  await query("INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,21,22,2),(2,21,23,1)");
  await query("INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active,mode) VALUES(1,20,'recipe',1,'combo')");
  await query("INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES(1,22,1),(1,23,2)");
  await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(1,20,'DIRECT','awaiting_packaging','2026-11-01'),(2,20,'KIT','awaiting_packaging','2026-11-01'),(3,20,'RECIPE','awaiting_deliver','2026-11-01'),(4,20,'POISONED','awaiting_packaging','2026-11-01'),(30,30,'SECRET','awaiting_packaging','2026-11-01')");
  await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price,estimated_profit) VALUES(1,1,20,'sku',1,10,7),(2,2,NULL,'sku',2,15,11),(3,3,24,'recipe',3,20,13),(4,4,30,'part',1,12,8),(30,30,30,'sku',1,999,900)");
  await query("INSERT INTO inventory_movements(tenant_id,product_id,source_type,source_ref,quantity_delta,status,stock_location) VALUES(2,20,'manual_adjustment','a',8,'posted','LOCAL'),(2,22,'manual_adjustment','b',12,'posted','LOCAL'),(2,23,'manual_adjustment','c',6,'posted','LOCAL'),(2,22,'manual_adjustment','fbp',100,'posted','FBP'),(3,22,'manual_adjustment','poison',999,'posted','LOCAL')");
  await query("INSERT INTO purchase_orders(id,tenant_id,order_no,created_by_person_id,purchased_at) VALUES(1,2,'PO-A',2,'2026-10-31')");
  await query("INSERT INTO inbound_records(tenant_id,product_id,person_id,quantity,amount,purchase_order_id,status) VALUES(2,22,2,4,20,1,'pending_arrival'),(2,22,2,100,500,1,'approved')");
  const payload=JSON.stringify({raw:{delivery_method:{name:'CEL'},note:'测试'.repeat(30000)}});
 await query('INSERT INTO ozon_orders_raw(store_id,posting_number,raw_json) VALUES(?,?,?),(?,?,?)',[20,'DIRECT',payload,30,'SECRET',JSON.stringify({secret:true})]);
 const ids=[1,2,3,4,30];const full=await service.orderRowsByIdsMysql(ids,null,'2');const compact=await service.orderRowsByIdsMysql(ids,null,'2',{summaryOnly:true});
  await t.test('only deferred fields disappear; numeric profit and procurement summaries remain identical',()=>{
   assert.deepEqual(Array.from(compact,row=>row.id),[1,2,3,4]);
   for(const row of compact){const old=full.find(x=>x.id===row.id);for(const key of Object.keys(row))assert.deepEqual(row[key],old[key],`${row.id}.${key}`);assert.equal('profit_purchase_cost' in row,false);assert.equal('procurement_person_name' in row,false);}
   assert.equal(Number(compact[0].revenue),10);assert.equal(Number(compact[0].estimated_profit),7);assert.equal(Number(compact[0].total_quantity),1);
   assert.equal(full[0].profit_purchase_cost,'0.0000');assert.equal(compact[0].raw_json,payload);assert.equal(compact[1].raw_json,null);
  });
  await t.test('explicit binding wins, fallback works, foreign binding cannot reveal another tenant',()=>{
   assert.equal(compact[0].product_ids,'20');assert.equal(compact[1].product_ids,'21');assert.equal(compact[3].product_ids,'22');assert.ok(!JSON.stringify(compact).includes('Secret B'));
   assert.match(compact[1].sku_stock_summaries,/sku:0:0:6/);assert.match(compact[2].sku_stock_summaries,/recipe:0:0:3/);
   assert.equal(Number(compact[1].procurement_product_incoming_quantity),4);
  });
  await t.test('real availability SQL finds all shared-component orders without following a poisoned binding',async()=>{
   const loads=[];
   const result=await loadOrderInventoryAvailability({query,loadBalances:async(productIds,tenant,legacy,fresh)=>{
    loads.push({ids:Array.from(productIds),tenant,legacy,fresh});
    return new Map(productIds.map(id=>[id,{physical_stock:id===22?12:6,available_stock:0}]));
   }},{orderIds:'1,2,3,4',productId:'22',refresh:'1'},{tenantId:2,defaultTenantId:1});
   assert.deepEqual(result.rows.map(row=>row.order_id),[2,3,4]);assert.deepEqual(result.rows[0].inventory_availability.map(fact=>fact.product_id),[22,23]);
   assert.deepEqual(loads,[{ids:[22,23],tenant:2,legacy:false,fresh:true}]);
   await assert.rejects(loadOrderInventoryAvailability({query,loadBalances:async()=>{throw Error('Must not read balances');}},{orderIds:'1,30',productId:'22'},{tenantId:2,defaultTenantId:1}),{statusCode:404});
  });
  await t.test('inventory sorting uses the same single mapping as displayed rows',async()=>{
   const sorted=await service.orderInventorySortRowsMysql(ids,'2');
   for(const row of sorted){const shown=compact.find(item=>item.id===row.id);assert.equal(row.product_codes,shown.product_codes);assert.equal(row.inventory_ids,shown.inventory_ids);}
   assert.equal(sorted.find(row=>row.id===1).product_codes,'P-20');
  });
  await t.test('query resolves mappings once, removes optional people joins and narrows purchase history',()=>{
   const sql=calls.filter(call=>call.sql.includes('WITH scoped_order_items')).at(-1).sql;
   assert.match(sql,/NULL AS raw_json/);assert.doesNotMatch(sql,/JOIN ozon_orders_raw raw/);
   assert.doesNotMatch(sql,/sm\.id = oi\.sku_mapping_id OR/);assert.match(sql,/SELECT DISTINCT oi\.id AS order_item_id/);assert.match(sql,/sm\.id = page_item\.mapping_id/);
   assert.doesNotMatch(sql,/JOIN people (pe|creator|pr_person|pr_creator|mark_creator|request_person|request_creator) /);assert.match(sql,/AND ir.status = 'pending_arrival'/);
  });
 }finally{if(created)await c.query('DROP DATABASE `'+database+'`');await c.end();}
});
