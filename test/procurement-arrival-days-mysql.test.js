import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('purchase-day queues retain cross-day search, old pending work, partial lineage and optional arrival notes',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async()=>{
 const f=await createTenantMysqlFixture('arrival_days');f.useEnvironment();const q=f.query;
 const api=await import('../src/services/mysql-cutover.js');
 const {createProcurementArrivals}=await import('../src/services/procurement-arrivals.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const buyer={personId:7,tenant:{id:2,slug:'a'}},warehouse={personId:8,tenant:{id:2,slug:'a'}},foreign={personId:9,tenant:{id:3,slug:'b'}};
 const service=createProcurementArrivals();
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(7,'A buyer','procurement'),(8,'A warehouse','packing'),(9,'B buyer','procurement')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,7,'member',JSON_ARRAY('procurement'),1),(2,8,'member',JSON_ARRAY('packing'),1),(3,9,'member',JSON_ARRAY('procurement'),1)");
  await api.prepareInventoryFlowMysql();
  await q('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await api.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  await q("INSERT INTO products(id,tenant_id,name,code) VALUES(200,2,'Target stock','TARGET-EXACT'),(201,2,'Other stock','OTHER'),(300,3,'Foreign stock','FOREIGN')");
  const records=[
   [1,2,200,2,'2026-11-04 15:59:59',null,'pending_arrival'],
   [2,2,200,3,'2026-11-04 16:00:00',null,'pending_arrival'],
   [3,2,200,4,'2026-11-05 01:00:00',null,'pending_arrival'],
   [4,2,200,600,'2026-10-01 16:00:00',null,'pending_arrival'],
   [5,2,200,5,'2026-11-05 16:00:00','2026-11-06 00:00:00','pending_arrival'],
   [6,2,201,9,'2026-11-05 16:00:00',null,'pending_arrival'],
   [7,3,300,999,'2026-11-06 16:00:00',null,'pending_arrival'],
   [8,2,200,7,'2026-09-01 00:00:00','2026-09-02 00:00:00','approved']
  ];
  for(const [id,tenant,product,quantity,purchased,received,status] of records){
   await q("INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at,created_by_person_id,total_quantity,total_amount) VALUES(?,?,?,'purchased',?,?,?,?)",[id,tenant,'DATE-PO-'+id,purchased,tenant===2?7:9,quantity,quantity*2]);
   await q("INSERT INTO purchase_order_items(id,tenant_id,purchase_order_id,product_id,actual_quantity,requested_quantity,amount,status) VALUES(?,?,?,?,?,?,?,'purchased')",[id,tenant,id,product,quantity,quantity,quantity*2]);
   await q("INSERT INTO inbound_records(id,tenant_id,product_id,person_id,quantity,amount,purchase_order_id,purchase_order_item_id,status,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",[id,tenant,product,tenant===2?7:9,quantity,quantity*2,id,id,status,received,'2026-11-06 02:00:00']);
  }
  await q("INSERT INTO procurement_requests(id,tenant_id,product_id,person_id,quantity,status) VALUES(200,2,200,7,8,'purchased')");
  await q("INSERT INTO inbound_records(id,tenant_id,product_id,person_id,quantity,status,procurement_request_id,created_at) VALUES(9,2,200,7,8,'pending_arrival',200,'2026-11-03 16:00:00')");
  const defaults=await service.list({day_mode:'pending',status:'open'},buyer);
  assert.deepEqual(defaults.days.map(day=>day.date),['2026-11-06','2026-11-05','2026-11-04','2026-10-02']);
  assert.equal(defaults.selected_day,'2026-11-06');assert.equal(defaults.rows.length,1);assert.equal(defaults.rows[0].product_id,201);
  assert.equal(defaults.summary.open_quantity,626);assert.equal(defaults.summary.arrived_quantity,5);
  assert.equal((await service.list({status:'open',pageSize:100},buyer)).rows.length,6,'old clients still get all dates');
  const search={day_mode:'pending',status:'open',searchMode:'inventory_id',query:'TARGET-EXACT'};
  const match=await service.list(search,buyer);assert.equal(match.selected_day,'2026-11-05');assert.equal(match.summary.open_quantity,617);
  assert.deepEqual(match.days.map(day=>day.date),defaults.days.map(day=>day.date),'search indexes all matching dates including old dates');
  const first=await service.list({...search,purchase_day:'2026-11-05',pageSize:1,page:1},buyer),second=await service.list({...search,purchase_day:'2026-11-05',pageSize:1,page:2},buyer);
  assert.equal(first.total,2);assert.equal(second.total,2);assert.deepEqual(first.days,second.days);assert.deepEqual(first.summary,second.summary);
  assert.deepEqual([first.rows[0].id,second.rows[0].id].sort(),[2,3]);assert.equal(first.day_summary.open_quantity,7);
  const edge=await service.list({...search,purchase_day:'2026-11-04'},buyer);assert.deepEqual(edge.rows.map(row=>row.id).sort(),[1,9]);
  const ranged=await service.list({...search,purchase_day:'all',start_date:'2026-11-04',end_date:'2026-11-05'},buyer);
  assert.deepEqual(ranged.days.map(day=>day.date),['2026-11-05','2026-11-04']);assert.equal(ranged.total,4);
  const old=await service.list({...search,purchase_day:'2026-10-02'},buyer),row=old.rows[0];
  const body={id:row.id,quantity:80,expected_quantity:600,expected_updated_at:row.updated_at,request_key:randomUUID()};
  await assert.rejects(service.confirm(body,warehouse),{statusCode:403});
  const saved=await service.confirm(body,buyer);assert.equal(saved.remaining_quantity,520);assert.equal((await service.confirm({...body,note:'   '},buyer)).duplicate,true);
  await assert.rejects(service.confirm({...body,note:'changed'},buyer),{statusCode:409});
  const after=await service.list({...search,purchase_day:'2026-10-02'},buyer);assert.equal(after.rows[0].quantity,520);assert.equal(after.day_summary.open_quantity,520);assert.equal(after.day_summary.arrived_quantity,80);
  assert.equal(after.days.find(day=>day.date==='2026-10-02').open_quantity,520);
  const arrived=await service.list({day_mode:'pending',status:'arrived',purchase_day:'2026-10-02',product_id:200},buyer);assert.equal(arrived.rows[0].quantity,80);assert.equal(arrived.selected_day,'2026-10-02');
  const [event]=await q("SELECT detail_json FROM inventory_flow_events WHERE action='purchase_arrival' AND product_id=200 ORDER BY id DESC LIMIT 1");
  const audit=typeof event.detail_json==='string'?JSON.parse(event.detail_json):event.detail_json;assert.equal(audit.note,'');assert.match(audit.auto_note,/80 件.*520 件/);
  const original=await service.list({...search,purchase_day:'2026-11-04'},buyer),full=original.rows.find(record=>record.id===1);
  await service.confirm({id:full.id,expected_updated_at:full.updated_at,request_key:randomUUID()},buyer);
  assert.equal((await q('SELECT quantity FROM inbound_records WHERE id=1'))[0].quantity,2,'blank-note full arrival keeps quantity');
  assert.equal((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n,0,'arrivals never post warehouse movements');
  const other=await service.list({day_mode:'pending',status:'open'},foreign);assert.equal(other.rows[0].quantity,999);assert.equal(other.days.length,1);
  assert.ok(!defaults.days.some(day=>day.date==='2026-11-07'));
  await assert.rejects(service.list({day_mode:'pending',product_id:300},buyer),{statusCode:404});
  await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7');await assert.rejects(service.list({day_mode:'pending'},buyer),{statusCode:403});
 }finally{await closeMysqlPool();await f.cleanup();}
});
