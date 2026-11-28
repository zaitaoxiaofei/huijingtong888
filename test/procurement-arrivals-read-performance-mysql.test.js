import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {performance} from 'node:perf_hooks';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

const plain=value=>JSON.parse(JSON.stringify(value));
const baseline=execFileSync('git',['show','543ed890:src/services/procurement-arrivals.js'],{
 cwd:new URL('..',import.meta.url),encoding:'utf8',maxBuffer:1024*1024
});

test('mobile arrival reader retains complete baseline results and reduces repeated event scans',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires disposable socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('arrival_read');f.useEnvironment();
 const api=await import('../src/services/mysql-cutover.js');
 const {createProcurementArrivals}=await import('../src/services/procurement-arrivals.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const dependencies=Object.assign({},...await Promise.all([
  '../src/services/inventory-composition.js','../src/shared/purchase-bundle-review.js',
  '../src/services/business-task-tenant.js','../src/services/inventory-tenant-scope.js',
  '../src/services/inventory-product-search.js','../src/services/inventory-search.js',
  '../src/shared/permissions.js','../src/services/procurement-daily-report.js'
 ].map(path=>import(path))));
 const buyer={personId:7,tenant:{id:2,slug:'a'}},warehouse={personId:8,tenant:{id:2,slug:'a'}},legacy={personId:1,tenant:{id:1,slug:'default'}};
 const calls=[];
 const q=async(sql,args=[])=>{
  const start=performance.now();const [rows]=await f.connection.query(sql,args);
  calls.push({sql,args:Array.from(args),milliseconds:performance.now()-start,rows:rows.length});return rows;
 };
 const original=vm.createContext({Date,Map,Set,Number,String,Object,Array,Math,JSON,...dependencies,
  mysqlQuery:q,withMysqlTransaction:()=>{throw Error('Read oracle must never mutate');}});
 vm.runInContext(baseline.slice(baseline.indexOf('const fail='),baseline.lastIndexOf('export const procurementArrivals=')).replace(/^export /gm,''),original);
 const old=original.createProcurementArrivals({query:q}),current=createProcurementArrivals({query:q});
 const compare=async(params,session=buyer)=>{
  const before=plain(await old.list(params,session)),after=plain(await current.list(params,session));
  assert.deepEqual(after,before,JSON.stringify({params,session}));return after;
 };
 try{
  await f.query("SET timestamp = UNIX_TIMESTAMP('2026-11-28 04:00:00')");
  await f.query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await f.query("INSERT INTO people(id,name,role) VALUES(1,'Default buyer','procurement'),(7,'Buyer','procurement'),(8,'Warehouse','packing'),(9,'Foreign buyer','procurement')");
  await f.query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(1,1,'member',JSON_ARRAY('procurement'),1),(2,7,'member',JSON_ARRAY('procurement'),1),(2,8,'member',JSON_ARRAY('packing'),1),(3,9,'member',JSON_ARRAY('procurement'),1)");
  await api.prepareInventoryFlowMysql();
  await f.query('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await api.procurementRequestsMysql({grouped:'1',compact:'1'},2);
  await f.query("INSERT INTO products(id,tenant_id,name,code,active) VALUES(100,NULL,'Legacy item','LEGACY',1),(200,2,'Target leaf','TARGET',1),(201,2,'Target bundle','BUNDLE',1),(202,2,'Inactive leaf','INACTIVE',0),(203,2,'Invalid bundle','INVALID',1),(300,3,'Foreign leaf','FOREIGN',1)");
  await f.query('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,201,200,2),(2,203,202,1)');
  const batches=[
   [1,2,200,3,'pending_arrival','2020-01-01 00:00:00',null],
   [2,2,200,4,'pending_arrival','2026-11-26 16:00:00',null],
   [3,2,200,5,'pending_arrival','2026-11-27 16:00:00','2026-11-28 01:00:00'],
   [4,2,201,6,'pending_arrival','2026-11-27 16:00:00',null],
   [5,2,201,7,'pending_arrival','2026-11-27 16:00:00',null],
   [6,2,200,8,'approved','2026-11-20 00:00:00','2026-11-21 00:00:00'],
   [7,2,200,9,'cancelled','2026-11-20 00:00:00',null],
   [8,2,203,10,'pending_arrival','2026-11-26 16:00:00',null],
   [9,null,100,11,'pending_arrival','2020-01-01 00:00:00',null],
   [10,3,300,999,'pending_arrival','2026-11-27 00:00:00',null],
   [11,2,200,12,'pending_arrival','2026-11-27 16:00:00',null],
   [12,2,201,0,'cancelled','2020-01-01 00:00:00',null]
  ];
  for(const[id,tenant,product,quantity,status,purchased,received]of batches){
   await f.query('INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at,note) VALUES(?,?,?,?,?,?)',[id,tenant,'PO-'+id,status==='cancelled'?'cancelled':'purchased',purchased,'private purchase note']);
   await f.query("INSERT INTO purchase_order_items(id,tenant_id,purchase_order_id,product_id,actual_quantity,requested_quantity,amount,status) VALUES(?,?,?,?,?,?,?,'purchased')",[id,tenant,id,product,quantity,quantity,quantity*3]);
   await f.query('INSERT INTO inbound_records(id,tenant_id,product_id,person_id,quantity,amount,shipping_amount,purchase_order_id,purchase_order_item_id,status,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,tenant,product,tenant===2?7:tenant===3?9:1,quantity,quantity*3,2,id,id,status,received,purchased]);
  }
  const event=async(tenant,product,person,action,value)=>f.query('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[tenant,product,person,action,JSON.stringify(value)]);
  const whole=dependencies.bundleReviewContentRevision({id:4,product_id:201},[{product_id:200,per_set_quantity:2}]);
  await event(2,201,7,'purchase_bundle_review',{content_revision:whole,result:{mode:'whole',inbound_id:4}});
  await event(2,201,7,'purchase_bundle_review',{source:{product_id:201,purchase_order_id:12},result:{mode:'parts',inbound_id:12,created:[{inbound_id:11,product_id:200,purchase_order_id:11}]}});
  await event(2,200,7,'purchase_arrival_reminder',{inbound_id:1,note:'hidden by latest wrong-product event'});
  await event(2,201,7,'purchase_arrival_reminder',{inbound_id:1,note:'wrong product must hide the earlier reminder'});
  await event(2,200,9,'purchase_arrival_reminder',{inbound_id:2,note:'foreign person identity remains hidden'});
  await event(3,201,9,'purchase_arrival_reminder',{inbound_id:4,note:'foreign event must not leak'});
  await event(2,201,7,'purchase_arrival_reminder',{inbound_id:4,note:'valid reminder'});
  await event(2,201,7,'purchase_arrival_reminder',{inbound_id:4,note:'latest valid reminder'});
  await event(1,100,1,'purchase_arrival_reminder',{inbound_id:9,note:'legacy default reminder'});
  await t.test('all states, dates, pagination, summary-only, filters and default NULL equal the baseline',async()=>{
   for(const status of ['pending','open','reminded','arrived','inspection','received','all']){
    for(const page of [1,2,99])await compare({status,page,pageSize:2});
    await compare({status,day_mode:'pending',pageSize:20});
   }
   for(const params of [{recent:'1',status:'all'},{summary_only:'1',status:'pending'},
    {day_mode:'pending',status:'open',purchase_day:'2026-11-28'},
    {day_mode:'pending',status:'reminded',purchase_day:'2020-01-01',page:8},
    {day_mode:'pending',status:'open',purchase_day:'all',start_date:'2026-11-27',end_date:'2026-11-28'},
    {status:'all',searchMode:'inventory_id',query:'TARGET'},
    {status:'all',searchMode:'name',query:'Target'},
    {status:'pending',product_id:200}])await compare(params);
   const legacyResult=await compare({status:'pending',day_mode:'pending'},legacy);
   assert.equal(legacyResult.summary.pending_quantity,11);assert.equal(legacyResult.rows[0].arrival_reminder.note,'legacy default reminder');
  });
  await t.test('reminder MAX and identity checks, bundle review, lineage and financial permissions stay exact',async()=>{
   const result=await compare({status:'pending',pageSize:100});
   assert.equal(result.rows.find(row=>row.id===1).arrival_reminder,null);
   assert.equal(result.rows.find(row=>row.id===2).arrival_reminder.person_name,null);
   assert.equal(result.rows.find(row=>row.id===4).arrival_reminder.note,'latest valid reminder');
   assert.equal(result.rows.find(row=>row.id===4).review_required,false);
   assert.equal(result.rows.find(row=>row.id===5).review_required,true);
   assert.equal(result.rows.find(row=>row.id===8).physical_quantity,null);
   assert.equal(result.rows.find(row=>row.id===11).source_bundle_batch.purchase_order_id,12);
   const safe=await compare({status:'all',pageSize:100},warehouse);
   assert.ok(safe.rows.every(row=>!Object.hasOwn(row,'amount')&&!Object.hasOwn(row,'shipping_amount')&&!Object.hasOwn(row,'purchase_note')));
   assert.ok(!JSON.stringify(safe).includes('private purchase note'));
   assert.equal(safe.summary.pending_quantity,result.summary.pending_quantity);
  });
  await t.test('reviewed bundle summaries retain negative and fractional legacy quantity arithmetic',async()=>{
   await f.query('ALTER TABLE inbound_records MODIFY quantity DECIMAL(18,4) NOT NULL');
   await f.query("INSERT INTO products(id,tenant_id,name,code,active) VALUES(204,2,'Second leaf','SECOND',1)");
   await f.query('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,201,204,3)');
   const revision=dependencies.bundleReviewContentRevision({id:4,product_id:201},[{product_id:200,per_set_quantity:2},{product_id:204,per_set_quantity:3}]);
   await f.query("UPDATE inventory_flow_events SET detail_json=JSON_SET(detail_json,'$.content_revision',?) WHERE tenant_id=2 AND action='purchase_bundle_review' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.result.inbound_id'))='4'",[revision]);
   await f.query('UPDATE inbound_records SET quantity=CASE id WHEN 1 THEN -3.25 WHEN 2 THEN 0.0001 WHEN 4 THEN 0.1001 ELSE quantity END');
   const result=await compare({status:'pending',pageSize:100});
   const bundle=result.rows.find(row=>row.id===4);
   assert.equal(bundle.review_required,false);
   assert.equal(bundle.physical_quantity,0.1001*2+0.1001*3);
   await compare({status:'pending',day_mode:'pending',summary_only:'1'});
  });
  await t.test('one reminder grouping and current-page lineage sources replace repeated history work',async()=>{
   calls.length=0;await current.list({status:'pending',pageSize:1},buyer);
   const grouping=calls.filter(call=>call.sql.includes("action='purchase_arrival_reminder'"));
   assert.equal(grouping.length,1);
   assert.doesNotMatch(grouping[0].sql,/person_name|reminder_note/);
   const page=calls.find(call=>call.sql.includes('LIMIT ? OFFSET ?'));
   assert.ok(page);assert.doesNotMatch(page.sql,/inventory_flow_events|JSON_EXTRACT/);
   assert.ok(calls.every(call=>!/^\s*(UPDATE|INSERT|DELETE|ALTER)/i.test(call.sql)));
   const before=calls.length;await current.list({status:'pending',summary_only:'1'},buyer);
   assert.ok(!calls.slice(before).some(call=>call.sql.includes('FROM inbound_records source')));
   assert.ok(!calls.slice(before).some(call=>call.sql.includes('SELECT reminder.id AS reminder_id')));
   calls.length=0;await current.list({status:'reminded',pageSize:2},buyer);
   const metadata=calls.filter(call=>call.sql.includes('SELECT reminder.id AS reminder_id'));
   assert.equal(metadata.length,1);assert.ok(metadata[0].args.length<=2,'Reminder identities are restricted to the current page');
  });
  if(process.env.PROCUREMENT_ARRIVALS_BENCH==='1'){
   await q(`INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json)
    SELECT 2,200,7,CASE WHEN n%3=0 THEN 'purchase_arrival_reminder' WHEN n%3=1 THEN 'purchase_bundle_review' ELSE 'unrelated' END,
     CASE WHEN n%3=0 THEN JSON_OBJECT('inbound_id',2,'note','historical reminder')
      ELSE JSON_OBJECT('source',JSON_OBJECT('product_id',200,'purchase_order_id',100000+n),'result',JSON_OBJECT('mode','parts','inbound_id',100000+n,'created',JSON_ARRAY(JSON_OBJECT('inbound_id',200000+n,'product_id',200,'purchase_order_id',200000+n))),'note',REPEAT('x',1000)) END
    FROM (SELECT a.n+10*b.n+100*c.n+1000*d.n+10000*e.n n FROM
      JSON_TABLE('[0,1,2,3,4,5,6,7,8,9]','$[*]' COLUMNS(n INT PATH '$')) a
      CROSS JOIN JSON_TABLE('[0,1,2,3,4,5,6,7,8,9]','$[*]' COLUMNS(n INT PATH '$')) b
      CROSS JOIN JSON_TABLE('[0,1,2,3,4,5,6,7,8,9]','$[*]' COLUMNS(n INT PATH '$')) c
      CROSS JOIN JSON_TABLE('[0,1,2,3,4,5,6,7,8,9]','$[*]' COLUMNS(n INT PATH '$')) d
      CROSS JOIN JSON_TABLE('[0,1,2]','$[*]' COLUMNS(n INT PATH '$')) e) numbers`);
   for(const[label,reader]of[['original',old],['candidate',current]]){
    const params={status:'pending',day_mode:'pending',pageSize:20};
    await reader.list(params,buyer);const times=[];calls.length=0;
    const stats=()=>q("SHOW SESSION STATUS WHERE Variable_name IN ('Handler_read_key','Handler_read_next','Handler_read_rnd_next','Bytes_sent')");
    const before=new Map((await stats()).map(row=>[row.Variable_name,Number(row.Value)]));
    for(let i=0;i<5;i++){const start=performance.now();await reader.list(params,buyer);times.push(performance.now()-start);}
    const reads=Object.fromEntries((await stats()).map(row=>[row.Variable_name,Number(row.Value)-before.get(row.Variable_name)]));
    t.diagnostic(JSON.stringify({label,milliseconds:times,reads,reminderGroupings:calls.filter(call=>call.sql.includes("action='purchase_arrival_reminder'")).length,lineageSourceIds:calls.filter(call=>call.sql.includes('FROM inbound_records source')).map(call=>call.args.length)}));
   }
   await compare({status:'pending',day_mode:'pending',pageSize:20});
  }
 }finally{await closeMysqlPool();await f.cleanup();}
});
