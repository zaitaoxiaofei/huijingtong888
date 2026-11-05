import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import mysql from 'mysql2/promise';
import {createOrderFixtureSchema,loadTenantOrderService} from './helpers/tenant-order-service.js';
const socketPath=process.env.TENANT_TEST_MYSQL_SOCKET;
test('mobile printed packing pages keep global inventory order, search, marks and enterprise isolation',{skip:!socketPath&&'Requires isolated MySQL socket'},async()=>{
 const c=await mysql.createConnection({socketPath,user:'root',dateStrings:true});const database='ozon_mobile_pack_'+randomBytes(8).toString('hex');let created=false;
 try{
  assert.equal(Number((await c.query('SELECT @@skip_networking isolated'))[0][0].isolated),1);
  await c.query('CREATE DATABASE `'+database+'`');created=true;await c.changeUser({database});await createOrderFixtureSchema(c);
  for(const sql of ['ALTER TABLE order_label_prints ADD COLUMN print_batch_id VARCHAR(128)','ALTER TABLE order_label_prints ADD COLUMN print_sequence INT'])try{await c.query(sql);}catch(e){if(e.code!=='ER_DUP_FIELDNAME')throw e;}
  const {service,query}=loadTenantOrderService(c,{extraMethods:['sortPagedOrdersMysql','logisticsModeKeyMysql','orderTimestampPagedValueMysql','orderInventoryPagedSortKeyMysql','orderPrintTimestampPagedValueMysql','orderPrintSequencePagedValueMysql']});
  await query("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','active')");
  await query("INSERT INTO shops(id,tenant_id,name) VALUES(20,2,'A'),(30,3,'B')");
  await query("INSERT INTO products(id,tenant_id,name,code,inventory_number) VALUES(20,2,'钥匙壳','P-20','1-2-1'),(21,2,'门槛条','P-21','2-2-10'),(30,3,'Secret','P-30','1-3-1')");
  await query("INSERT INTO inventory_number_aliases(alias_number,product_id,tenant_id) VALUES('1-2',20,2)");
  await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku) VALUES(20,2,20,20,'KEY-A'),(21,2,20,20,'KEY-B'),(22,2,20,21,'SILL'),(30,3,30,30,'KEY-A')");
  for(let id=1;id<=45;id++){
   const mapping=id%3===0?22:id%2===0?20:21,sku=mapping===22?'SILL':mapping===20?'KEY-A':'KEY-B';
   await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,20,?,'awaiting_deliver','2026-11-01')",[id,'ORDER-'+id]);
   await query('INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(?,?,?,?,1,20)',[id,id,mapping,sku]);
   if(id!==45)await query('INSERT INTO order_label_prints(order_id,printed_at,print_batch_id,print_sequence) VALUES(?,?,?,?)',[id,`2026-11-${id%2?'01':'02'} 00:00:00`,'batch-'+id,id]);
  }
  await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(99,30,'SECRET','awaiting_deliver','2026-11-01')");
  await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(99,99,30,'KEY-A',1,20)");
  await query("INSERT INTO order_marks(order_id,mark_type,note) VALUES(1,'issue','暂时缺货，请勿发货')");
  const filters={status:'all',sortMode:'inventory_picking',printFilter:'printed',includeCounts:'0',includeLogisticsOptions:'0',pageSize:20};
  const all=[];for(let page=1;page<=3;page++){const r=await service.ordersPagedMysql({...filters,page},'2');assert.equal(r.total,44);assert.ok(r.rows.length<=20);all.push(...r.rows);}
  assert.equal(new Set(all.map(r=>Number(r.id))).size,44);assert.ok(all.every(r=>Number(r.id)!==99&&Number(r.id)!==45));
  const numbers=all.map(r=>String(r.sku_inventory_numbers).split(':')[1]);assert.deepEqual(numbers,[...numbers].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})));
  assert.equal(all.find(r=>Number(r.id)===1).mark_note,'暂时缺货，请勿发货');assert.ok(all.every(r=>r.printed_at));
  const byId=await service.ordersPagedMysql({...filters,searchType:'product',searchQuery:'1-2'},'2');assert.equal(byId.total,30);assert.ok(byId.rows.every(r=>String(r.sku_inventory_numbers).endsWith(':1-2-1')));
  const bySku=await service.ordersPagedMysql({...filters,searchType:'sku',searchQuery:'KEY-B'},'2');assert.ok(bySku.rows.every(r=>r.skus==='KEY-B'));
  const byOrder=await service.ordersPagedMysql({...filters,searchType:'order',searchQuery:'ORDER-1',searchMatch:'exact'},'2');assert.deepEqual(Array.from(byOrder.rows,r=>Number(r.id)),[1]);
  const unprinted=await service.ordersPagedMysql({...filters,printFilter:'unprinted'},'2');assert.deepEqual(Array.from(unprinted.rows,r=>Number(r.id)),[45]);
 }finally{if(created)await c.query('DROP DATABASE `'+database+'`');await c.end();}
});
