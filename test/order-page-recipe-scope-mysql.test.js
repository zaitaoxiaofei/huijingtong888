import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createOrderFixtureSchema,loadTenantOrderService} from './helpers/tenant-order-service.js';
import {loadOrderInventoryAvailability} from '../src/services/mysql-order-inventory-availability.js';
import {loadInventoryProductBalances} from '../src/services/mysql-inventory-product-balance.js';
import {withRequestReadCache} from '../src/services/request-read-cache.js';
import {withMysqlWorkload,withMysqlInteractiveRead} from '../src/mysql-workload.js';
import {createOrderReadDiagnostics} from '../src/services/order-read-diagnostics.js';

const socketPath=process.env.TENANT_TEST_MYSQL_SOCKET;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('order recipe aggregation stays inside current-page recipes with complete SQL result equivalence',{
 skip:!socketPath&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
 const database='ozon_recipe_scope_'+randomBytes(8).toString('hex');
 const connection=await mysql.createConnection({socketPath,user:'root',dateStrings:true,timezone:'Z'});let created=false;
 try{
  assert.equal(Number((await connection.query('SELECT @@skip_networking isolated'))[0][0].isolated),1);
  await connection.query(`CREATE DATABASE \`${database}\``);created=true;await connection.changeUser({database});
  await connection.query("SET time_zone='+00:00'");await createOrderFixtureSchema(connection);
  const runtimeSource=await readFile(new URL('../src/services/mysql-cutover.js',import.meta.url),'utf8');
  for(const table of ['fbp_replenishment_orders','fbp_replenishment_order_items','fbp_replenishment_item_adjustments']){
   const ddl=runtimeSource.match(new RegExp('CREATE TABLE IF NOT EXISTS '+table+'[\\s\\S]*?ENGINE=InnoDB[^\\r\\n]*'))?.[0];
   assert.ok(ddl,'Missing checked-in balance dependency schema: '+table);await connection.query(ddl);
  }
  const query=async(sql,args=[])=>(await connection.query(sql,args))[0];
  const before=loadTenantOrderService(connection),after=loadTenantOrderService(connection);
  const frozen=await readFile(new URL('./fixtures/order-page-recipe-stock-before-scope.js',import.meta.url),'utf8');
  vm.runInContext(frozen.replace(/^export /gm,''),before.service);
  await query("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','active')");
  await query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(20,2,'A'),(30,3,'B')");
  await query("INSERT INTO people(id,name) VALUES(2,'Buyer A'),(3,'Buyer B')");
  await query("INSERT INTO tenant_members(tenant_id,person_id,role) VALUES(2,2,'member'),(3,3,'member')");
  for(const [id,tenant,name,active]of [[20,2,'Direct',1],[21,2,'Kit',1],[22,2,'Shared child',1],[23,2,'Other child',1],[24,2,'Recipe',1],[25,2,'Zero ratio',1],[26,2,'Single mode',1],[29,2,'Inactive',0],[100,null,'Legacy root',1],[101,null,'Legacy child',1],[300,3,'Secret B root',1],[301,3,'Secret B child',1]]){
   await query('INSERT INTO products(id,tenant_id,name,code,active) VALUES(?,?,?,?,?)',[id,tenant,name,'P-'+id,active]);
  }
  await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(20,2,20,20,'DIRECT',1),(21,2,20,21,'KIT',1),(24,2,20,24,'RECIPE',1),(25,2,20,25,'ZERO',1),(26,2,20,26,'SINGLE',1),(29,2,20,29,'INACTIVE',1),(100,NULL,10,100,'RECIPE',1),(300,3,30,300,'RECIPE',1)");
  await query('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,21,22,2),(2,21,23,1),(3,21,301,999)');
  await query("INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active,mode) VALUES(1,20,'RECIPE',1,'combo'),(2,20,'DISABLED',0,'combo'),(3,20,'UNBOUND',1,'combo'),(4,20,'ZERO',1,'combo'),(5,20,'SINGLE',1,'single'),(6,20,'INACTIVE',1,'combo'),(10,10,'RECIPE',1,'combo'),(30,30,'RECIPE',1,'combo')");
  await query('INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES(1,22,1),(1,23,2),(1,301,50),(2,22,999),(3,22,1),(4,22,0),(5,23,1),(6,22,2),(10,101,2),(30,301,3)');
  const fixtures=[[1,20,'DIRECT',20,1,10,7],[2,20,'KIT',21,2,15,11],[3,20,'RECIPE',24,3,20,13],[4,20,'DIRECT',300,1,12,0],[5,20,'UNBOUND',null,2,11,1],[6,20,'ZERO',25,1,10,0],[7,20,'SINGLE',26,1,13,-3],[8,20,'MISSING',null,1,14,2],[9,20,'INACTIVE',29,1,15,2],[10,10,'RECIPE',100,2,10,5],[30,30,'RECIPE',300,3,999,900]];
  for(const [id,shop,sku,mapping,quantity,price,profit]of fixtures){
   await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,?,'2026-11-01')",[id,shop,'ORDER-'+id,id%2?'awaiting_packaging':'awaiting_deliver']);
   await query('INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price,estimated_profit) VALUES(?,?,?,?,?,?,?)',[id,id,mapping,sku,quantity,price,profit]);
  }
  await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price,estimated_profit) VALUES(201,3,21,'KIT',1,9,1.2)");
  await query("INSERT INTO inventory_movements(tenant_id,product_id,source_type,source_ref,quantity_delta,status,stock_location) VALUES(2,20,'manual_adjustment','direct',8,'posted','LOCAL'),(2,22,'manual_adjustment','shared',12,'posted','LOCAL'),(2,23,'manual_adjustment','other',6,'posted','LOCAL'),(2,22,'manual_adjustment','fbp',100,'posted','FBP'),(3,22,'manual_adjustment','poison',999,'posted','LOCAL'),(NULL,101,'manual_adjustment','legacy',8,'posted','LOCAL'),(3,301,'manual_adjustment','b',30,'posted','LOCAL')");
  await query("INSERT INTO purchase_orders(id,tenant_id,order_no,created_by_person_id,purchased_at) VALUES(1,2,'PO-A',2,'2026-10-31'),(30,3,'PO-B',3,'2026-10-31')");
  await query("INSERT INTO inbound_records(tenant_id,product_id,person_id,quantity,amount,purchase_order_id,status) VALUES(2,22,2,4,20,1,'pending_arrival'),(2,22,2,100,500,1,'approved'),(3,301,3,777,999,30,'pending_arrival')");
  await query("INSERT INTO order_profit_items(order_item_id,sale_amount_cny,purchase_cost_cny,domestic_shipping_cny,international_shipping_cny,packaging_cost_cny,commission_fee_cny,ozon_service_fee_cny,return_loss_cny,net_profit_cny,profit_status) VALUES(1,10,3.25,1.1,2.2,0.5,0.6,0.3,0,2.05,'estimated'),(3,60,11.5,2.3,3.4,0.8,1.7,0.4,0.2,-1.7,'accrued')");
  await query('INSERT INTO ozon_orders_raw(store_id,posting_number,raw_json) VALUES(?,?,?),(?,?,?)',[20,'ORDER-3',JSON.stringify({raw:{delivery_method:{name:'CEL'},note:'Saved source'}}),30,'ORDER-30',JSON.stringify({secret:'B source'})]);
  // Match the checked-in runtime indexes; unrelated recipes deliberately share
  // the page's physical parts, reproducing the excessive grouped relation.
  const [indexes]=await connection.query('SHOW INDEX FROM sku_inventory_recipe_items');
  if(!indexes.some(row=>row.Column_name==='recipe_id'&&Number(row.Seq_in_index)===1))await query('CREATE INDEX fixture_recipe_items_recipe ON sku_inventory_recipe_items(recipe_id,product_id)');
  const [recipeIndexes]=await connection.query('SHOW INDEX FROM sku_inventory_recipes');
  if(!recipeIndexes.some(row=>row.Column_name==='shop_id'&&Number(row.Seq_in_index)===1))await query('CREATE UNIQUE INDEX fixture_recipes_shop_sku ON sku_inventory_recipes(shop_id,ozon_sku)');
  const noise=1600;
  for(let offset=0;offset<noise;offset+=200){
   const entries=Array.from({length:Math.min(200,noise-offset)},(_,i)=>[1000+offset+i,offset%400?30:20,'UNRELATED-'+(offset+i)]);
   await query(`INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active,mode) VALUES ${entries.map(()=>"(?,?,?,1,'combo')").join(',')}`,entries.flat());
   await query(`INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES ${entries.flatMap(()=>['(?,22,1)','(?,23,2)']).join(',')}`,entries.flatMap(row=>[row[0],row[0]]));
  }
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const ids=fixtures.map(row=>row[0]);
  await t.test('whole detail and summary payload hashes match for A, B and legacy NULL enterprises',async()=>{
   for(const tenant of ['2','3','admin'])for(const summaryOnly of [false,true]){
    const startOld=before.calls.length,startNew=after.calls.length;
    const oldRows=await before.service.orderRowsByIdsMysql(ids,null,tenant,{summaryOnly,bypassCache:true});
    const newRows=await after.service.orderRowsByIdsMysql(ids,null,tenant,{summaryOnly,bypassCache:true});
    assert.equal(hash(newRows),hash(oldRows),tenant+' complete row fields');
    assert.equal(before.calls.length-startOld,after.calls.length-startNew,'no extra SQL round trips');
    assert.deepEqual(Array.from(newRows,row=>Number(row.id)),tenant==='2'?[1,2,3,4,5,6,7,8,9]:tenant==='3'?[30]:[10]);
    if(tenant==='2'){assert.ok(!JSON.stringify(newRows).includes('Secret B'));assert.match(newRows.find(row=>row.id===3).sku_stock_summaries,/RECIPE:0:0:3/);assert.equal(newRows.find(row=>row.id===4).product_ids,'20');assert.equal(newRows.find(row=>row.id===8).product_ids,null);if(!summaryOnly)assert.equal(Number(newRows.find(row=>row.id===3).profit_purchase_cost),11.5);}
    t.diagnostic(JSON.stringify({tenant,summary:summaryOnly,rows:newRows.length,result_sha256:hash(newRows)}));
   }
  });
  await t.test('all, waiting-packaging and waiting-delivery retain page membership, totals and every returned value',async()=>{
   for(const tenant of ['2','3','admin'])for(const status of ['all','awaiting_packaging','awaiting_deliver'])for(const page of [1,2]){
    const params={status,page,pageSize:3,includeCounts:'0',includeLogisticsOptions:'0',includeInventoryAvailability:'0',sortMode:'ordered'};
    assert.equal(hash(await after.service.ordersPagedMysql(params,tenant)),hash(await before.service.ordersPagedMysql(params,tenant)),tenant+'/'+status+'/'+page);
   }
  });
  await t.test('the actual runtime facade passes diagnostics into real SQL without changing queries, fields or results',async()=>{
   // Extract only the checked-in facade property. Importing the whole runtime
   // would initialize application services instead of this isolated database.
   const runtime=await readFile(new URL('../src/services/mysql-runtime-services.js',import.meta.url),'utf8');
   const property=runtime.match(/^  ordersPaged: [\s\S]*?(?=^  outboundRecords:)/m)?.[0];assert.ok(property);
   const logs=[],stages=[];
   const ordersPaged=vm.runInNewContext('({'+property+'}).ordersPaged',{
    withRequestReadCache,withMysqlWorkload,withMysqlInteractiveRead,
    ordersPagedMysql:(...args)=>after.service.ordersPagedMysql(...args),
    createOrderReadDiagnostics:area=>{
     const diagnostics=createOrderReadDiagnostics(area,{thresholdMs:0,logger:line=>logs.push(JSON.parse(line))});
     return{measure:(name,work)=>{stages.push(name);return diagnostics.measure(name,work);},finish:details=>diagnostics.finish(details)};
    }
   });
   const params={status:'all',page:1,pageSize:3,includeCounts:'0',includeLogisticsOptions:'0',includeInventoryAvailability:'0',sortMode:'ordered'};
   const start=after.calls.length;
   const plain=await withRequestReadCache(()=>withMysqlWorkload('foreground',()=>withMysqlInteractiveRead(()=>after.service.ordersPagedMysql(params,'2'))));
   const plainCalls=after.calls.slice(start),next=after.calls.length,diagnosed=await ordersPaged(params,'2'),diagnosedCalls=after.calls.slice(next);
   assert.equal(hash(diagnosed),hash(plain));assert.deepEqual(diagnosedCalls,plainCalls,'diagnostics add no SQL or parameter changes');
   assert.equal(diagnosedCalls.filter(call=>call.sql.includes('WITH scoped_order_items')).length,1,'the facade executes the new core SQL');
   assert.deepEqual(stages,['schema','base','filters','id_selection','page_rows','core_sql','raw_payload','enrich','metadata']);
   assert.equal(logs.length,1);assert.equal(logs[0].area,'ordersPagedMysql');assert.equal(logs[0].counts.rows,3);
   assert.deepEqual(logs[0].stages.map(stage=>stage.name).sort(),[...stages].sort());
   assert.ok(logs[0].stages.every(stage=>Object.keys(stage).sort().join(',')==='ms,name'&&Number.isFinite(stage.ms)));
   assert.ok(!/ORDER-|Buyer|Shared child|Secret B|RECIPE|raw_json|tenant_id|order_ids|"params"|"sql"/.test(JSON.stringify(logs)),'only fixed stage names, durations and numeric counts are logged');
   t.diagnostic(JSON.stringify({runtime_facade:true,diagnostic_stages:stages,sql_calls:diagnosedCalls.length,result_sha256:hash(diagnosed),diagnostic_payload_keys:Object.keys(logs[0]).sort()}));
  });
  await t.test('the stock-derived relation groups only current-page recipes rather than every recipe sharing a child',async()=>{
   const request=async sut=>{const start=sut.calls.length;await sut.service.orderRowsByIdsMysql(ids,null,'2',{summaryOnly:true,bypassCache:true});return sut.calls.slice(start).find(call=>call.sql.includes('WITH scoped_order_items'));};
   const old=await request(before),candidate=await request(after);
   const inspect=async call=>{
    const prefix=call.sql.slice(0,call.sql.indexOf('\n    SELECT STRAIGHT_JOIN o.*'));
    const relation=call.sql.match(/LEFT JOIN \(\s*(SELECT ri\.recipe_id,[\s\S]*?)\n    \) sku_recipe_stock/)[1];
    const sql=prefix+'\nSELECT COUNT(*) AS group_count FROM ('+relation+') recipe_groups';
    const started=performance.now(),rows=await query(sql,ids),ms=Math.round((performance.now()-started)*100)/100;
    const plan=(await query('EXPLAIN FORMAT=JSON '+sql,ids))[0];
    return {groups:Number(rows[0].group_count),ms,plan:JSON.parse(plan.EXPLAIN)};
   };
   const oldPlan=await inspect(old),newPlan=await inspect(candidate);
   assert.ok(oldPlan.groups>=noise);assert.equal(newPlan.groups,5);
   assert.ok(!candidate.sql.includes('JOIN scoped_recipe_ids scoped_recipe ON scoped_recipe.id = ri.recipe_id\n      JOIN scoped_recipe_ids'),'recipe join is unique');
   const tables=plan=>{const result=[];const walk=value=>{if(!value||typeof value!=='object')return;if(value.table_name)result.push({table:value.table_name,access:value.access_type,key:value.key||null,rows:value.rows_examined_per_scan});for(const child of Object.values(value))walk(child);};walk(plan);return result;};
   t.diagnostic(JSON.stringify({unrelated_recipes:noise,baseline_groups:oldPlan.groups,candidate_groups:newPlan.groups,baseline_ms:oldPlan.ms,candidate_ms:newPlan.ms,baseline_plan:tables(oldPlan.plan),candidate_plan:tables(newPlan.plan)}));
  });
  await connection.rollback();
  await t.test('full uncached twenty-row SQL remains equivalent with large unrelated order, history and movement tables',async()=>{
   const large=12000,movements=60000,extraIds=Array.from({length:11},(_,i)=>50+i),pageIds=[...Array.from({length:9},(_,i)=>i+1),...extraIds];
   for(const id of extraIds){
    await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,20,?,'awaiting_packaging','2026-11-01')",[id,'PAGE-'+id]);
    await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(?,?,24,'RECIPE',1,20)",[id,id]);
   }
   await query("INSERT INTO products(id,tenant_id,name,code,active) VALUES(900,2,'Unrelated inventory','P-900',1)");
   for(let offset=0;offset<large;offset+=300){
    const values=Array.from({length:Math.min(300,large-offset)},(_,i)=>[100000+offset+i,(offset+i)%2?20:30,'NOISE-'+(offset+i)]);
    await query(`INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES ${values.map(()=>"(?,?,?,'delivered','2026-11-01')").join(',')}`,values.flat());
    await query(`INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price) VALUES ${values.map(()=>"(?,?,'NOISE',1,10)").join(',')}`,values.flatMap(([id])=>[id,id]));
    await query(`INSERT INTO order_status_history(order_id,shop_id,posting_number,status,observed_at,observed_hour) VALUES ${values.map(()=>"(?,?,?,'delivered','2026-11-01','2026-11-01')").join(',')}`,values.flat());
    await query(`INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active,mode) VALUES ${values.map(()=>"(?,?,?,1,'combo')").join(',')}`,values.flat());
    await query(`INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES ${values.flatMap(()=>['(?,22,1)','(?,23,2)']).join(',')}`,values.flatMap(([id])=>[id,id]));
   }
   for(let offset=0;offset<movements;offset+=500){
    const values=Array.from({length:Math.min(500,movements-offset)},(_,i)=>[offset+i,((offset+i)%2?1:-1)]);
    await query(`INSERT INTO inventory_movements(tenant_id,product_id,source_type,source_ref,quantity_delta,status,stock_location) VALUES ${values.map(()=>"(2,900,'manual_adjustment',?,?,'posted','LOCAL')").join(',')}`,values.flat());
   }
   await query('ANALYZE TABLE orders,order_items,order_status_history,inventory_movements,sku_inventory_recipes,sku_inventory_recipe_items');
   const execute=async context=>{const start=context.calls.length,started=performance.now(),rows=await context.service.orderRowsByIdsMysql(pageIds,null,'2',{summaryOnly:true,bypassCache:true});return{rows,ms:Math.round((performance.now()-started)*100)/100,calls:context.calls.slice(start),core:context.calls.slice(start).find(call=>call.sql.includes('WITH scoped_order_items'))};};
   const baseline=[],candidate=[];
   for(let run=0;run<3;run++){
    const old=await execute(before),current=await execute(after);assert.equal(hash(current.rows),hash(old.rows));assert.equal(current.rows.length,20);assert.equal(old.calls.length,current.calls.length);
    baseline.push(old);candidate.push(current);
   }
   const explain=async call=>{
    const started=performance.now(),json=JSON.parse((await query('EXPLAIN FORMAT=JSON '+call.sql,call.params))[0].EXPLAIN),planningMs=Math.round((performance.now()-started)*100)/100;
    const text=(await query('EXPLAIN ANALYZE '+call.sql,call.params))[0].EXPLAIN,lines=text.split('\n');
    const nodes=lines.map(line=>{const match=line.match(/\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.]+) loops=(\d+)\)/);return match?{operator:line.trim().split('  (')[0].slice(0,180),end_ms:Number(match[2]),rows:Number(match[3]),loops:Number(match[4])}:null;}).filter(Boolean);
    return{planning_ms:planningMs,cost:Number(json.query_block.cost_info.query_cost),root_end_ms:nodes[0]?.end_ms,plan_lines:lines.length,largest_scan_or_materialize:nodes.filter(node=>!/Nested loop|hash join|Group aggregate|Sort row|Temporary table|scan on <temporary>/i.test(node.operator)).sort((a,b)=>b.end_ms*b.loops-a.end_ms*a.loops).slice(0,15),history_referenced:/order_status_history/.test(call.sql)};
   };
   t.diagnostic(JSON.stringify({phase:'full_uncached_core_sql',page_rows:20,unrelated_orders:large,history_rows:large,unrelated_movements:movements,total_unrelated_recipes:large+noise,baseline_ms:baseline.map(row=>row.ms),candidate_ms:candidate.map(row=>row.ms),baseline_plan:await explain(baseline[0].core),candidate_plan:await explain(candidate[0].core),production_latency_claim:false}));
  });
  await t.test('real inline balance SQL preserves warm facts, serves stale facts during refresh and blocks only cold inline callers',async()=>{
   const pool=mysql.createPool({socketPath,user:'root',database,dateStrings:true,timezone:'Z',connectionLimit:4});
   const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
   let blocked=null,onRefresh=()=>{};const reads=[];
   const run=async(sql,args=[])=>{reads.push(sql);if(blocked&&sql.includes('AS open_demand_qty')){blocked.started.resolve();await blocked.release.promise;}return(await pool.query(sql,args))[0];};
   const transaction=async action=>{const c=await pool.getConnection();try{await c.query("SET time_zone='+00:00'");await c.beginTransaction();const value=await action(c);await c.commit();return value;}catch(error){await c.rollback();throw error;}finally{c.release();}};
   const service=loadTenantOrderService(connection,{orderInventoryAvailabilityMysql:(request,tenant)=>loadOrderInventoryAvailability({query:run,loadBalances:(products,owner,legacy,forceRefresh)=>loadInventoryProductBalances(run,transaction,owner,legacy,products,{forceRefresh,onRefreshed:()=>onRefresh()})},request,{tenantId:Number(tenant),defaultTenantId:1})}).service;
   const pageIds=[1,2,3],sourceReads=()=>reads.filter(sql=>sql.includes('AS open_demand_qty')).length;
   const measured=async inline=>{const started=performance.now(),rows=await service.orderPageRowsMysql(pageIds,null,'2',inline);return{rows,ms:Math.round((performance.now()-started)*100)/100};};
   const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture page unexpectedly waited for a held balance refresh')),3000);})]);}finally{clearTimeout(timer);}};
   try{
    const cold=await measured(true);assert.equal(sourceReads(),1);assert.ok(cold.rows.every(row=>Array.isArray(row.inventory_availability)&&row.inventory_availability.length>0));
    const warmSources=sourceReads(),warm=await measured(true),plain=await measured(false);assert.equal(sourceReads(),warmSources);assert.ok(plain.rows.every(row=>!Object.hasOwn(row,'inventory_availability')));
    const strip=rows=>rows.map(({inventory_availability,...row})=>row);assert.equal(hash(strip(warm.rows)),hash(plain.rows));
    t.diagnostic(JSON.stringify({phase:'real_sql_warm_cache',inline_ms:warm.ms,plain_ms:plain.ms,initial_refresh_ms:cold.ms,source_refreshes:sourceReads()}));
    await query('UPDATE inventory_product_balance SET refreshed_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 60 SECOND) WHERE tenant_id=2');
    blocked={started:deferred(),release:deferred()};let refreshed=deferred();onRefresh=()=>refreshed.resolve();
    const stale=await bounded(measured(true));await blocked.started.promise;assert.equal(hash(stale.rows),hash(warm.rows),'45–90 second facts remain the existing known facts');
    blocked.release.resolve();await refreshed.promise;blocked=null;await new Promise(resolve=>setImmediate(resolve));
    await query('UPDATE inventory_product_balance SET refreshed_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 91 SECOND) WHERE tenant_id=2');
    blocked={started:deferred(),release:deferred()};refreshed=deferred();onRefresh=()=>refreshed.resolve();let inlineSettled=false;
    const waiting=measured(true).then(value=>{inlineSettled=true;return value;});await blocked.started.promise;
    const unaffected=await bounded(measured(false));assert.equal(inlineSettled,false,'cold inline page awaits canonical balance SQL');assert.equal(hash(unaffected.rows),hash(plain.rows),'no-inventory page is independent of the held refresh');
    blocked.release.resolve();const completed=await waiting;await refreshed.promise;blocked=null;
    assert.equal(hash(completed.rows),hash(warm.rows));
    t.diagnostic(JSON.stringify({phase:'controlled_refresh_dependency',injected_completion_gate:true,stale_page_returns_before_refresh:true,plain_page_returns_while_cold_inline_waits:true,rows:completed.rows.length,production_latency_claim:false}));
   }finally{blocked?.release.resolve();await pool.end();}
  });
 }finally{await connection.rollback();if(created)await connection.query(`DROP DATABASE \`${database}\``);await connection.end();}
});
