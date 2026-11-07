import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
// All queries and transactions below are in-memory; these placeholders only
// satisfy module configuration and never open a MySQL connection.
process.env.DB_CLIENT='mysql';process.env.DB_HOST='127.0.0.1';process.env.DB_NAME='partial_arrival_mock';process.env.DB_USER='unused_mock';
const {createProcurementArrivals}=await import('../src/services/procurement-arrivals.js');

const session={personId:7,tenant:{id:2,slug:'a',role:'member'}};
function fixture(){
 let data={rows:[{id:10,tenant_id:2,product_id:200,person_id:7,quantity:600,amount:1001.1234,shipping_amount:7.7755,unit_cost:1.6815,purchase_url:'https://supplier.test/item',status:'pending_arrival',note:'真实采购600件',purchase_order_id:20,purchase_order_item_id:21,procurement_request_id:null,qc_status:'pending',received_at:null,courier_company:'测试快递',tracking_number:'DELIVERY-1',created_at:'2026-11-01 01:00:00',updated_at:'2026-11-05 01:00:00'}],events:[],writes:[],role:'procurement',active:true};
 const inspect=()=>structuredClone(data);
 async function query(sql,args=[]){
  if(sql.includes('JOIN tenant_members tm ON tm.tenant_id = t.id'))return data.active?[{id:2,slug:'a',tenant_role:'member',business_roles_json:JSON.stringify([data.role])}]:[];
  if(sql.includes('SELECT id, slug FROM tenants'))return[{id:2,slug:'a'}];
  if(sql.includes('FROM inbound_records owned'))return structuredClone(data.rows.filter(r=>r.id===Number(args[0])&&r.tenant_id===Number(args[1])));
  if(sql.includes('FROM products owned'))return Number(args[0])===200&&Number(args[1])===2?[{id:200,tenant_id:2}]:[];
  if(sql.includes('FROM purchase_order_items owned'))return[{id:21,tenant_id:2,product_id:200,purchase_order_id:20}];
  if(sql.includes('FROM purchase_orders owned'))return[{id:20,tenant_id:2}];
  if(sql.includes("action='purchase_arrival'"))return data.events.filter(e=>e.request_key===args[1]).map(e=>({detail_json:JSON.stringify(e)}));
  if(sql.includes('SELECT po.id FROM purchase_orders'))return[{id:20}];
  if(sql.includes('FROM product_components c'))return[];
  throw Error('Unexpected query: '+sql);
 }
 async function execute(sql,args=[]){
  data.writes.push({sql,args});
  if(sql.includes('INSERT INTO inbound_records')){const [tenant_id,product_id,person_id,quantity,amount,unit_cost,shipping_amount,purchase_url,note,purchase_order_id,purchase_order_item_id,procurement_request_id,courier_company,tracking_number,created_at]=args;const id=10+data.rows.length;data.rows.push({id,tenant_id,product_id,person_id,quantity,amount,unit_cost,shipping_amount,purchase_url,note,purchase_order_id,purchase_order_item_id,procurement_request_id,courier_company,tracking_number,created_at,status:'pending_arrival',received_at:null,updated_at:'2026-11-05 01:00:01'});return[{insertId:id}];}
  if(sql.includes('UPDATE inbound_records SET quantity=')){const [quantity,amount,shipping_amount,unit_cost,id]=args;Object.assign(data.rows.find(r=>r.id===id),{quantity,amount,shipping_amount,unit_cost,received_at:'2026-11-05 01:00:01',updated_at:'2026-11-05 01:00:01'});return[{affectedRows:1}];}
  if(sql.includes('INSERT INTO inventory_flow_events')){data.events.push(JSON.parse(args[4]));return[{insertId:data.events.length}];}
  throw Error('Unexpected write: '+sql);
 }
 const service=createProcurementArrivals({query,transaction:async callback=>{const before=inspect();try{return await callback({query:async(sql,args)=>[await query(sql,args)],execute});}catch(e){data=before;throw e;}}});
 const input=()=>({id:10,quantity:80,expected_quantity:600,expected_updated_at:'2026-11-05 01:00:00',note:'本次80件分批到货，其余520件继续等候',request_key:randomUUID()});
 return{service,input,inspect,restrict(role,active=true){data.role=role;data.active=active;}};
}

