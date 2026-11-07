import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';
import { planShippedProcurementReceipts, validateShippedReceiptSubmission } from '../src/services/shipped-procurement-receipts.js';
import { loadOrderProcurementCoverage } from '../src/services/mysql-order-procurement-coverage.js';
const demand = id => ({order_id:id,order_item_id:id,posting_number:`O-${id}`,product_id:10,quantity:1,entered_transport:1,needs_fulfillment:0,stock_location:'LOCAL'});
function coverage(extra={}) {
 return calculateOrderProcurementCoverage({demands:[demand(1),demand(2)],requests:[{id:3,product_id:10,quantity:10,status:'purchased'}],allocations:[{order_item_id:1,product_id:10,procurement_request_id:3,allocated_quantity:1},{order_item_id:2,product_id:10,procurement_request_id:3,allocated_quantity:1}],inbounds:[{id:5,product_id:10,procurement_request_id:3,quantity:10,amount:100,status:'pending_arrival',updated_at:'2026-09-13 10:00:00'}],...extra});
}
test('shared purchase batch proposes only two explicitly linked units, not all ten',()=>{
 const plan=planShippedProcurementReceipts(coverage(),[1,2,1]);
 assert.equal(plan.records.length,1);assert.equal(plan.records[0].quantity,2);assert.equal(plan.records[0].remaining_quantity,10);assert.equal(plan.records[0].orders.length,2);
 assert.equal(validateShippedReceiptSubmission(plan,[{...plan.records[0],quantity:1}])[0].quantity,1);
 for(const change of [{quantity:3},{quantity:0},{quantity:1.5},{remaining_quantity:9},{version_updated_at:'old'}]) assert.throws(()=>validateShippedReceiptSubmission(plan,[{...plan.records[0],...change}]));
 assert.throws(()=>validateShippedReceiptSubmission(plan,[plan.records[0],plan.records[0]]));
});
test('already received quantity is never proposed again',()=>{
 const c=coverage({inbounds:[{id:4,product_id:10,procurement_request_id:3,quantity:1,amount:10,status:'approved'},{id:5,product_id:10,procurement_request_id:3,quantity:9,amount:90,status:'pending_arrival',updated_at:'now'}]});
 const plan=planShippedProcurementReceipts(c,[1,2]);assert.equal(plan.records.length,1);assert.equal(plan.records[0].quantity,1);assert.deepEqual(plan.records[0].orders.map(o=>o.order_id),[2]);
 const done=coverage({inbounds:[{id:5,product_id:10,procurement_request_id:3,quantity:10,amount:100,status:'approved'}]});assert.equal(planShippedProcurementReceipts(done,[1,2]).records.length,0);
});
test('FBP, pre-transport cancellation and unlinked product purchases require no inferred receipt',()=>{
 for(const extra of [{demands:[{...demand(1),stock_location:'FBP'}]},{demands:[{...demand(1),entered_transport:0}]},{allocations:[]},{inbounds:[{id:5,product_id:10,quantity:10,status:'pending_arrival'}]}])assert.equal(planShippedProcurementReceipts(coverage(extra),[1]).records.length,0);
});
test('uncertain quantities and component quantities do not inherit full batch quantities',()=>{
 const c=coverage({demands:[{...demand(1),quantity:2}],allocations:[{order_item_id:1,product_id:10,procurement_request_id:3,allocated_quantity:2}]});assert.equal(planShippedProcurementReceipts(c,[1]).records[0].quantity,2);
 const unknown=coverage({requests:[{id:3,product_id:10,quantity:0,status:'purchased'}]});assert.equal(planShippedProcurementReceipts(unknown,[1]).records.length,0);
});
test('fresh receipt validation bypasses cached order status',async()=>{
 let shipped=false;const query=async sql=>sql.includes('SELECT o.id AS order_id')?[{...demand(1),entered_transport:shipped?1:0,needs_fulfillment:shipped?0:1}]:[];
 await loadOrderProcurementCoverage(query,'',{fresh:true});shipped=true;const c=await loadOrderProcurementCoverage(query,'',{fresh:true});assert.equal(c.get(1).entered_transport,true);
});

