import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {WB_SCHEMA} from '../src/services/wb-schema.js';
import {createWbPlatform} from '../src/services/wb-platform.js';
import {createWbProductWorkspace,saveWbProductCard} from '../src/services/wb-product-workspace.js';

const card=(nmID,chrtID)=>({nmID,vendorCode:`SQL-${nmID}`,title:`WB SQL product ${nmID}`,subjectID:3373,subjectName:'Key covers',brand:'Brand',createdAt:'2026-11-12T01:00:00Z',photos:[{big:`https://example.test/${nmID}.jpg`},{big:`https://example.test/${nmID}-detail.jpg`}],dimensions:{length:12,width:8,height:4,weightBrutto:.22},sizes:[{chrtID,skus:[`barcode-${chrtID}`]}]});
const object=value=>typeof value==='string'?JSON.parse(value):value;

test('WB product workspaces persist snapshots, create local inventory and hide records through real tenant-scoped MySQL',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET,timeout:150000
},async t=>{
 const f=await createTenantMysqlFixture('wb_workspace');let pool;
 try{
  const {query}=f;for(const sql of WB_SCHEMA)await query(sql);
  await query("INSERT INTO tenants(id,slug,name,status,shop_limit) VALUES(1,'default','Default','active',10),(2,'a','A','active',10),(3,'b','B','active',10)");
  await query("INSERT INTO people(id,name,active) VALUES(2,'A publisher',1),(3,'B publisher',1)");
  await query("INSERT INTO tenant_members(tenant_id,person_id,role,active) VALUES(2,2,'owner',1),(3,3,'owner',1)");
  await query("INSERT INTO shops(id,tenant_id,name,platform,user_id,status) VALUES(20,2,'WB A','wb',2,'active'),(30,3,'WB B','wb',3,'active')");
  await query("INSERT INTO wb_shop_credentials(shop_id,tenant_id,token,environment,seller_id,checked_at,wb_warehouse_id) VALUES(20,2,'fixture-only','production','seller-a',UTC_TIMESTAMP(),55),(30,3,'fixture-only','production','seller-b',UTC_TIMESTAMP(),66)");
  f.useEnvironment();
  const runtime=await import('../src/services/mysql-cutover.js');await runtime.warmCoreInventoryRuntimeMysql('2');
  pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:f.database,connectionLimit:3});
  const transaction=async work=>{const connection=await pool.getConnection();try{await connection.beginTransaction();const result=await work(connection);await connection.commit();return result;}catch(error){await connection.rollback();throw error;}finally{connection.release();}};
  const remote=[];let inventoryMode='zero',priceMode='valid';
  const request=async(a,service,path,options={})=>{
   remote.push({tenant:Number(a.tenant_id),shop:Number(a.shop_id),service,path,options:structuredClone(options)});
   if(path==='/api/v2/list/goods/filter'){
    if(priceMode==='error')throw Error('simulated prices unavailable');
    return {data:{listGoods:priceMode==='missing'||options.query.offset?[]:[{nmID:100,currencyIsoCode4217:'CNY',discount:0,sizes:[{sizeID:200,price:258,discountedPrice:258}]}]}};
   }
   if(path==='/api/v3/stocks/55'){
    assert.deepEqual(Object.keys(options.body),['chrtIds']);assert.equal(options.method,'POST');
    return {stocks:inventoryMode==='unknown'?[]:options.body.chrtIds.map(chrtId=>({chrtId,amount:0}))};
   }
   if(path==='/content/v2/get/cards/list')return {cards:[card(100,200)]};
   throw Error('Unexpected simulated WB operation: '+path);
  };
  const dependencies={query,transaction,request,actorId:2,createInventoryProduct:runtime.createProductMysql,prepareInventoryProduct:runtime.prepareInventoryProductCreationMysql};
  const service=createWbPlatform(dependencies),a=await service.account(2,20),b=await service.account(3,30);
  const workspace=createWbProductWorkspace({...dependencies,account:service.account,products:service.products,syncProducts:service.syncProducts});
  await saveWbProductCard(query,a,card(100,200));await saveWbProductCard(query,a,card(101,201));await saveWbProductCard(query,b,card(300,400));

  await t.test('JSON snapshot upserts retain existing ERP cache while replacing current platform facts',async()=>{
   const snapshot={price_info:{currency:'CNY',sizes:[{chrt_id:200,price:258}],synced_at:'2026-11-13T01:00:00Z'},stock_info:{warehouse_id:55,synced_at:'2026-11-13T01:00:00Z',sizes:[{chrt_id:200,amount:0}]}};
   await query("UPDATE wb_product_cards SET raw_json=JSON_SET(raw_json,'$._erp_snapshot',CAST(? AS JSON)) WHERE tenant_id=2 AND shop_id=20 AND nm_id=100",[JSON.stringify(snapshot)]);
   await saveWbProductCard(query,a,{...card(100,200),title:'Updated live title',_erp_snapshot:{untrusted:'cannot replace saved cache'}});
   const saved=(await query('SELECT raw_json FROM wb_product_cards WHERE tenant_id=2 AND shop_id=20 AND nm_id=100'))[0];
   assert.equal(object(saved.raw_json).title,'Updated live title');assert.deepEqual(object(saved.raw_json)._erp_snapshot,snapshot);
   const row=(await service.products(2,{shop_id:20})).rows.find(row=>Number(row.nm_id)===100);
   assert.equal(row.fbs_stock,0);assert.equal(row.price_info.sizes[0].price,258);assert.equal(row.card._erp_snapshot,undefined);
  });

  await t.test('snapshot refresh persists known zero, missing stock and price failures without dropping product rows',async()=>{
   const before=object((await query('SELECT raw_json FROM wb_product_cards WHERE tenant_id=3 AND shop_id=30 AND nm_id=300'))[0].raw_json);
   let result=await workspace.refreshProductSnapshots(2,{shop_id:20,nm_id:100});assert.equal(result.rows.length,1);assert.equal(result.rows[0].fbs_stock,0);assert.equal(result.rows[0].price_info.currency,'CNY');assert.ok(result.rows[0].stock_synced_at);
   assert.equal(object((await query('SELECT raw_json FROM wb_product_cards WHERE tenant_id=2 AND shop_id=20 AND nm_id=100'))[0].raw_json)._erp_snapshot.stock_info.sizes[0].amount,0);
   inventoryMode='unknown';priceMode='error';result=await workspace.refreshProductSnapshots(2,{shop_id:20,nm_id:100});
   assert.equal(result.rows.length,1);assert.equal(result.rows[0].fbs_stock,null);assert.equal(result.rows[0].price_info.sizes[0].price,258);assert.match(result.rows[0].price_error,/unavailable/);assert.match(result.rows[0].stock_error,/部分规格/);
   priceMode='missing';result=await workspace.refreshProductSnapshots(2,{shop_id:20,nm_id:100});assert.equal(result.rows[0].price_info,null);assert.match(result.rows[0].price_error,/未返回.*价格/);
   assert.deepEqual(object((await query('SELECT raw_json FROM wb_product_cards WHERE tenant_id=3 AND shop_id=30 AND nm_id=300'))[0].raw_json),before);
   const beforeForeign=remote.length;await assert.rejects(service.refreshProducts(2,{shop_id:30,nm_id:300}),error=>error.statusCode===404);await assert.rejects(service.refreshProducts(2,{shop_id:20,nm_id:300}),error=>error.statusCode===404);assert.equal(remote.length,beforeForeign);
   inventoryMode='zero';priceMode='valid';
  });

  await t.test('actual local product creation and concurrent repeats produce exactly one owned inventory mapping',async()=>{
   const beforeRemote=remote.length,input={shop_id:20,nm_id:100,chrt_id:200};
   const [first,second]=await Promise.all([service.createProductInventory(2,input),service.createProductInventory(2,input)]);
   assert.equal(Number(first.product_id),Number(second.product_id));assert.deepEqual([first.reused,second.reused].sort(),[false,true]);
   const mappings=await query("SELECT * FROM sku_mappings WHERE tenant_id=2 AND shop_id=20 AND ozon_sku='WB-200'");assert.equal(mappings.length,1);assert.equal(Number(mappings[0].product_id),Number(first.product_id));
   const product=(await query('SELECT * FROM products WHERE id=?',[first.product_id]))[0];assert.equal(Number(product.tenant_id),2);assert.equal(product.name,'Updated live title');assert.equal(product.source_platform,'wb');assert.equal(Number(product.package_weight_g),220);assert.equal(Number(product.length_cm),12);assert.equal(Number(product.width_cm),8);assert.equal(Number(product.height_cm),4);assert.equal(Number(product.owner_person_id),2);assert.equal(Number(product.created_by_person_id),2);assert.equal(product.image_url,'https://example.test/100.jpg');
   assert.equal((await query("SELECT COUNT(*) AS count FROM products WHERE tenant_id=2 AND source_platform='wb'"))[0].count,1);assert.equal(remote.length,beforeRemote);
   await assert.rejects(service.createProductInventory(2,{shop_id:30,nm_id:300,chrt_id:400}),error=>error.statusCode===404);await assert.rejects(service.createProductInventory(2,{...input,chrt_id:400}),error=>error.statusCode===404);
  });

  await t.test('actual product insertion rolls back when its subsequent local SKU mapping cannot be stored',async()=>{
   const before=(await query('SELECT COUNT(*) AS count FROM products'))[0].count;
   const failing=createWbPlatform({...dependencies,transaction:work=>transaction(connection=>work(new Proxy(connection,{get(target,key){if(key==='execute')return async(sql,args)=>{if(sql.startsWith('INSERT INTO sku_mappings'))throw Error('simulated mapping failure after product insert');return target.execute(sql,args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}})))});
   await assert.rejects(failing.createProductInventory(2,{shop_id:20,nm_id:101,chrt_id:201}),/simulated mapping failure/);
   assert.equal((await query('SELECT COUNT(*) AS count FROM products'))[0].count,before);assert.equal((await query("SELECT COUNT(*) AS count FROM sku_mappings WHERE shop_id=20 AND ozon_sku='WB-201'"))[0].count,0);
  });

  await t.test('missing online package fields can be supplied for local inventory without modifying the WB card',async()=>{
   const online=card(101,201);online.dimensions={length:null,width:null,height:null,weightBrutto:null};await saveWbProductCard(query,a,online);
   const request={shop_id:20,nm_id:101,chrt_id:201};await assert.rejects(service.createProductInventory(2,request),error=>error.statusCode===409&&error.message.includes('包装'));
   const created=await service.createProductInventory(2,{...request,name:'Manual local package',length_cm:15,width_cm:9,height_cm:5,package_weight_g:330});
   const product=(await query('SELECT * FROM products WHERE id=?',[created.product_id]))[0];assert.equal(product.name,'Manual local package');assert.equal(Number(product.package_weight_g),330);assert.equal(Number(product.length_cm),15);assert.equal(Number(product.width_cm),9);assert.equal(Number(product.height_cm),5);
   const preserved=object((await query('SELECT raw_json FROM wb_product_cards WHERE tenant_id=2 AND shop_id=20 AND nm_id=101'))[0].raw_json);assert.deepEqual(preserved.dimensions,online.dimensions);
  });

  const template=await query("INSERT INTO wb_listing_templates(tenant_id,name,subject_id,category_name,attributes_json,defaults_json) VALUES(2,'SQL template',3373,'汽车钥匙套','[]','{}')");
  const payload={template_id:template.insertId,subject_id:3373,currency:'CNY',variants:[{card:{...card(100,200),sizes:[{price:258,skus:['barcode-200']}]},images:['https://example.test/submitted.jpg']}]};payload.card=payload.variants[0].card;payload.images=payload.variants[0].images;
  const state={createStarted:true,items:[{vendor_code:'SQL-100',nm_id:100,phase:'done'}]};
  for(const [job,status,tenant,shop,person] of [[41,'completed',2,20,2],[42,'processing',2,20,2],[43,'queued',2,20,2],[44,'paused',2,20,2],[45,'completed',3,30,3]])await query("INSERT INTO wb_publish_jobs(id,tenant_id,shop_id,draft_id,draft_revision,person_id,environment,seller_id,review_hash,status,payload_json,state_json) VALUES(?,?,?,?,?,?,'production','seller','fixture',?,?,?)",[job,tenant,shop,job,1,person,status,JSON.stringify(payload),JSON.stringify(state)]);

  await t.test('enriched real SQL joins return human metadata and current online identity without leaking foreign records',async()=>{
   const listed=await service.publishRecords(2),record=listed.rows.find(row=>Number(row.id)===41);assert.equal(listed.rows.length,4);assert.equal(record.shop_name,'WB A');assert.equal(record.publisher_name,'A publisher');assert.equal(record.category_name,'汽车钥匙套');assert.equal(record.products[0].title,'Updated live title');assert.equal(Number(record.products[0].nm_id),100);assert.deepEqual(record.products[0].barcodes,['barcode-200']);assert.equal(record.products[0].score_source,'erp_completeness');
   const beforeRemote=remote.length;await assert.rejects(service.syncPublishRecord(2,{job_id:45}),error=>error.statusCode===404);await assert.rejects(service.deletePublishRecord(2,{job_id:45}),error=>error.statusCode===404);assert.equal(remote.length,beforeRemote);
  });

  await t.test('syncing a record persists online identity and current prices while keeping its frozen submission intact',async()=>{
   const before=(await query('SELECT * FROM wb_publish_jobs WHERE id=41'))[0],result=await service.syncPublishRecord(2,{job_id:41});
   assert.equal(result.ok,true);assert.equal(Number(result.job.products[0].nm_id),100);assert.deepEqual(result.job.products[0].barcodes,['barcode-200']);assert.equal(result.job.products[0].price,258);assert.equal(result.job.products[0].price_source,'online');assert.ok(result.job.products[0].synced_at);
   const after=(await query('SELECT * FROM wb_publish_jobs WHERE id=41'))[0];assert.equal(after.status,before.status);assert.deepEqual(object(after.payload_json),object(before.payload_json));assert.deepEqual(object(after.state_json),object(before.state_json));
  });

  await t.test('soft hiding keeps the frozen publication and task status intact and rejects active or leased work',async()=>{
   const before=(await query('SELECT * FROM wb_publish_jobs WHERE id=41'))[0],beforeRemote=remote.length;
   await service.deletePublishRecord(2,{job_id:41});const after=(await query('SELECT * FROM wb_publish_jobs WHERE id=41'))[0];assert.equal(after.status,before.status);assert.deepEqual(object(after.payload_json),object(before.payload_json));const hidden=object(after.state_json);assert.equal(hidden.record_hidden,true);delete hidden.record_hidden;assert.deepEqual(hidden,object(before.state_json));
   assert.equal((await service.publishRecords(2)).rows.some(row=>Number(row.id)===41),false);assert.equal((await query('SELECT COUNT(*) AS count FROM wb_publish_jobs WHERE id=41'))[0].count,1);
   for(const job_id of [42,43])await assert.rejects(service.deletePublishRecord(2,{job_id}),error=>error.statusCode===409&&error.message.includes('处理中'));
   await query('UPDATE wb_publish_jobs SET lease_until=UTC_TIMESTAMP()+INTERVAL 1 MINUTE WHERE id=44');await assert.rejects(service.deletePublishRecord(2,{job_id:44}),error=>error.statusCode===409&&error.message.includes('后台处理'));
   assert.equal(remote.length,beforeRemote);assert.equal((await query("SELECT COUNT(*) AS count FROM wb_product_cards WHERE shop_id=20 AND nm_id=100"))[0].count,1);
  });
  assert.ok(remote.every(call=>call.tenant===2&&call.shop===20));assert.ok(!remote.some(call=>/upload|barcodes|\/media\/save/.test(call.path)));
 }finally{if(pool)await pool.end();const {closeMysqlPool}=await import('../src/mysql-pool.js');await closeMysqlPool();await f.cleanup();}
});