test('partial arrival splits 80 arrived and 520 open while preserving purchase facts and exact amounts',async()=>{
 const f=fixture(),result=await f.service.confirm(f.input(),session),state=f.inspect();
 assert.equal(result.quantity,80);assert.equal(result.remaining_quantity,520);assert.equal(state.rows.length,2);
 const [arrived,open]=state.rows;assert.equal(arrived.quantity,80);assert.ok(arrived.received_at);assert.equal(open.quantity,520);assert.equal(open.received_at,null);
 for(const key of ['tenant_id','product_id','person_id','purchase_order_id','purchase_order_item_id','procurement_request_id','purchase_url','courier_company','tracking_number','created_at'])assert.equal(open[key],arrived[key],key);
 assert.equal(Math.round((arrived.amount+open.amount)*10000),10011234);assert.equal(Math.round((arrived.shipping_amount+open.shipping_amount)*10000),77755);
 assert.ok(state.writes.every(w=>/^(INSERT INTO inbound_records|UPDATE inbound_records|INSERT INTO inventory_flow_events)/.test(w.sql)),'arrival never rewrites purchase totals, allocations or inventory movements');
 assert.equal(state.events[0].before.quantity,600);assert.equal(state.events[0].result.remaining_inbound_id,open.id);
});

test('arrival retry returns the exact split once; reusing a key for changed content is rejected',async()=>{
 const f=fixture(),body=f.input(),first=await f.service.confirm(body,session),state=f.inspect();
 const retried=await f.service.confirm(body,session);assert.equal(retried.duplicate,true);assert.equal(retried.remaining_inbound_id,first.remaining_inbound_id);assert.deepEqual(f.inspect(),state);
 await assert.rejects(f.service.confirm({...body,quantity:81},session),{statusCode:409});assert.deepEqual(f.inspect(),state);
 await assert.rejects(f.service.confirm({...body,request_key:randomUUID()},session),{statusCode:409});assert.deepEqual(f.inspect(),state);
});

test('invalid counts, stale quantities, foreign enterprise and revoked roles cannot split a batch',async()=>{
 const f=fixture(),before=f.inspect();
 for(const quantity of [0,-1,1.5,601])await assert.rejects(f.service.confirm({...f.input(),quantity},session));
 await assert.rejects(f.service.confirm({...f.input(),expected_quantity:599},session),{statusCode:409});
 await assert.rejects(f.service.confirm({...f.input(),expected_updated_at:'2026-11-05 00:59:59'},session),{statusCode:409});
 await assert.rejects(f.service.confirm(f.input(),{...session,tenant:{id:3,slug:'b',role:'member'}}),{statusCode:403});
 assert.deepEqual(f.inspect(),before);f.restrict('packing');await assert.rejects(f.service.confirm(f.input(),session),{statusCode:403});f.restrict('procurement',false);await assert.rejects(f.service.confirm(f.input(),session),{statusCode:403});
});

test('later partial deliveries process only the remaining open quantity and legacy full clients still work',async()=>{
 const f=fixture();const first=await f.service.confirm(f.input(),session),open=f.inspect().rows.find(r=>r.id===first.remaining_inbound_id);
 const second=await f.service.confirm({...f.input(),id:open.id,quantity:120,expected_quantity:520,expected_updated_at:open.updated_at},session);
 assert.equal(second.remaining_quantity,400);assert.equal(f.inspect().rows.filter(r=>r.received_at).reduce((sum,r)=>sum+r.quantity,0),200);
 const last=f.inspect().rows.find(r=>r.id===second.remaining_inbound_id),legacy=await f.service.confirm({id:last.id,note:'剩余全部到货',expected_updated_at:last.updated_at,request_key:randomUUID()},session);
 assert.equal(legacy.remaining_quantity,0);assert.equal(f.inspect().rows.reduce((sum,r)=>sum+r.quantity,0),600);assert.equal(f.inspect().rows.filter(r=>!r.received_at).length,0);
});
