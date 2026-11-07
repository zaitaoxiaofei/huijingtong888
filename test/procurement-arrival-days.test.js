import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='arrival_day_mock';process.env.DB_USER||='unused_mock';
const {procurementArrivalDateFilters,createProcurementArrivals}=await import('../src/services/procurement-arrivals.js');

test('arrival date filters strictly validate Beijing days, inclusive range boundaries and legacy all-day mode',()=>{
 assert.deepEqual(procurementArrivalDateFilters({}),{grouped:false,day:'',dayRange:null,from:null,to:null});
 assert.deepEqual(procurementArrivalDateFilters({day_mode:'pending',purchase_day:'2026-11-05',start_date:'2026-10-01',end_date:'2026-11-06'}),{
  grouped:true,day:'2026-11-05',dayRange:['2026-11-04 16:00:00','2026-11-05 16:00:00'],from:'2026-09-30 16:00:00',to:'2026-11-06 16:00:00'});
 assert.equal(procurementArrivalDateFilters({purchase_day:'all'}).dayRange,null);
 for(const params of [{purchase_day:'2026-02-30'},{purchase_day:'2026-1-01'},{purchase_day:"2026-11-05' OR 1=1"},{start_date:'bad'},{end_date:'2026-13-01'},{start_date:'2026-11-06',end_date:'2026-11-05'},{day_mode:'other'}]){
  assert.throws(()=>procurementArrivalDateFilters(params),{statusCode:400});
 }
});

test('day indexes use all pending rows before selected-day filtering or pagination and count unreviewed bundles explicitly',async()=>{
 const calls=[];
 const pending=[
  {id:1,product_id:200,quantity:600,received_at:null,status:'pending_arrival',purchase_day:'2026-10-02'},
  {id:2,product_id:200,quantity:3,received_at:null,status:'pending_arrival',purchase_day:'2026-11-05'},
  {id:3,product_id:200,quantity:4,received_at:'2026-11-06 01:00:00',status:'pending_arrival',purchase_day:'2026-11-05'},
  {id:4,product_id:201,quantity:2,received_at:null,status:'pending_arrival',purchase_day:'2026-11-05'}
 ];
 const query=async(sql,args=[])=>{
  calls.push({sql,args});
  if(sql.includes('JOIN tenant_members tm ON tm.tenant_id = t.id'))return[{id:2,slug:'a',tenant_role:'member',business_roles_json:['procurement']}];
  if(sql.includes('SELECT id, slug FROM tenants'))return[{id:2,slug:'a'}];
  if(sql.includes('SELECT p.id,p.name'))return[{id:200,name:'Physical stock'},{id:201,name:'Unreviewed bundle'}];
  if(sql.includes('SELECT c.product_id,c.component_product_id'))return[{product_id:201,component_product_id:200,quantity:3}];
  if(sql.includes("action='purchase_bundle_review'"))return[];
  if(sql.includes('AS purchase_day'))return pending;
  if(sql.includes('COUNT(*) AS n'))return[{n:2}];
  if(sql.includes('ORDER BY COALESCE(po.purchased_at,ir.created_at)'))return[pending[1]];
  throw Error('Unexpected fixture SQL: '+sql);
 };
 const result=await createProcurementArrivals({query}).list({day_mode:'pending',purchase_day:'2026-11-05',status:'open',page:2,pageSize:1},{personId:7,tenant:{id:2,slug:'a'}});
 assert.deepEqual(result.days.map(day=>day.date),['2026-10-02','2026-11-05']);
 assert.equal(result.days[1].open_quantity,3);assert.equal(result.days[1].arrived_quantity,4);assert.equal(result.days[1].open_unknown_batches,1);
 assert.equal(result.days[0].open_quantity,600,'older unfinished purchases are retained');
 assert.equal(result.summary.open_quantity,603);assert.equal(result.day_summary.open_quantity,3);assert.equal(result.selected_day,'2026-11-05');
 const aggregate=calls.find(call=>call.sql.includes('AS purchase_day'));
 assert.deepEqual(aggregate.args,[]);assert.doesNotMatch(aggregate.sql,/LIMIT|OFFSET/);
 const details=calls.find(call=>call.sql.includes('ORDER BY COALESCE(po.purchased_at,ir.created_at)'));
 assert.deepEqual(details.args,['2026-11-04 16:00:00','2026-11-05 16:00:00',1,1]);
 assert.equal(result.total,2);assert.equal(result.rows.length,1);
 assert.match(details.sql,/ORDER BY COALESCE\(po.purchased_at,ir.created_at\) ASC,ir.id ASC/);
 const service=createProcurementArrivals({query});
 assert.equal((await service.list({day_mode:'pending',status:'open'},{personId:7,tenant:{id:2,slug:'a'}})).selected_day,'2026-10-02');
 const exhausted=await service.list({day_mode:'pending',status:'arrived',purchase_day:'2026-10-02',page:3},{personId:7,tenant:{id:2,slug:'a'}});
 assert.equal(exhausted.selected_day,'2026-11-05');assert.equal(exhausted.page,1);
 const redirected=calls.filter(call=>call.sql.includes('ORDER BY COALESCE(po.purchased_at,ir.created_at)')).at(-1);
 assert.deepEqual(redirected.args,['2026-11-04 16:00:00','2026-11-05 16:00:00',20,0]);
 await service.list({status:'open'},{personId:7,tenant:{id:2,slug:'a'}});
 assert.match(calls.at(-1).sql,/ORDER BY COALESCE\(po.purchased_at,ir.created_at\) DESC,ir.id DESC/);
});
