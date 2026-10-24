import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema, loadTenantOrderService } from './helpers/tenant-order-service.js';
import { orderStatusHistoryBusinessFingerprint } from '../src/services/order-history-fingerprint.js';
import { createOrderRoutes, handleOrderRestRoute } from '../src/server/routes/orders.js';
import { createApiDocumentation } from '../src/server/api-docs.js';

test('enterprise history summary contract exposes writer mode without global monitoring counters',()=>{
  const endpoint=createApiDocumentation().sections.flatMap(section=>section.endpoints).find(row=>row.method==='GET'&&row.path==='/api/orders/status-history/summary');
  assert.ok(endpoint);
  const response=endpoint.responses.find(row=>row.status===200).schema;
  const dedupe=response.fields.find(field=>field.name==='dedupe');
  assert.deepEqual(dedupe.fields.map(field=>field.name),['mode']);
  assert.equal(dedupe.additionalProperties,false);
  assert.deepEqual(dedupe.fields[0].enum,['off','shadow','enabled']);
});

test('off/shadow/enabled real history writers produce equal business reports and preserve changed facts',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:120000
},async t=>{
  const f=await createTenantMysqlFixture('history_dedupe');
  const connection=await mysql.createConnection({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:f.database,timezone:'Z'});
  try{
    await createOrderFixtureSchema(f.connection);
    const q=f.query;
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'hist-a','A'),(3,'hist-b','B')");
    await q("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(20,2,'A'),(30,3,'B')");
    await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(1,20,'A-1','delivered','2026-10-20'),(2,20,'A-2','delivered','2026-10-20'),(3,30,'B-1','delivered','2026-10-20'),(4,10,'D-1','delivered','2026-10-20')");
    const observation=(id,hour,extra={})=>({
      order_id:id,shop_id:id===3?30:id===4?10:20,posting_number:id===3?'B-1':id===4?'D-1':`A-${id}`,order_number:`order-${id}`,
      status:'delivering',substatus:'',logistics_status:'delivering',tracking_stage:'delivering',sync_state:'open',
      ordered_at:'2026-10-20 00:00:00',delivered_at:null,customer_id:`customer-${id}`,customer_name:`Name ${id}`,
      buyer_city:'Moscow',buyer_region:'Region',buyer_country:'RU',buyer_district:'',buyer_zip_code:'',buyer_address_tail:'',
      delivery_type:'pickup',delivery_city:'Moscow',delivery_region:'Region',delivery_date_begin:null,delivery_date_end:null,
      warehouse_name:'OGL',tpl_provider:'OGL',cluster_to:'',observed_at:`2026-10-${String(21+Math.floor(hour/24)).padStart(2,'0')} ${String(hour%24).padStart(2,'0')}:00:00`,
      observed_hour:`2026-10-${String(21+Math.floor(hour/24)).padStart(2,'0')} ${String(hour%24).padStart(2,'0')}:00:00`,raw_status_json:'{}',...extra
    });
    const stream=[
      observation(1,0),observation(1,1),observation(1,2),
      observation(1,3,{buyer_city:'Kazan',delivery_city:'Kazan'}),
      observation(1,4,{buyer_city:'Kazan',delivery_city:'Kazan'}),
      observation(1,5,{status:'delivered',tracking_stage:'delivered',logistics_status:'delivered',delivered_at:'2026-10-21 00:00:00'}),
      observation(1,6,{status:'delivered',tracking_stage:'delivered',logistics_status:'delivered',delivered_at:'2026-10-21 00:00:00'}),
      observation(1,7,{status:'delivered',tracking_stage:'delivered',logistics_status:'delivered',delivered_at:'2026-10-21 02:00:00'}),
      observation(2,0,{status:'delivered',tracking_stage:'delivered',logistics_status:'delivered',delivered_at:'2026-10-22 00:00:00'}),
      observation(2,1,{status:'delivered',tracking_stage:'delivered',logistics_status:'delivered',delivered_at:'2026-10-22 00:00:00'}),
      observation(2,2,{status:'delivered',tracking_stage:'delivered',logistics_status:'delivered',delivered_at:'2026-10-22 00:00:00'}),
      observation(3,0,{buyer_city:'B-private',buyer_region:'B-only',status:'delivered',tracking_stage:'delivered',delivered_at:'2026-10-23 00:00:00'}),
      observation(4,0,{buyer_city:'Default',status:'delivered',tracking_stage:'delivered',delivered_at:'2026-10-21 00:00:00'})
    ];
    const modes={}, rawCounts={}, metrics={};
    const business=s=>JSON.parse(JSON.stringify({open_orders:s.open_orders,customer_coverage:s.customer_coverage,
      by_status:s.by_status.map(({status,tracking_stage,count})=>({status,tracking_stage,count})).sort((a,b)=>a.status.localeCompare(b.status)),
      slow_regions:s.slow_regions.map(row=>({...row})),summary_basis:s.summary_basis}));
    for(const mode of ['off','shadow','enabled']){
      await q('DELETE FROM order_status_history');
      const config={orderHistoryDedupeMode:mode},counter={candidates:0,comparisons:0,duplicates:0,skipped:0,comparisonErrors:0};
      const {service}=loadTenantOrderService(connection,{
        extraMethods:['recordOrderStatusHistoryMysql','orderHistoryStateMayBeUnchangedMysql','orderStatusHistoryBusinessFingerprintMysql','orderStatusHistoryRowFingerprintMysql'],
        config,orderHistoryDedupeMetricsMysql:counter,orderStatusHistoryBusinessFingerprint,
        orderStatusHistoryPayloadMysql:(_shop,payload)=>payload,
        recordOrderHistoryDedupeMetricMysql:async()=>{}
      });
      const previous=new Map();
      for(const payload of stream){await service.recordOrderStatusHistoryMysql({id:payload.shop_id},payload,payload.order_id,{},'fixture',previous.get(payload.order_id));previous.set(payload.order_id,payload);}
      const summary=await service.orderStatusHistorySummaryMysql('2');
      modes[mode]=business(summary);rawCounts[mode]=summary.total_history_rows;metrics[mode]={...counter};
      assert.equal(summary.customer_coverage.total,2,'one current fact per enterprise order, not snapshot count');
      assert.equal(summary.by_status.find(row=>row.status==='delivered').count,2,'repeated delivered observations do not multiply orders');
      assert.equal(summary.slow_regions.length,1);
      assert.equal(Number(summary.slow_regions[0].avg_delivery_hours),37,'26h + 48h / two orders, independent of snapshot frequency');
      assert.ok(!JSON.stringify(summary).includes('B-private'));
      assert.equal((await service.orderStatusHistorySummaryMysql('3')).customer_coverage.total,1);
      assert.equal((await service.orderStatusHistorySummaryMysql('admin')).customer_coverage.total,1);
      // Counters contain observations written by A/B/default in this process.
      // Both business route dispatchers must hide them, even for default admins.
      const services={orderStatusHistorySummary:tenant=>service.orderStatusHistorySummaryMysql(tenant)};
      const routes=createOrderRoutes({services});
      const snapshots=new Map();
      const requestFor=tenant=>({method:'GET',_session:{personId:1,role:'admin',tenant:{id:tenant,slug:tenant===1?'default':`hist-${tenant}`}}});
      for(const tenant of [2,3,1]){
        const own=await routes['GET /api/orders/status-history/summary'](requestFor(tenant),new URL('http://fixture/api/orders/status-history/summary?tenant_id=999'));
        assert.deepEqual(Object.keys(own.dedupe),['mode']);assert.equal(own.dedupe.mode,mode);
        assert.equal(own.customer_coverage.total,tenant===2?2:1);
        snapshots.set(tenant,JSON.stringify(own));
      }
      const savedCounter={...counter};
      for(const [index,key] of Object.keys(counter).entries())counter[key]=87001+index;
      for(const tenant of [2,3,1]){
        const result=await handleOrderRestRoute({req:requestFor(tenant),res:{},parts:['api','orders','status-history','summary'],services,json:(_res,payload)=>payload});
        assert.equal(JSON.stringify(result),snapshots.get(tenant),'global process activity cannot change an enterprise summary');
      }
      Object.assign(counter,savedCounter);
      const cities=await q('SELECT DISTINCT buyer_city FROM order_status_history WHERE order_id=1');
      assert.ok(cities.some(row=>row.buyer_city==='Kazan'),'real non-state customer/logistics changes remain');
      if(mode==='enabled'){
        // A failed latest-row comparison falls back to preserving the new row.
        service.mysqlQueryOne=async()=>{throw new Error('isolated comparison failure');};
        const payload=observation(2,3,{status:'delivered',tracking_stage:'delivered',logistics_status:'delivered',delivered_at:'2026-10-22 00:00:00'});
        const result=await service.recordOrderStatusHistoryMysql({id:20},payload,2,{},'fixture',previous.get(2));
        assert.equal(result.inserted,1);assert.equal(counter.comparisonErrors,1);
      }
    }
    assert.deepEqual(modes.off,modes.shadow);assert.deepEqual(modes.off,modes.enabled);
    assert.equal(rawCounts.off,11);assert.equal(rawCounts.shadow,11);assert.equal(rawCounts.enabled,5);
    assert.equal(metrics.shadow.duplicates,6);assert.equal(metrics.shadow.skipped,0);assert.equal(metrics.enabled.skipped,6);
    t.diagnostic(`Isolated identical observation replay: off=${rawCounts.off}, shadow=${rawCounts.shadow}, enabled=${rawCounts.enabled} own-enterprise rows; business counts/coverage/37-hour average equal. Production default/config unchanged.`);
  }finally{await connection.end();await f.cleanup();}
});
