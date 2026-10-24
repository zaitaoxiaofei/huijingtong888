import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { performance } from 'node:perf_hooks';
import { hashPassword } from '../src/auth-password.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema } from './helpers/tenant-order-service.js';
import { createAiCreditLedger } from '../src/services/ai-credit-ledger.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=value=>createHash('sha256').update(value).digest('hex');
const root=fileURLToPath(new URL('../',import.meta.url));

// Installed BEFORE the real server imports its SDKs. No upstream request can
// leave this fixture; the real Ozon sync/task/auth/storage code still executes.
async function installNetworkFixture({eventFile,productsPerShop,delayMs}){
  const fs=await import('node:fs/promises'),original=globalThis.fetch;
  globalThis.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    if(['127.0.0.1','localhost','[::1]'].includes(url.hostname))return original(input,options);
    if(url.hostname!=='api-seller.ozon.ru'){
      await fs.appendFile(eventFile,JSON.stringify({kind:'blocked',host:url.hostname,path:url.pathname})+'\n');
      throw new Error('External network disabled by isolated pilot fixture');
    }
    const headers=new Headers(options.headers),shop=Number(headers.get('Client-Id'));
    const body=JSON.parse(options.body||'{}');
    await fs.appendFile(eventFile,JSON.stringify({kind:'ozon-fixture',shop,path:url.pathname,at_ms:Date.now()})+'\n');
    await new Promise(resolve=>setTimeout(resolve,delayMs));
    let data;
    if(url.pathname==='/v3/product/list'){
      const start=Number(body.last_id||0),size=100,end=Math.min(productsPerShop,start+size);
      data={result:{items:Array.from({length:end-start},(_,index)=>({product_id:shop*100000+start+index+1,
        offer_id:`BG-${shop}-${start+index+1}`,sku:shop*100000+start+index+1})),last_id:end<productsPerShop?String(end):'',total:productsPerShop}};
    }else if(url.pathname==='/v3/product/info/list'){
      data={items:(body.product_id||[]).map(id=>({id,sku:id,offer_id:`BG-${shop}-${id-shop*100000}`,
        name:`BACKGROUND-PRIVATE-T${Math.floor(shop/10)}-${id}`,price:'100',currency_code:'RUB',visibility:'VISIBLE',images:[],sources:[]}))};
    }else{
      await fs.appendFile(eventFile,JSON.stringify({kind:'unsupported',shop,path:url.pathname})+'\n');
      throw new Error('Unexpected upstream route in isolated pilot fixture');
    }
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  };
}

function summarize(samples){
  const sorted=samples.map(row=>row.ms).sort((a,b)=>a-b),percentile=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]||0;
  return{requests:samples.length,p50_ms:+percentile(.5).toFixed(2),p95_ms:+percentile(.95).toFixed(2),max_ms:+(sorted.at(-1)||0).toFixed(2),
    success:samples.filter(row=>row.status===200).length,errors:samples.filter(row=>row.status!==200).length,
    busy:samples.filter(row=>row.status===503&&/繁忙|busy|pool/i.test(JSON.stringify(row.error||''))).length,
    error_ratio:samples.length?samples.filter(row=>row.status!==200).length/samples.length:0,
    busy_ratio:samples.length?samples.filter(row=>row.status===503&&/繁忙|busy|pool/i.test(JSON.stringify(row.error||''))).length/samples.length:0};
}

