import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='lineage_mock';process.env.DB_USER||='unused_mock';
const {createProcurementArrivals}=await import('../src/services/procurement-arrivals.js');

async function listing({source,sourceRows,child={product_id:200,purchase_order_id:575},scope={id:2,slug:'a'}}={}){
 const calls=[],batch={id:1915,product_id:200,purchase_order_id:575,order_no:'HISTORY-315',quantity:40,status:'pending_arrival',received_at:null,purchase_day:'2026-10-31'};
 const query=async(sql,args=[])=>{
  calls.push({sql,args});
  if(sql.includes('JOIN tenant_members tm ON tm.tenant_id = t.id'))return[{...scope,tenant_role:'member',business_roles_json:['procurement']}];
  if(sql.includes('SELECT id, slug FROM tenants'))return[scope];
  if(sql.includes('SELECT p.id,p.name'))return[{id:200,name:'Synthetic component'},{id:331,name:'Synthetic parent'}];
  if(sql.includes('SELECT c.product_id,c.component_product_id'))return[{product_id:331,component_product_id:200,quantity:2}];
  if(sql.includes("action='purchase_bundle_review'"))return[{detail_json:JSON.stringify({source,result:{mode:'whole',inbound_id:1685,created:[{inbound_id:1915,...child}]}})}];
  if(sql.includes('FROM inbound_records source'))return sourceRows;
  if(sql.includes('AS purchase_day'))return[batch];
  if(sql.includes('COUNT(*) AS n'))return[{n:1}];
  if(sql.includes('ORDER BY COALESCE(po.purchased_at,ir.created_at)'))return[batch];
  throw Error('Unexpected SQL: '+sql);
 };
 const result=await createProcurementArrivals({query}).list({day_mode:'pending',pageSize:20},{personId:7,tenant:scope});
 return{result,calls};
}

test('verified source purchase metadata enriches the child without changing its real purchase identity or paging',async()=>{
 const {result,calls}=await listing({source:{product_id:331,purchase_order_id:467},sourceRows:[{id:1685,product_id:331,purchase_order_id:467,order_no:'PO-20261031-006'}]});
 assert.deepEqual(result.rows[0].source_bundle_batch,{id:1685,product_id:331,purchase_order_id:467,order_no:'PO-20261031-006'});
 assert.equal(result.rows[0].purchase_order_id,575);assert.equal(result.rows[0].order_no,'HISTORY-315');assert.equal(result.total,1);assert.equal(result.selected_day,'2026-10-31');
 assert.equal(result.days[0].open_quantity,40);assert.equal(result.summary.open_quantity,40);
 const read=calls.filter(call=>call.sql.includes('FROM inbound_records source'));assert.equal(read.length,1);assert.deepEqual(read[0].args,[1685]);
 for(const alias of ['source','source_product','original'])assert.match(read[0].sql,new RegExp(alias+'\\.tenant_id = 2'));
 assert.ok(calls.every(call=>!/^\s*(UPDATE|INSERT|DELETE|ALTER)/.test(call.sql)));
});

test('foreign or mismatched audit pointers cannot expose a purchase number or another source',async()=>{
 const valid={id:1685,product_id:331,purchase_order_id:467,order_no:'PO-20261031-006'};
 const foreign=await listing({source:{product_id:331,purchase_order_id:999},sourceRows:[]});
 assert.equal(foreign.result.rows[0].source_bundle_batch,null);
 const forgedPo=await listing({source:{product_id:331,purchase_order_id:999},sourceRows:[valid]});
 assert.deepEqual(forgedPo.result.rows[0].source_bundle_batch,{id:1685,product_id:331,purchase_order_id:null,order_no:null});
 const forgedChild=await listing({source:{product_id:331,purchase_order_id:467},sourceRows:[valid],child:{product_id:999,purchase_order_id:575}});
 assert.equal(forgedChild.result.rows[0].source_bundle_batch,null);
 const defaultScope=await listing({source:{product_id:331,purchase_order_id:467},sourceRows:[valid],scope:{id:1,slug:'default'}});
 const sql=defaultScope.calls.find(call=>call.sql.includes('FROM inbound_records source')).sql;
 for(const alias of ['source','source_product','original'])assert.match(sql,new RegExp(alias+'\\.tenant_id = 1 OR '+alias+'\\.tenant_id IS NULL'));
});
