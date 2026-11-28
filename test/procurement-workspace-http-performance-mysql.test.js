import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('actual procurement workspace HTTP reads persisted demand within one second with exact paging and current membership', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires disposable socket-only MySQL', timeout: 180000
}, async t => {
  const f = await createTenantMysqlFixture('procure_http');
  f.useEnvironment();
  const api = await import('../src/services/mysql-cutover.js');
  const {createOperationsRoutes} = await import('../src/server/routes/operations.js');
  const {INVENTORY_DEMAND_SNAPSHOT_VERSION, waitForInventoryDemandJobs} = await import('../src/services/inventory-demand-snapshot.js');
  const {closeMysqlPool} = await import('../src/mysql-pool.js');
  let server;
  try {
    await f.query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await f.query("INSERT INTO people(id,name,role) VALUES(2,'A buyer','procurement'),(3,'B buyer','procurement')");
    await f.query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,2,'member',JSON_ARRAY('procurement'),1),(3,3,'member',JSON_ARRAY('procurement'),1)");
    await api.prepareInventoryFlowMysql();
    await f.query('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
    await api.procurementRequestsMysql({grouped:'1',compact:'1'},2);
    const products = Array.from({length:1029}, (_,i) => [i+1,i<1000?2:3,`Fixture product ${i+1}`,`P-${i+1}`]);
    await f.connection.query('INSERT INTO products(id,tenant_id,name,inventory_number) VALUES ?', [products]);
    const state = product_id => ({product_id,physical:10,free:0,order_demand:product_id,
      incoming:0,demands:[],requests:[],applications:[],supply_plan:{known:true,fbs_known:true,
        order_quantity:product_id,required_fbs:1,required_fbp:0,required_purchase:1,optional_purchase:0}});
    const saved = Array.from({length:1000},(_,i)=>state(i+1));
    const at = new Date().toISOString();
    await f.query('INSERT INTO inventory_demand_snapshots(tenant_id,version,payload_json,calculated_at) VALUES(?,?,?,?),(?,?,?,?)', [
      2,INVENTORY_DEMAND_SNAPSHOT_VERSION,JSON.stringify({rows:saved,full_calculated_at:at}),at.slice(0,23).replace('T',' '),
      3,INVENTORY_DEMAND_SNAPSHOT_VERSION,JSON.stringify({rows:[state(1029)],full_calculated_at:at}),at.slice(0,23).replace('T',' ')
    ]);
    const routes = createOperationsRoutes({services:{},readJson:async()=>{throw Error('Read-only fixture');}});
    server=createServer(async(req,res)=>{
      try {
        // The harness supplies a session; the real route reauthorizes membership
        // and permission in MySQL. Token issuance/middleware are outside this test.
        req._session={personId:2,roles:['procurement'],tenant:{id:2,slug:'a',role:'member'}};
        const url=new URL(req.url,'http://127.0.0.1:8788');
        const handler=routes[`${req.method} ${url.pathname}`];
        if(!handler){res.statusCode=404;res.end();return;}
        const payload=await handler(req,url);
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(payload));
      }catch(error){res.statusCode=error.statusCode||500;res.end(JSON.stringify({error:error.message}));}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8788,'127.0.0.1',resolve);});
    const timings=[];
    const read=async (extra,mobile=false)=>{
      const start=performance.now();
      const query=mobile?'task=required&page=1&pageSize=20&query=&inventoryType=all&searchMode=inventory_id&view=workspace&compact=1&snapshot_only=1':'task=required&scope=all&page=1&pageSize=50&view=workspace&compact=1';
      const response=await fetch('http://127.0.0.1:8788/api/inventory-workflow/alerts?'+query+extra,{signal:AbortSignal.timeout(6000)});
      const payload=await response.json(),ms=performance.now()-start;
      timings.push(Math.round(ms));return{response,payload,ms};
    };
    // The background reader is intentionally held after the persisted snapshot
    // is read: HTTP must not await a historical rebuild or fabricate empty totals.
    await f.connection.query('LOCK TABLES inventory_demand_snapshots READ, products READ');
    try {
      for(const [suffix,size,start] of [['',50,1000],['&page=2',50,950],['&pageSize=100',100,1000]]){
        const {response,payload,ms}=await read(suffix);
        assert.equal(response.status,200,JSON.stringify(payload));
        assert.equal(payload.snapshot.available,true);
        assert.equal(payload.total,1000);
        assert.equal(payload.rows.length,size);
        assert.deepEqual(payload.rows.map(r=>r.product_id),Array.from({length:size},(_,i)=>start-i));
        assert.ok(payload.rows.every(r=>r.product_id<=1000&&r.workflow.supply_plan.required_purchase===1));
        assert.ok(ms<1000,`Complete local HTTP response took ${ms.toFixed(1)}ms`);
      }
      for(const [suffix,size,start] of [['',20,1000],['&page=2',20,980],['&pageSize=50',50,1000],['&pageSize=100',100,1000]]){
        const {response,payload,ms}=await read(suffix,true);
        assert.equal(response.status,200);assert.equal(payload.snapshot.available,true);assert.equal(payload.total,1000);
        assert.equal(payload.rows.length,size);assert.deepEqual(payload.rows.map(r=>r.product_id),Array.from({length:size},(_,i)=>start-i));
        assert.ok(ms<1000,`Complete mobile HTTP response took ${ms.toFixed(1)}ms`);
      }
      const {response,payload}=await read('&product_id=1029');
      assert.equal(response.status,200);assert.deepEqual(payload.rows,[]);assert.equal(payload.total,0);
    } finally { await f.connection.query('UNLOCK TABLES'); }
    await f.query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
    assert.equal((await read('')).response.status,403,'Persisted rows never bypass a revoked membership');
    t.diagnostic(`HTTP transport + real route/MySQL authorization, 1029 synthetic products: ${timings.join(', ')}ms. Includes first snapshot load; no production SLA claim.`);
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    await waitForInventoryDemandJobs();
    await closeMysqlPool();await f.cleanup();
  }
});