test('real HTTP pilot: 30 identities/default plus four enterprises, AI credit boundaries and mixed local workload',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL; exclusively uses local 8788',timeout:480000
},async t=>{
  const probe=net.createServer();
  await new Promise((resolve,reject)=>probe.once('error',reject).listen(8788,'127.0.0.1',resolve));
  await new Promise(resolve=>probe.close(resolve));
  const ordersPerTenant=Number(process.env.PILOT_CAPACITY_ORDERS_PER_TENANT||10000);
  const draftsPerTenant=Number(process.env.PILOT_CAPACITY_DRAFTS_PER_TENANT||1000);
  const rounds=Number(process.env.PILOT_CAPACITY_ROUNDS||6),productsPerShop=Number(process.env.PILOT_CAPACITY_SYNC_PRODUCTS||800);
  for(const value of [ordersPerTenant,draftsPerTenant,rounds,productsPerShop])assert.ok(Number.isSafeInteger(value)&&value>0&&value<=20000);
  const f=await createTenantMysqlFixture('pilot_http_load');
  const directory=await mkdtemp(path.join(os.tmpdir(),'ozon-pilot-load-'));
  const eventFile=path.join(directory,'network.jsonl'),preload=path.join(directory,'network-fixture.mjs');
  const pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:f.database,connectionLimit:4,timezone:'Z'});
  const transaction=async work=>{const c=await pool.getConnection();try{await c.beginTransaction();const r=await work(c);await c.commit();return r;}catch(e){await c.rollback();throw e;}finally{c.release();}};
  const q=f.query,base='http://127.0.0.1:8788',password=`Load-${randomUUID()}!`,samples=[];
  const roles=['owner','operations','operations','procurement','packing','operations'],identities=[];
  const report={date_beijing:'2026-10-24',environment:{kind:'local-isolated-http',port:8788,platform:os.platform(),
    logical_cpus:os.cpus().length,total_memory_bytes:os.totalmem(),db_pool_max:10,db_pool_queue_limit:100,
    upstream:'Ozon fixture responses; 80ms artificial per request; all other fetch hosts blocked',external_writes:0},
    population:{enterprises:5,includes_default:true,active_authenticated_identities:30,roles,orders_per_tenant:ordersPerTenant,drafts_per_tenant:draftsPerTenant,
      total_orders:5*ordersPerTenant,total_order_items:5*ordersPerTenant,total_raw_orders:5*ordersPerTenant,total_drafts:5*draftsPerTenant,
      draft_manual_facts_filler_bytes:2048,total_inventory_products:500,total_sku_mappings:500,total_opening_stock_movements:500,total_ogl_snapshots:5},
    interpretation:'Application first-touch and warm HTTP synthetic sessions; not cold MySQL disk pages, browser rendering, real paid AI, real Ozon latency, 30 human users or ECS capacity certification.',
    ai_credit_http:{},phases:{},failures:[]};
  let child,output='';
  const request=async(url,identity,method='GET',body,phase)=>{
    const started=performance.now();let status=0,data,headers;
    try{
      const response=await fetch(base+url,{method,signal:AbortSignal.timeout(30000),headers:{...(identity?.token?{Authorization:`Bearer ${identity.token}`}:{ }),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      status=response.status;headers=response.headers;const text=await response.text();try{data=JSON.parse(text);}catch{data=text;}
    }catch(error){data={error:error.name};}
    const route=url.startsWith('/api/orders?')&&url.includes('includeRows=0')?'/api/orders [counts]':url.split('?')[0];
    const sample={phase:phase||'functional',route,tenant:identity?.tenant||null,role:identity?.role||null,status,ms:performance.now()-started,...(status===200?{}:{error:data})};
    if(phase)samples.push(sample);
    return{status,data,headers};
  };
  const stop=async()=>{if(!child||child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');await exited;child=null;};
  const start=async()=>{
    await writeFile(eventFile,'','utf8');
    await writeFile(preload,`await (${installNetworkFixture.toString()})(${JSON.stringify({eventFile,productsPerShop,delayMs:80})});\n`,'utf8');
    child=spawn(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('../src/server.js',import.meta.url))],{cwd:directory,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...f.env,
      HOST:'127.0.0.1',APP_BASE_URL:base,DEPLOYMENT_CANDIDATE:'0',DB_POOL_MAX:'10',DB_POOL_QUEUE_LIMIT:'100',SCHEDULED_JOBS_ENABLED:'0',BACKGROUND_OZON_STOCK_SYNC_ENABLED:'false',BACKGROUND_OZON_CATEGORY_SYNC_ENABLED:'false',
      SITE_ACCESS_PASSWORD:'',UPLOADS_ROOT:path.join(directory,'uploads')}});
    child.stdout.on('data',x=>{output=(output+x).slice(-30000);});child.stderr.on('data',x=>{output=(output+x).slice(-30000);});
    const until=Date.now()+90000;
    while(Date.now()<until){if(child.exitCode!==null)throw Error(`Pilot HTTP startup failed: ${output}`);try{const r=await fetch(base+'/api/ready',{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).ok)return;}catch{}await sleep(200);}
    throw Error(`Pilot HTTP readiness timeout: ${output}`);
  };
  const login=async identity=>{
    const result=await request('/api/auth/login',null,'POST',{username:identity.username,password});
    assert.equal(result.status,200,JSON.stringify(result.data));assert.ok(result.data.token,JSON.stringify(result.data));
    identity.token=result.data.token;identity.user=result.data.user;return identity;
  };
  const expect=async(url,actor,method,body,status=200)=>{const result=await request(url,actor,method,body);assert.equal(result.status,status,`${method||'GET'} ${url}: ${JSON.stringify(result.data)}`);return result;};
  try{
    await createOrderFixtureSchema(f.connection);
    // Run the migration entrypoint, not implicit table creation on wallet reads.
    const migration=spawn(process.execPath,[fileURLToPath(new URL('../scripts/migrate-ai-credits.mjs',import.meta.url)),`--database=${f.database}`,`--mysql-admin-socket=${process.env.TENANT_TEST_MYSQL_SOCKET}`,'--apply'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let migrationOutput='';migration.stdout.on('data',c=>{migrationOutput+=c;});migration.stderr.on('data',c=>{migrationOutput+=c;});
    assert.equal((await once(migration,'exit'))[0],0,migrationOutput);assert.equal(JSON.parse(migrationOutput).business_rows_changed,0);
    const digits='(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)';
    await q(`CREATE TABLE fixture_numbers(n INT PRIMARY KEY) SELECT a.n+10*b.n+100*c.n+1000*d.n+10000*e.n n FROM ${digits} a CROSS JOIN ${digits} b CROSS JOIN ${digits} c CROSS JOIN ${digits} d CROSS JOIN ${digits} e WHERE a.n+10*b.n+100*c.n+1000*d.n+10000*e.n < ?`,[Math.max(ordersPerTenant,draftsPerTenant,100)]);
    const encoded=hashPassword(password);
    for(let tenant=1;tenant<=5;tenant++){
      await q('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)',[tenant,tenant===1?'default':`load-${tenant}`,`LOAD-T${tenant}`]);
      for(let index=0;index<roles.length;index++){
        const role=roles[index],id=tenant*100+index,identity={id,tenant,role,username:`load${id}`};identities.push(identity);
        await q('INSERT INTO people(id,name,username,password_hash,role) VALUES(?,?,?,?,?)',[id,`LOAD-P${id}`,identity.username,encoded,role==='owner'?'admin':role]);
        await q('INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,?,JSON_ARRAY(?))',[tenant,id,role==='owner'?'owner':'member',role==='owner'?'admin':role]);
      }
      for(const offset of [0,1])await q("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(?,?,?,?,'isolated-fixture-key')",[tenant*10+offset,tenant===1&&offset===0?null:tenant,`LOAD-T${tenant}-SHOP${offset}`,String(tenant*10+offset)]);
      await q('INSERT INTO tenant_ai_limits(tenant_id,monthly_request_limit) VALUES(?,0)',[tenant]);
      await q(`INSERT INTO products(id,tenant_id,name,code,purchase_cost) SELECT ?+n,?,?,CONCAT('LOAD-PRODUCT-',?, '-',n),10 FROM fixture_numbers WHERE n<100`,[tenant*10000,tenant,`LOAD-T${tenant}-INVENTORY`,tenant]);
      await q(`INSERT INTO sku_mappings(tenant_id,shop_id,product_id,ozon_sku,offer_id,person_id)
        SELECT ?,?+MOD(n,2),?+n,CAST(?+n AS CHAR),CONCAT('LOAD-OFFER-',?,'-',n),? FROM fixture_numbers WHERE n<100`,[tenant,tenant*10,tenant*10000,tenant*10000000,tenant,tenant*100]);
      await q(`INSERT INTO inventory_movements(tenant_id,product_id,source_type,source_ref,quantity_delta,stock_location,unit_cost,amount)
        SELECT ?,?+n,'stocktake',CONCAT('LOAD-OPENING-',?,'-',n),100,'LOCAL',10,1000 FROM fixture_numbers WHERE n<100`,[tenant,tenant*10000,tenant]);
      await q(`INSERT INTO inventory_current(real_product_id,available_stock) SELECT ?+n,100 FROM fixture_numbers WHERE n<100`,[tenant*10000]);
      await q(`INSERT INTO orders(id,shop_id,posting_number,order_number,status,tracking_stage,logistics_status,ordered_at)
        SELECT ?+n,?+MOD(n,2),CONCAT(LPAD(?+n,10,'0'),'-0001-1'),CONCAT('PARENT-T',?,'-',n),
        ELT(1+MOD(n,5),'awaiting_packaging','awaiting_deliver','delivering','delivered','cancelled'),
        ELT(1+MOD(n,5),'awaiting_packaging','awaiting_deliver','delivering','delivered','cancelled'),
        ELT(1+MOD(n,5),'awaiting_packaging','awaiting_deliver','delivering','delivered','cancelled'),DATE_SUB('2026-10-24',INTERVAL MOD(n,80) DAY)
        FROM fixture_numbers WHERE n<?`,[tenant*100000,tenant*10,tenant*10000000,tenant,ordersPerTenant]);
      await q(`INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price) SELECT ?+n,?+n,CAST(?+MOD(n,100) AS CHAR),1,100 FROM fixture_numbers WHERE n<?`,[tenant*100000,tenant*100000,tenant*10000000,ordersPerTenant]);
      await q(`UPDATE order_items oi JOIN orders o ON o.id=oi.order_id JOIN sku_mappings sm ON sm.shop_id=o.shop_id AND sm.ozon_sku=oi.ozon_sku
        SET oi.sku_mapping_id=sm.id WHERE oi.id>=? AND oi.id<?`,[tenant*100000,tenant*100000+ordersPerTenant]);
      await q(`INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json)
        SELECT o.shop_id,o.posting_number,o.status,JSON_OBJECT('posting_number',o.posting_number,'status',o.status,'raw',JSON_OBJECT('delivery_method',JSON_OBJECT('id',77,'name',CONCAT(ELT(1+MOD(n.n,3),'OGL','CEL','GUOO'),' pickup'),'warehouse','Local'),'provenance',REPEAT('x',1024)))
        FROM fixture_numbers n JOIN orders o ON o.id=?+n.n WHERE n.n<?`,[tenant*100000,ordersPerTenant]);
    }
    const platform={id:9999,role:'platform',username:'load-platform'};
    await q("INSERT INTO people(id,name,username,password_hash,role) VALUES(9999,'LOAD-PLATFORM','load-platform',?,'technical')",[encoded]);
    await q("INSERT INTO platform_grants(person_id,role,active,reason) VALUES(9999,'super_admin',1,'Explicit isolated HTTP fixture grant')");
    await start();
    for(const actor of identities)await login(actor);await login(platform);
    for(let tenant=1;tenant<=5;tenant++){
      const key=tenant===1?'admin':String(tenant),owner=identities.find(x=>x.tenant===tenant&&x.role==='owner');
      await q(`INSERT INTO listing_drafts(tenant_id,product_name,source_urls_json,source_images_json,manual_facts_json,ai_payload_json,created_by_person_id)
        SELECT ?,CONCAT('LOAD-T',?,'-DRAFT-',n),'[]','[]',JSON_OBJECT('fixture',REPEAT('m',2048)),'{}',? FROM fixture_numbers WHERE n<?`,[key,tenant,owner.id,draftsPerTenant]);
      const memberRows=await q("SELECT id,shop_id,posting_number FROM orders WHERE shop_id=? AND status='awaiting_deliver' AND MOD(id-?,3)=0 ORDER BY id LIMIT 20",[tenant*10,tenant*100000]);
      await q(`INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,
        departure_date,official_carriage_id,official_status,official_result_json,created_by)
        VALUES(?,?,?,?,?,1,'2026-10-23',?,'observed',?,?)`,[tenant,tenant,`LOAD-T${tenant}-BATCH`,`LOAD-T${tenant}-REQUEST`,tenant*10,String(901+tenant),JSON.stringify({source:'official_discovery',last_observed_at:'2026-10-23T10:00:00Z',carriage:{id:String(901+tenant),carriage_id:String(901+tenant),status:'formed',departure_date:'2026-10-23',containers_count:1,postings_count:memberRows.length,created_at:'2026-10-23T08:00:00Z',available_actions:[]},official_posting_numbers:memberRows.map(x=>x.posting_number)}),owner.id]);
      for(const member of memberRows)await q('INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,official_member) VALUES(?,?,?,?,?,?,1)',[tenant,tenant,member.id,member.id,member.shop_id,member.posting_number]);
      report.population.total_ogl_members=(report.population.total_ogl_members||0)+memberRows.length;
    }
    await t.test('all eight AI credit HTTP endpoints enforce scoped wallet/audit/entries/tasks and fresh platform management',async()=>{
      const a=identities.find(x=>x.tenant===2&&x.role==='operations'),b=identities.find(x=>x.tenant===3&&x.role==='operations'),owner=identities.find(x=>x.tenant===2&&x.role==='owner');
      assert.ok([401,403].includes((await request('/api/ai-credits/wallet')).status));
      for(const tenantId of [1,2,3])await expect('/api/platform/ai-credits/accounts',platform,'POST',{tenantId,status:'active'});
      await expect('/api/platform/ai-credits/prices',platform,'POST',{priceKey:'http-image',version:1,pointsPerResult:10});
      for(const tenantId of [1,2,3])for(let index=0;index<3;index++)await expect('/api/platform/ai-credits/recharges',platform,'POST',{tenantId,reference:`fixture-payment-${tenantId}-${index}`,points:100*tenantId,reason:`Confirmed fixture T${tenantId} payment ${index}`});
      for(const actor of [owner,a,b,identities.find(x=>x.role==='packing')])for(const action of ['accounts','prices','recharges','reconcile'])await expect(`/api/platform/ai-credits/${action}`,actor,'POST',{tenantId:3,status:'active',priceKey:'bad',version:99,pointsPerResult:1,points:1,reference:'bad',reason:'not permitted'},403);
      const wa=await expect('/api/ai-credits/wallet?tenantId=3&tenant_id=3',a);assert.equal(Number(wa.data.tenant_id),2);assert.equal(Number(wa.data.available_points),600);assert.equal(wa.headers.get('cache-control'),'no-store');
      assert.equal(Number((await expect('/api/ai-credits/wallet?tenantId=2',b)).data.available_points),900);
      const page1=await expect('/api/ai-credits/entries?tenantId=3&limit=2',a);assert.equal(page1.data.length,2);assert.ok(page1.data.every(x=>x.reason.includes('T2')));
      const page2=await expect(`/api/ai-credits/entries?limit=2&before=${page1.data.at(-1).id}`,a);assert.equal(page2.data.length,1);assert.ok(page2.data.every(x=>x.reason.includes('T2')));
      assert.equal(new Set([...page1.data,...page2.data].map(x=>x.id)).size,3);
      assert.equal((await expect('/api/ai-credits/audit?tenantId=3',a)).data.consistent,true);
      const ledger=createAiCreditLedger({transaction}),session={personId:a.id,tenant:{id:2,slug:'load-2'}};
      const task=await ledger.reserve(session,{idempotencyKey:'http-private-task',priceKey:'http-image',inputSha256:digest('private-a')});
      const tried=await ledger.startAttempt(session,task.id,{attemptKey:'first',provider:'fixture',model:'fixture'});
      await ledger.recordOutcome(session,task.id,{attemptId:tried.id,outcome:'unknown',outcomeSha256:digest('unknown'),receipt:'fixture-only'});
      assert.equal((await expect(`/api/ai-credits/tasks/${task.id}?tenantId=3`,a)).data.id,task.id);
      await expect(`/api/ai-credits/tasks/${task.id}?tenantId=2`,b,undefined,undefined,404);
      await expect('/api/platform/ai-credits/reconcile',platform,'POST',{tenantId:2,taskId:task.id,successfulResults:0,reason:'Fixture supplier confirmed no completed result'});
      assert.equal((await expect('/api/ai-credits/audit',a)).data.consistent,true);
      await q('UPDATE platform_grants SET active=0 WHERE person_id=9999');
      for(const action of ['accounts','prices','recharges','reconcile']){
        const rejected=await request(`/api/platform/ai-credits/${action}`,platform,'POST',{tenantId:2,status:'active',priceKey:'revoked',version:2,pointsPerResult:1,reference:'revoked',points:1,reason:'must reject',taskId:task.id,successfulResults:0});
        assert.ok([401,403].includes(rejected.status),'revoked platform-only login may invalidate its session entirely');
      }
      await q('UPDATE platform_grants SET active=1 WHERE person_id=9999');
      report.ai_credit_http={passed:true,route_count:8,enterprise_balance_isolation:true,pagination:true,task_isolation:true,ordinary_management_denied:true,fresh_platform_revocation:true,real_supplier_calls:0};
    });
    const endpoints=actor=>{
      const orders='/api/orders?paged=1&page=1&pageSize=20&status=all&includeRows=1&includeCounts=0&includeLogisticsOptions=0&dateFrom=2026-08-01&dateTo=2026-10-24';
      const ogl='/api/ogl-dispatch/official-carriages?source=snapshot&date_from=2026-10-20&date_to=2026-10-24';
      const drafts='/api/listing/drafts?paged=1&page=1&pageSize=20&lightweight=1&projectOnly=1&includePublished=1&sortBy=created_at';
      const detail=`/api/ogl-dispatch/official-carriage?source=snapshot&id=${901+actor.tenant}&shop_id=${actor.tenant*10}&date=2026-10-23`;
      return actor.role==='operations'||actor.role==='owner'?[orders,ogl,drafts,detail]:[orders,ogl,detail,'/api/ai-credits/wallet'];
    };
    const read=async(actor,url,phase)=>{
      const result=await request(url,actor,'GET',undefined,phase);
      if(result.status!==200){report.failures.push({phase,tenant:actor.tenant,role:actor.role,route:url.split('?')[0],status:result.status,error:result.data});return;}
      if(url.startsWith('/api/orders?')){
        if(url.includes('includeRows=0'))assert.equal(Number(result.data.counts?.all),ordersPerTenant,'counts must include exactly the current enterprise orders');
        else assert.ok(result.data.rows?.length>0,'order page must contain real fixture rows');
        assert.ok((result.data.rows||[]).every(x=>Math.floor(Number(x.shop_id)/10)===actor.tenant),'order result must remain in the current enterprise');
      }
      if(url.startsWith('/api/listing/drafts?')){
        assert.ok(result.data.rows?.length>0,'draft page must contain real fixture rows');
        assert.ok(result.data.rows.every(x=>String(x.product_name).startsWith(`LOAD-T${actor.tenant}-`)),'draft result must remain in the current enterprise');
      }
      if(url.includes('/official-carriages')){
        assert.equal(result.data.rows?.length,1,'exactly one saved OGL snapshot belongs to this enterprise');
        assert.ok(result.data.rows.every(x=>Math.floor(Number(x.dispatch_shop.id)/10)===actor.tenant),'OGL snapshot must retain original enterprise shop');
      }
      if(url.includes('/official-carriage?')){
        assert.ok(result.data.members?.length>0,'OGL detail must contain fixture members');
        assert.ok(result.data.members.every(x=>x.matched_local&&Math.floor(Number(x.shop_id)/10)===actor.tenant),'OGL detail must match the owning source shops');
      }
    };
    const countUrl='/api/orders?paged=1&status=all&includeRows=0&includeCounts=1&includeLogisticsOptions=0&dateFrom=2026-08-01&dateTo=2026-10-24';
    await t.test('application first-touch requests keep their own business records',async()=>{
      for(const actor of identities.filter(x=>x.role==='owner'))for(const endpoint of endpoints(actor))await read(actor,endpoint,'application_first_touch');
      await Promise.all(identities.filter(x=>x.role==='owner').map(actor=>read(actor,countUrl,'application_first_touch')));
      assert.equal(report.failures.length,0,JSON.stringify(report.failures));
    });
    await t.test('30 authenticated scripted identities read warm pages while five isolated real sync workers use upstream fixtures',async()=>{
      const operators=identities.filter(x=>x.role==='operations').filter((x,index,all)=>all.findIndex(y=>y.tenant===x.tenant)===index);
      for(const actor of operators)await expect('/api/sync/online-products',actor,'POST',{shop_id:actor.tenant*10,concurrency:2});
      const running=await Promise.all(operators.map(async actor=>({tenant:actor.tenant,running:(await expect('/api/sync/online-products/status',actor)).data.running})));
      assert.ok(running.every(x=>x.running),'all five isolated workers must overlap the warm workload');
      report.background_overlap={running_at_warm_start:running,warm_started_at_ms:Date.now()};
      await Promise.all([...identities.map(async(actor,index)=>{for(let round=0;round<rounds;round++){const routes=endpoints(actor);await read(actor,routes[(round+index)%routes.length],'warm_mixed');await sleep(50+(index%5)*10);}}),
        ...identities.filter(x=>x.role==='owner').map(actor=>read(actor,countUrl,'warm_mixed'))]);
      report.background_overlap.warm_finished_at_ms=Date.now();
      const until=Date.now()+120000;let statuses;
      do{statuses=await Promise.all(operators.map(async actor=>({tenant:actor.tenant,...(await expect('/api/sync/online-products/status',actor)).data})));if(statuses.every(x=>!x.running))break;await sleep(100);}while(Date.now()<until);
      assert.ok(statuses.every(x=>!x.running),'fixture background tasks must finish before teardown');
      report.background=statuses.map(x=>({tenant:x.tenant,running:x.running,error:x.error||'',result:x.result}));
      assert.ok(statuses.every(x=>!x.error),JSON.stringify(report.background));
      const saved=await q("SELECT shop_id,COUNT(*) n,MIN(name) sample FROM online_products WHERE name LIKE 'BACKGROUND-PRIVATE-%' GROUP BY shop_id");
      assert.equal(saved.length,5);assert.ok(saved.every(x=>Number(x.n)===productsPerShop));
      assert.ok(saved.every(x=>x.sample.startsWith(`BACKGROUND-PRIVATE-T${Math.floor(x.shop_id/10)}-`)));
      report.background_rows=saved.map(({shop_id,n})=>({shop_id,rows:Number(n)}));
      const unexpected=report.failures.filter(x=>x.status!==503);assert.equal(unexpected.length,0,JSON.stringify(unexpected));
    });
    const events=(await readFile(eventFile,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    report.network={fixture_calls:events.filter(x=>x.kind==='ozon-fixture').length,fixture_calls_during_warm:events.filter(x=>x.at_ms>=report.background_overlap.warm_started_at_ms&&x.at_ms<=report.background_overlap.warm_finished_at_ms).length,blocked_or_unsupported:events.filter(x=>x.kind!=='ozon-fixture')};
    assert.equal(report.network.blocked_or_unsupported.length,0,JSON.stringify(report.network.blocked_or_unsupported));
    assert.ok(report.network.fixture_calls_during_warm>0,'supplier substitutes must remain active during foreground HTTP reads');
    assert.equal(report.ai_credit_http.passed,true,'functional wallet isolation checks must pass before this run is complete');
    for(const phase of ['application_first_touch','warm_mixed']){
      const rows=samples.filter(x=>x.phase===phase);report.phases[phase]={...summarize(rows),by_route:Object.fromEntries([...new Set(rows.map(x=>x.route))].map(route=>[route,summarize(rows.filter(x=>x.route===route))]))};
    }
    report.observed_local_thresholds={p95_read_ms:2000,max_error_ratio:0,max_busy_ratio:.01,not_customer_sla:true};
    report.local_thresholds_met=Object.values(report.phases).every(x=>[x,...Object.values(x.by_route)].every(r=>r.p95_ms<=2000&&r.error_ratio===0&&r.busy_ratio<=.01));
    report.completed=true;report.production_capacity_certified=false;
    t.diagnostic(JSON.stringify({population:report.population,phases:report.phases,local_thresholds_met:report.local_thresholds_met}));
  }catch(error){report.failure={name:error.name,message:error.message};throw error;}
  finally{
    report.samples=samples;await mkdir(path.join(root,'.verification'),{recursive:true});
    await writeFile(path.join(root,'.verification','pilot-capacity-credits-http-report.json'),JSON.stringify(report,null,2),'utf8');
    await writeFile(path.join(root,'.verification','pilot-capacity-credits-http-child.log'),output,'utf8');
    await stop();await pool.end();await f.cleanup();
    const absolute=path.resolve(directory);if(!absolute.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(absolute).startsWith('ozon-pilot-load-'))throw Error('Unexpected local fixture cleanup path');
    await rm(absolute,{recursive:true,force:true});
  }
});
