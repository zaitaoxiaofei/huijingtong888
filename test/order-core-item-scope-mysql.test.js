import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createOrderFixtureSchema,loadTenantOrderService} from './helpers/tenant-order-service.js';
import {withRequestReadCache} from '../src/services/request-read-cache.js';
import {withMysqlWorkload,withMysqlInteractiveRead} from '../src/mysql-workload.js';
import {createOrderReadDiagnostics} from '../src/services/order-read-diagnostics.js';

const socketPath=process.env.TENANT_TEST_MYSQL_SOCKET;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('materialized item and component scopes preserve all rows while reducing repeated table openings',{
 skip:!socketPath&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
 const database='ozon_json_scope_'+randomBytes(8).toString('hex');
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
  const frozen=await readFile(new URL('./fixtures/order-core-before-item-scope.js',import.meta.url),'utf8');
  vm.runInContext(frozen.replace(/^export /,''),before.service);
  // This fixture is immutable during comparisons. Each candidate invocation
  // owns its real snapshot; fixed statement time removes clock-boundary noise.
  await query('SET timestamp=?',[Math.floor(Date.now()/1000)]);
  await query("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','active')");
  await query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(20,2,'A'),(30,3,'B')");
  await query("INSERT INTO people(id,name) VALUES(2,'Buyer A'),(3,'Buyer B')");
  await query("INSERT INTO tenant_members(tenant_id,person_id,role) VALUES(2,2,'member'),(3,3,'member')");
  for(const [id,tenant,name,active]of [[20,2,'Direct',1],[21,2,'Kit',1],[22,2,'Shared child',1],[23,2,'Other child',1],[24,2,'Recipe',1],[25,2,'Zero ratio',1],[26,2,'Single mode',1],[29,2,'Inactive',0],[100,null,'Legacy root',1],[101,null,'Legacy child',1],[300,3,'Secret B root',1],[301,3,'Secret B child',1]]){
   await query('INSERT INTO products(id,tenant_id,name,code,active) VALUES(?,?,?,?,?)',[id,tenant,name,'P-'+id,active]);
  }
  await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(20,2,20,20,'DIRECT',1),(21,2,20,21,'KIT',1),(24,2,20,24,'RECIPE',1),(25,2,20,25,'ZERO',1),(26,2,20,26,'SINGLE',1),(29,2,20,29,'INACTIVE',1),(100,NULL,10,100,'RECIPE',1),(300,3,30,300,'RECIPE',1)");
  await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(27,2,20,300,'FOREIGN-ROOT',1)");
  await query('INSERT INTO products(id,tenant_id,name,code,active) VALUES(?,2,?,?,1)',['9007199254740993','Exact BIGINT product','P-BIGINT']);
  await query('INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(?,2,20,?,\'BIGINT\',1)',['9007199254740995','9007199254740993']);
  await query('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,21,22,2),(2,21,23,1),(3,21,301,999)');
  await query('INSERT INTO products(id,tenant_id,name,code,active) VALUES(?,2,?,?,1)',['9007199254741001','Exact BIGINT physical component','P-BIGINT-COMPONENT']);
  await query('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,21,?,1)',['9007199254741001']);
  await query("INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active,mode) VALUES(1,20,'RECIPE',1,'combo'),(2,20,'DISABLED',0,'combo'),(3,20,'UNBOUND',1,'combo'),(4,20,'ZERO',1,'combo'),(5,20,'SINGLE',1,'single'),(6,20,'INACTIVE',1,'combo'),(10,10,'RECIPE',1,'combo'),(30,30,'RECIPE',1,'combo')");
  await query('INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES(1,22,1),(1,23,2),(1,301,50),(2,22,999),(3,22,1),(4,22,0),(5,23,1),(6,22,2),(10,101,2),(30,301,3)');
  const fixtures=[[1,20,'DIRECT',20,1,10,7],[2,20,'KIT',21,2,15,11],[3,20,'RECIPE',24,3,20,13],[4,20,'DIRECT',300,1,12,0],[5,20,'UNBOUND',null,2,11,1],[6,20,'ZERO',25,1,10,0],[7,20,'SINGLE',26,1,13,-3],[8,20,'MISSING',null,1,14,2],[9,20,'INACTIVE',29,1,15,2],[11,20,'FOREIGN-ROOT',27,1,12,0],[12,20,'BIGINT','9007199254740995',1,12,0],[10,10,'RECIPE',100,2,10,5],[30,30,'RECIPE',300,3,999,900]];
  for(const [id,shop,sku,mapping,quantity,price,profit]of fixtures){
   await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,?,'2026-11-01')",[id,shop,'ORDER-'+id,id%2?'awaiting_packaging':'awaiting_deliver']);
   await query('INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price,estimated_profit) VALUES(?,?,?,?,?,?,?)',[id===12?'9007199254740997':id,id,mapping,sku,quantity,price,profit]);
  }
  await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(13,20,'EMPTY-ITEMS','awaiting_packaging','2026-11-01')");
  await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price,estimated_profit) VALUES(201,3,21,'KIT',1,9,1.2)");
  await query("INSERT INTO inventory_movements(tenant_id,product_id,source_type,source_ref,quantity_delta,status,stock_location) VALUES(2,20,'manual_adjustment','direct',8,'posted','LOCAL'),(2,22,'manual_adjustment','shared',12,'posted','LOCAL'),(2,23,'manual_adjustment','other',6,'posted','LOCAL'),(2,22,'manual_adjustment','fbp',100,'posted','FBP'),(3,22,'manual_adjustment','poison',999,'posted','LOCAL'),(NULL,101,'manual_adjustment','legacy',8,'posted','LOCAL'),(3,301,'manual_adjustment','b',30,'posted','LOCAL')");
  await query("INSERT INTO inventory_movements(tenant_id,product_id,source_type,source_ref,quantity_delta,status,stock_location) VALUES(2,?,'manual_adjustment','bigint-physical-component',8,'posted','LOCAL')",['9007199254741001']);
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
  const ids=fixtures.map(row=>row[0]);
  await t.test('whole detail and summary payload hashes match for A, B and legacy NULL enterprises',async()=>{
   for(const tenant of ['2','3','admin'])for(const summaryOnly of [false,true]){
    const startOld=before.calls.length,startNew=after.calls.length;
    const oldRows=await before.service.orderRowsByIdsMysql(ids,null,tenant,{summaryOnly,bypassCache:true});
    const newRows=await after.service.orderRowsByIdsMysql(ids,null,tenant,{summaryOnly,bypassCache:true});
    assert.equal(hash(newRows),hash(oldRows),tenant+' complete row fields');
    assert.equal(after.calls.length-startNew-(before.calls.length-startOld),summaryOnly?4:0,'bounded summaries add SET/START and exactly two scope preloads');
    const currentCalls=after.calls.slice(startNew),componentSeeds=currentCalls.filter(call=>/SELECT CAST\(product_id AS CHAR\) AS product_id FROM scoped_component_product_ids/.test(call.sql));
    assert.equal(componentSeeds.length,summaryOnly?1:0,'only one component scope query is needed');
    if(summaryOnly&&tenant==='2'){
      const core=currentCalls.find(call=>/^\s*WITH scoped_order_items AS/.test(call.sql));
      const components=JSON.parse(core.params[1]);assert.ok(components.includes('9007199254741001'),'large physical component IDs retain every digit');assert.ok(components.every(id=>typeof id==='string'));
    }
    assert.deepEqual(Array.from(newRows,row=>Number(row.id)),tenant==='2'?[1,2,3,4,5,6,7,8,9,11,12]:tenant==='3'?[30]:[10]);
    if(tenant==='2'){assert.ok(!JSON.stringify(newRows).includes('Secret B'));assert.match(newRows.find(row=>row.id===3).sku_stock_summaries,/RECIPE:0:0:3/);assert.equal(newRows.find(row=>row.id===4).product_ids,'20');assert.equal(newRows.find(row=>row.id===8).product_ids,null);assert.equal(newRows.find(row=>row.id===11).product_ids,null,'mapping to another tenant product must not expose its ID');if(!summaryOnly)assert.equal(Number(newRows.find(row=>row.id===3).profit_purchase_cost),11.5);}
    t.diagnostic(JSON.stringify({tenant,summary:summaryOnly,rows:newRows.length,result_sha256:hash(newRows)}));
    if(tenant==='2'){const exact=newRows.find(row=>Number(row.id)===12);assert.equal(exact.product_ids,'9007199254740993');assert.match(exact.sku_mapping_ids,/9007199254740995/);assert.match(exact.sku_order_item_ids,/9007199254740997/);}
   }
  });
  await t.test('empty seed arrays retain orders without items',async()=>{
   for(const summaryOnly of[false,true])assert.equal(hash(await after.service.orderRowsByIdsMysql([13],null,'2',{summaryOnly,bypassCache:true})),hash(await before.service.orderRowsByIdsMysql([13],null,'2',{summaryOnly,bypassCache:true})));
  });
  await t.test('a mapping committed between item and component preloads cannot split the snapshot',async()=>{
   const writer=await mysql.createConnection({socketPath,user:'root',database,dateStrings:true,timezone:'Z'});
   let changed=false;
   try{
    const expected=await before.service.orderRowsByIdsMysql([2],null,'2',{summaryOnly:true,bypassCache:true});
    const concurrent=new Proxy(connection,{get(target,key){if(key==='query')return async(sql,params=[])=>{
      const result=await target.query(sql,params);
      if(!changed&&/SELECT CAST\(scope_seed.order_item_id AS CHAR\)/.test(sql)){await writer.query('UPDATE sku_mappings SET product_id=20 WHERE id=21');changed=true;}
      return result;
    };const value=target[key];return typeof value==='function'?value.bind(target):value;}});
    const reader=loadTenantOrderService(concurrent);
    assert.equal(hash(await reader.service.orderRowsByIdsMysql([2],null,'2',{summaryOnly:true,bypassCache:true})),hash(expected));
    assert.equal(changed,true,'the independent transaction must commit before the component seed and main query');
    const next=await after.service.orderRowsByIdsMysql([2],null,'2',{summaryOnly:true,bypassCache:true});
    assert.equal(next[0].product_ids,'20','a new snapshot observes the committed mapping');
    assert.notEqual(hash(next),hash(expected));
   }finally{if(changed)await writer.query('UPDATE sku_mappings SET product_id=21 WHERE id=21');await writer.end();}
  });
  await t.test('detail, coverage-dependent and oversized callers retain their original single core statement',async()=>{
   for(const [pageIds,coverage,summaryOnly]of[[ids,null,false],[ids,Promise.resolve(new Map()),true],[Array.from({length:101},(_,i)=>i+1),null,true]]){
    const start=after.calls.length;
    assert.equal(hash(await after.service.orderRowsByIdsMysql(pageIds,coverage,'2',{summaryOnly,bypassCache:true})),hash(await before.service.orderRowsByIdsMysql(pageIds,coverage,'2',{summaryOnly,bypassCache:true})));
    const calls=after.calls.slice(start),core=calls.filter(call=>/^\s*WITH scoped_order_items AS/.test(call.sql));
    assert.equal(core.length,1);assert.ok(!core[0].sql.includes('JSON_TABLE'));
    assert.ok(!calls.some(call=>/START TRANSACTION|SELECT CAST\(scope_seed/.test(call.sql)),'fallback callers do not begin a scope snapshot or seed query');
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
    const old=await execute(before),current=await execute(after);assert.equal(hash(current.rows),hash(old.rows));assert.equal(current.rows.length,20);assert.equal(current.calls.length-old.calls.length,4);
    baseline.push(old);candidate.push(current);
   }
   const counterNames=['Handler_external_lock','Opened_tables','Opened_table_definitions','Table_open_cache_hits','Table_open_cache_misses','Table_open_cache_overflows'];
   const counters=async()=>Object.fromEntries((await query(`SHOW SESSION STATUS WHERE Variable_name IN (${counterNames.map(()=>'?').join(',')})`,counterNames)).map(row=>[row.Variable_name,Number(row.Value)]));
   const coreMetrics=[];
   for(const [variant,call]of[['baseline',baseline[0].core],['candidate',candidate[0].core]]){
    const beforeCounters=await counters(),started=performance.now(),rows=await query(call.sql,call.params),afterCounters=await counters();
    coreMetrics.push({variant,rows:rows.length,wall_ms:Math.round((performance.now()-started)*100)/100,result_sha256:hash(rows),counter_delta:Object.fromEntries(Object.keys(afterCounters).map(key=>[key,afterCounters[key]-beforeCounters[key]]))});
   }
   assert.equal(coreMetrics[0].result_sha256,coreMetrics[1].result_sha256,'complete raw core payload equivalence');
   const explain=async call=>{
    const started=performance.now(),json=JSON.parse((await query('EXPLAIN FORMAT=JSON '+call.sql,call.params))[0].EXPLAIN),planningMs=Math.round((performance.now()-started)*100)/100;
    const text=(await query('EXPLAIN ANALYZE '+call.sql,call.params))[0].EXPLAIN,lines=text.split('\n');
    const nodes=lines.map(line=>{const match=line.match(/\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.]+) loops=(\d+)\)/);return match?{operator:line.trim().split('  (')[0].slice(0,180),end_ms:Number(match[2]),rows:Number(match[3]),loops:Number(match[4])}:null;}).filter(Boolean);
    const aliases=[];const walk=value=>{if(!value||typeof value!=='object')return;if(value.table_name)aliases.push(value.table_name);for(const child of Object.values(value))if(child&&typeof child==='object')walk(child);};walk(json);
    return{planning_ms:planningMs,cost:Number(json.query_block.cost_info.query_cost),root_end_ms:nodes[0]?.end_ms,plan_lines:lines.length,plan_table_references:aliases.length,scoped_product_alias_references:aliases.filter(name=>name==='scoped_product').length,table_alias_counts:Object.fromEntries([...new Set(aliases)].sort().map(name=>[name,aliases.filter(item=>item===name).length])),largest_scan_or_materialize:nodes.filter(node=>!/Nested loop|hash join|Group aggregate|Sort row|Temporary table|scan on <temporary>/i.test(node.operator)).sort((a,b)=>b.end_ms*b.loops-a.end_ms*a.loops).slice(0,15),history_referenced:/order_status_history/.test(call.sql)};
   };
   t.diagnostic(JSON.stringify({phase:'full_uncached_core_sql',page_rows:20,unrelated_orders:large,history_rows:large,unrelated_movements:movements,total_unrelated_recipes:large+noise,baseline_ms:baseline.map(row=>row.ms),candidate_ms:candidate.map(row=>row.ms),core_metrics:coreMetrics,scope_preload_queries:after.calls.filter(call=>/SELECT CAST\(scope_seed/.test(call.sql)).length,one_extra_select_per_core:true,cache_counter_limitation:'global-only variables may include other sessions; exclusive isolated fixture window requested',baseline_plan:await explain(baseline[0].core),candidate_plan:await explain(candidate[0].core),production_latency_claim:false}));
  });
 }finally{await connection.rollback();if(created)await connection.query(`DROP DATABASE \`${database}\``);await connection.end();}
});