test('confirmation validates before writing and rolls back the whole batch on receipt failure', async()=>{
 const {readFileSync}=await import('node:fs');const vm=await import('node:vm');
 const source=readFileSync(new URL('../src/services/mysql-cutover.js',import.meta.url),'utf8');
 const block=source.match(/async function confirmShippedProcurementReceiptsMysql\([^]*?\n}/)[0];
 const {selectedReceiptOrderIds}=await import('../src/services/shipped-procurement-receipts.js');
 const c=coverage();c.get(2).batches=c.get(2).batches.map(b=>({...b,id:6}));c.get(2).items[0].receipt_claims=[{batch_id:6,quantity:1}];
 const plan=planShippedProcurementReceipts(c,[1,2]);let writes=[];let fail=true;let invalidated=false;
 const fn=vm.runInNewContext(`${block};confirmShippedProcurementReceiptsMysql`,{
  ensureProcurementLedgerSchema:async()=>{}, mysqlExecute:async()=>{}, ensureMysqlCutoverEnabled(){},ensureInboundRecordTimestampSchemaMysql:async()=>{},ensurePurchaseCostVersionSchemaMysql:async()=>{},
  selectedReceiptOrderIds,planShippedProcurementReceipts,validateShippedReceiptSubmission,
  withMysqlTransaction:async work=>{const before=[...writes];try{return await work({query:async()=>[[]]});}catch(e){writes=before;throw e;}},
  loadOrderProcurementCoverage:async(q,s,options)=>{assert.equal(options.fresh,true);return c;},
  applyInboundRecordUpdateMysql:async(connection,id,body)=>{assert.match(body.receipt_context,/人工确认补登/);writes.push(id);if(id===6&&fail)throw new Error('receipt conflict');},
  refreshPurchaseOrderStatusMysql:async()=>{},invalidateOrderProcurementCoverage(){invalidated=true;}
 });
 const body={confirmed:true,order_ids:[1,2],records:plan.records};
 await assert.rejects(fn({...body,confirmed:false}),/确认/);assert.deepEqual(writes,[]);
 await assert.rejects(fn(body),/receipt conflict/);assert.deepEqual(writes,[]);assert.equal(invalidated,false);
 fail=false;const result=await fn(body);assert.equal(result.count,2);assert.deepEqual(writes,[5,6]);assert.equal(invalidated,true);
});
test('legacy batches linked through the same purchase order and product remain eligible',()=>{
 const c=coverage({requests:[{id:3,product_id:10,purchase_order_id:7,quantity:10,status:'purchased'}],inbounds:[{id:5,product_id:10,purchase_order_id:7,quantity:10,status:'pending_arrival',updated_at:'now'}]});
 assert.equal(planShippedProcurementReceipts(c,[1,2]).records[0].quantity,2);
 const unrelated=coverage({requests:[{id:3,product_id:10,purchase_order_id:7,quantity:10,status:'purchased'}],inbounds:[{id:5,product_id:10,purchase_order_id:7,procurement_request_id:99,quantity:10,status:'pending_arrival',updated_at:'now'}]});
 assert.equal(planShippedProcurementReceipts(unrelated,[1,2]).records.length,0);
});
test('later-order-only selection cannot receive a batch that FIFO would credit to an earlier unselected order',()=>{
 const c=coverage();assert.equal(planShippedProcurementReceipts(c,[2]).records.length,0);
 assert.equal(planShippedProcurementReceipts(c,[1,2]).records[0].quantity,2);
 const active=coverage({demands:[{...demand(1),entered_transport:0,needs_fulfillment:1},demand(2)]});assert.equal(planShippedProcurementReceipts(active,[1,2]).records.length,0);
});
