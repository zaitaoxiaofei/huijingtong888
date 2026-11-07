import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createSkuTrafficDailyService} from '../src/services/sku-traffic-daily.js';
import {migrateSkuTrafficDaily} from '../scripts/migrate-sku-traffic-daily.mjs';
import {trafficDays,shiftTrafficDate} from '../src/shared/sku-traffic-daily.js';
const socketPath=process.env.TENANT_TEST_MYSQL_SOCKET;
test('daily traffic real MySQL pipeline, atomic refresh, tenant ownership, queue fencing and two-tier retention',{skip:!socketPath,timeout:60000},async t=>{
 const database='ozon_sku_daily_'+randomBytes(8).toString('hex');
 const admin=await mysql.createConnection({socketPath,user:'root'});let pool;
 try{
  const [[network]]=await admin.query('SELECT @@skip_networking disabled');assert.equal(Number(network.disabled),1);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  pool=mysql.createPool({socketPath,user:'root',database,connectionLimit:6,timezone:'Z'});
  const query=async(sql,params=[])=> (await pool.query(sql,params))[0];
  const execute=async(sql,params=[])=> (await pool.execute(sql,params))[0];
  const transaction=async callback=>{const c=await pool.getConnection();try{await c.beginTransaction();const value=await callback(c);await c.commit();return value;}catch(e){await c.rollback();throw e;}finally{c.release();}};
  await query('CREATE TABLE tenants(id BIGINT PRIMARY KEY,slug VARCHAR(80),status VARCHAR(32),subscription_status VARCHAR(32),subscription_expires_at DATETIME)');
  await query('CREATE TABLE shops(id BIGINT PRIMARY KEY,tenant_id BIGINT NULL,name VARCHAR(255),status VARCHAR(32),ozon_client_id VARCHAR(80))');
  await query('CREATE TABLE online_products(shop_id BIGINT,ozon_sku VARCHAR(128) COLLATE utf8mb4_0900_ai_ci,name VARCHAR(255),image_url TEXT,offer_id VARCHAR(255),PRIMARY KEY(shop_id,ozon_sku))');
  await query("INSERT INTO tenants VALUES(1,'default','active','active',NULL),(2,'second','active','active',NULL),(3,'expired','active','expired',NULL)");
  await query("INSERT INTO shops VALUES(11,NULL,'Default shop','active','111111'),(22,2,'Second shop','active','222222'),(33,3,'Expired shop','active','333333')");
  await query("INSERT INTO online_products VALUES(11,'same','Original shared product metadata','https://example.test/image.jpg','offer1'),(22,'same','Other tenant metadata',NULL,'other-offer')");
  await t.test('migration inspects without writes, creates only two additive tables, and refuses a global SKU key',async()=>{
   const before=await migrateSkuTrafficDaily(query);assert.equal(before.ready,false);assert.equal(before.missing_tables.length,2);
   assert.equal((await migrateSkuTrafficDaily(query,{apply:true})).ready,true);
   assert.equal((await migrateSkuTrafficDaily(query,{apply:true})).ready,true);
   await query('ALTER TABLE seller_sku_traffic_daily DROP PRIMARY KEY,ADD PRIMARY KEY(shop_id,date_key,sku)');
   await assert.rejects(migrateSkuTrafficDaily(query,{apply:true}),/incompatible/);
   await query('ALTER TABLE seller_sku_traffic_daily DROP PRIMARY KEY,ADD PRIMARY KEY(tenant_id,shop_id,date_key,sku)');
  });
  const service=createSkuTrafficDailyService({query,execute,transaction});await service.ensureSchema();
  const pipeline=bootstrap=>{
   const child=spawnSync(process.execPath,['test/fixtures/sku-traffic-daily-pipeline.mjs',...(bootstrap?['--bootstrap']:[])],{cwd:new URL('..',import.meta.url).pathname,encoding:'utf8',env:{...process.env,DB_CLIENT:'mysql',DB_HOST:'127.0.0.1',DB_NAME:database,DB_USER:'root',DB_PASSWORD:'',DB_SOCKET_PATH:socketPath}});
   assert.equal(child.status,0,child.stdout+'\n'+child.stderr);return child.stdout;
  };
  pipeline(true);
  await t.test('complete controlled queue publishes daily facts and only one temporary page copy',()=>{const result=JSON.parse(pipeline(false).trim().split('\n').at(-1));assert.equal(result.ok,true);assert.equal(result.duplicateMetricRows,0);});
  const day=trafficDays().at(-1);
  const makeRun=(id,store='111111',count=1)=>({id,store_id:store,daily_traffic:true,status:'success',current_period:{date_from:day,date_to:day},requests:[{source_key:'all_metrics',endpoint_type:'by_sku',page_index:0,status:'success',auto_all_pages:true,limit:100,returned_count:count,snapshot_id:'evidence'}]});
  const reserve=async(id,key='admin',shop=11)=>execute("INSERT INTO seller_sku_traffic_days(tenant_id,shop_id,date_key,status,run_id,requested_at) VALUES(?,?,?,'pending',?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE status='pending',run_id=VALUES(run_id)",[key,shop,day,id]);
  const metric=value=>({sku:'same',raw_data:JSON.stringify({metrics:{total_views:value,pdp_views:3,total_hits_to_cart:1,ordered_units:1}})});
  await t.test('same day replaces once without duplicates and reuses product metadata',async()=>{
   await reserve('refresh');await service.publish(makeRun('refresh'),'admin',[metric(50)]);await service.publish(makeRun('refresh'),'admin',[metric(50)]);
   const rows=await query('SELECT sku,total_views FROM seller_sku_traffic_daily WHERE tenant_id=? AND shop_id=? AND date_key=?',['admin',11,day]);assert.equal(rows.length,1);assert.equal(Number(rows[0].total_views),50);
   const read=await service.read({shop_id:11},'admin');assert.equal(read.rows[0].product_name,'Original shared product metadata');assert.equal(read.rows[0].selected.total_views,'50.0000');assert.equal(read.rows[0].series.length,15);
   const columns=await query("SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='seller_sku_traffic_daily'",[database]);for(const name of ['product_name','image_url','raw_data','response_body'])assert.equal(columns.some(c=>c.name===name),false);
  });
  await t.test('partial pagination, duplicate SKUs and late results preserve the successful day',async()=>{
   await reserve('partial');const r=makeRun('partial');r.requests[0].returned_count=100;assert.equal((await service.publish(r,'admin',[])).published,false);
   await reserve('duplicate');assert.equal((await service.publish(makeRun('duplicate','111111',2),'admin',[metric(1),metric(2)])).published,false);
   await reserve('newer');assert.equal((await service.publish(makeRun('late'),'admin',[metric(0)])).ignored,true);
   const [saved]=await query('SELECT total_views FROM seller_sku_traffic_daily WHERE tenant_id=? AND shop_id=? AND date_key=?',['admin',11,day]);assert.equal(Number(saved.total_views),50);
  });
  await t.test('a write error rolls back the day delete and previous facts survive',async()=>{
   await reserve('rollback');
   const broken=createSkuTrafficDailyService({query,execute,transaction:callback=>transaction(c=>callback(new Proxy(c,{get(target,key){if(key==='query')return async(sql,params)=>{if(sql.startsWith('INSERT INTO seller_sku_traffic_daily'))throw Error('simulated write failure');return target.query(sql,params);};return typeof target[key]==='function'?target[key].bind(target):target[key];}})))});
   await assert.rejects(broken.publish(makeRun('rollback'),'admin',[metric(99)]),/simulated write failure/);
   const [saved]=await query('SELECT total_views FROM seller_sku_traffic_daily WHERE tenant_id=? AND shop_id=? AND date_key=?',['admin',11,day]);assert.equal(Number(saved.total_views),50);
  });
  await t.test('same SKU stays isolated by enterprise and foreign shop requests are rejected',async()=>{
   await reserve('second','2',22);assert.equal((await service.publish(makeRun('second','222222'),'2',[metric(900)])).published,true);
   const second=await service.read({},'2');assert.equal(second.total,1);assert.equal(second.rows[0].product_name,'Other tenant metadata');assert.equal(Number(second.rows[0].selected.total_views),900);
   const first=await service.read({},'admin');assert.equal(Number(first.rows[0].selected.total_views),50);
   await assert.rejects(service.read({shop_id:22},'admin'),e=>e.statusCode===404);await assert.rejects(service.queue({shop_id:22},'admin',{}),e=>e.statusCode===404);
   assert.deepEqual(await service.shops('3'),[]);await assert.rejects(service.read({},'untrusted'),e=>e.statusCode===403);
  });
  await t.test('known offset caps retain accurate partial SKU days, never erase unseen rows or replace a complete day',async()=>{
   const partialDay=shiftTrafficDate(day,-1);
   const reserveDay=async id=>execute("INSERT INTO seller_sku_traffic_days(tenant_id,shop_id,date_key,status,run_id,requested_at) VALUES('admin',11,?,'pending',?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE status='pending',run_id=VALUES(run_id)",[partialDay,id]);
   const capped=id=>({...makeRun(id),current_period:{date_from:partialDay,date_to:partialDay},requests:[{...makeRun(id).requests[0],limit:1,auto_stop_code:'source_offset_cap'}]});
   await reserveDay('partial-first');const first=await service.publish(capped('partial-first'),'admin',[metric(10)]);assert.equal(first.published,true);assert.equal(first.partial,true);
   await reserveDay('partial-next');await service.publish(capped('partial-next'),'admin',[{...metric(20),sku:'another'}]);
   let rows=await query('SELECT sku,total_views FROM seller_sku_traffic_daily WHERE tenant_id=? AND shop_id=? AND date_key=?',['admin',11,partialDay]);assert.equal(rows.length,2);
   let [state]=await query('SELECT status,product_count,last_success_at FROM seller_sku_traffic_days WHERE tenant_id=? AND shop_id=? AND date_key=?',['admin',11,partialDay]);assert.equal(state.status,'partial');assert.equal(state.product_count,2);assert.equal(state.last_success_at,null);
   await reserveDay('complete-after');await service.publish({...makeRun('complete-after'),current_period:{date_from:partialDay,date_to:partialDay}},'admin',[metric(70)]);
   rows=await query('SELECT sku,total_views FROM seller_sku_traffic_daily WHERE tenant_id=? AND shop_id=? AND date_key=?',['admin',11,partialDay]);assert.equal(rows.length,1);assert.equal(Number(rows[0].total_views),70);
   await reserveDay('partial-after-complete');const preserved=await service.publish(capped('partial-after-complete'),'admin',[metric(0)]);assert.equal(preserved.preserved_complete,true);
   rows=await query('SELECT total_views FROM seller_sku_traffic_daily WHERE tenant_id=? AND shop_id=? AND date_key=?',['admin',11,partialDay]);assert.equal(Number(rows[0].total_views),70);
  });
  await t.test('queue reuses pending days and limits backlog to three days per shop',async()=>{
   await execute('DELETE FROM seller_sku_traffic_days WHERE tenant_id=?',['admin']);const runs=new Map();let calls=0;
   const deps={createRun:async(body,key)=>{calls++;assert.equal(key,'admin');assert.equal(body.date_from,body.date_to);assert.equal(body.daily_traffic,true);assert.equal(body.limit,30);const run={id:'queued-'+calls,status:'pending'};runs.set(run.id,run);return run;},loadRun:async id=>runs.get(id)};
   const first=await service.queue({shop_id:11},'admin',deps);assert.equal(first.queued.length,3);
   const next=await service.queue({shop_id:11},'admin',deps);assert.equal(next.queued.length,0);assert.equal(next.waiting.length,3);assert.equal(calls,3);
   await assert.rejects(service.queue({date:'2000-01-01'},'admin',deps),/最近15/);
  });
  await t.test('retention clears only expired daily facts and temporary pages/runs, keeps active stage and legacy analysis',async()=>{
   const oldest=trafficDays()[0],expired=shiftTrafficDate(oldest,-1);
   await execute('INSERT INTO seller_sku_traffic_daily(tenant_id,shop_id,sku,date_key,total_views,updated_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())',['admin',11,'expired',expired,1]);
   await execute('INSERT INTO seller_sku_traffic_daily(tenant_id,shop_id,sku,date_key,total_views,updated_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())',['admin',11,'boundary',oldest,1]);
   for(const [id,source,hours] of [['old-stage','sku-traffic-daily-stage',25],['recent-stage','sku-traffic-daily-stage',23],['legacy','pivot-table-master',48]])await execute('INSERT INTO seller_analytics_snapshots(id,tenant_id,source,captured_at) VALUES(?,?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? HOUR))',[id,'admin',source,hours]);
   const oldRun={id:'old-daily',daily_traffic:true,status:'success',current_period:{date_from:day,date_to:day}};
   await execute("INSERT INTO settings(tenant_id,`key`,value,updated_at) VALUES(?,?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 25 HOUR))",['admin','seller_analytics_collect_run:old-daily',JSON.stringify(oldRun)]);
   await execute("INSERT INTO seller_analytics_collect_runs(id,tenant_id,status) VALUES('old-daily','admin','success')");
   await execute("INSERT INTO seller_analytics_collect_requests(id,run_id,tenant_id,status) VALUES('old-daily-page','old-daily','admin','success')");
   const result=await service.cleanup();assert.equal(result.deletedFacts,1);assert.equal(result.deletedTemporaryRuns,1);
   const facts=await query('SELECT sku FROM seller_sku_traffic_daily');assert.equal(facts.some(r=>r.sku==='expired'),false);assert.equal(facts.some(r=>r.sku==='boundary'),true);
   const staged=await query('SELECT id FROM seller_analytics_snapshots');assert.equal(staged.some(r=>r.id==='old-stage'),false);assert.equal(staged.some(r=>r.id==='recent-stage'),true);assert.equal(staged.some(r=>r.id==='legacy'),true);
   assert.equal((await query("SELECT id FROM seller_analytics_collect_requests WHERE id='old-daily-page'")).length,0);
  });
 }finally{if(pool)await pool.end();await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);await admin.end();}
});
