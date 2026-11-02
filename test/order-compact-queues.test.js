import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateOrderProcurementCoverage} from '../src/services/order-procurement-coverage.js';
import {calculateOrderProcurementCoverageAsync} from '../src/services/order-procurement-coverage-async.js';
import {procurementQueueSql} from '../src/services/mysql-order-procurement-coverage.js';
import {compactProcurementCoverage,PROCUREMENT_QUEUES} from '../src/services/order-procurement-queues.js';

test('compact membership preserves overlapping shortages, review flags, FBP exclusion and historical missing records',()=>{
 const full=new Map([
 [1,{order_id:1,stock_location:'LOCAL',needs_fulfillment:1,items:[{product_id:2,shortage_quantity:3}],incoming_quantity:2}],
 [2,{order_id:2,stock_location:'LOCAL',entered_transport:1,missing_record_quantity:1,items:[]}],
 [3,{order_id:3,stock_location:'FBP',needs_fulfillment:1,entered_transport:1,items:[{product_id:2,shortage_quantity:3}],incoming_quantity:5,missing_record_quantity:2}],
 [4,{order_id:4,stock_location:'LOCAL',quantity_needs_review:1,entered_transport:1,items:[]}]
 ]);
 const compact=compactProcurementCoverage(full);assert.equal(compact.size,0);
 for(const status of PROCUREMENT_QUEUES)assert.equal(procurementQueueSql(compact,status),procurementQueueSql(full,status));
 assert.deepEqual(compact.queue_ids,{pending_purchase:[1],purchase_in_transit:[1,4],purchase_records_missing:[2,4]});
});

test('worker and small synchronous path transfer exact queue membership without full detail entries',async()=>{
 for(const size of [8,30000]){
  const demands=Array.from({length:size},(_,i)=>({order_id:i+1,order_item_id:i+1,product_id:1,quantity:1,ordered_at:'2026-10-01',stock_location:i%4===0?'FBP':'LOCAL',needs_fulfillment:i%3===0?1:0,entered_transport:i%3===0?0:1}));
  const input={demands,stocks:[{product_id:1,ledger:12}],inbounds:[],includeTrace:false};
  const full=calculateOrderProcurementCoverage(input),compact=await calculateOrderProcurementCoverageAsync({...input,queuesOnly:true});
  for(const status of PROCUREMENT_QUEUES)assert.equal(procurementQueueSql(compact,status),procurementQueueSql(full,status));
  assert.equal(compact.size,0);assert.equal(compact.available_batches,undefined);assert.equal(compact.product_availability,undefined);
 }
});

test('metadata and full details use different enterprise-scoped snapshots',async()=>{
 const {loadTenantOrderService}=await import('./helpers/tenant-order-service.js');
 const calls=[],keys=[];
 const {service}=loadTenantOrderService({query:async()=>[[]]}, {
  cachedOrderRead:async(key,loader)=>{keys.push(key);return loader();},
  orderProcurementCoverageMysql:async options=>{calls.push(options);return new Map();}
 });
 await service.orderTenantCoverageMysql({id:2,defaultTenant:false},{queuesOnly:true});
 await service.orderTenantCoverageMysql({id:2,defaultTenant:false});
 await service.orderTenantCoverageMysql({id:3,defaultTenant:false},{queuesOnly:true});
 assert.deepEqual(keys,['queues:2:0','coverage:2:0','queues:3:0']);
 assert.deepEqual(calls.map(c=>[c.tenantId,c.queuesOnly]),[[2,true],[2,false],[3,true]]);
 assert.ok(calls.every(c=>c.fresh===true&&c.includeLegacyTenantNull===false));
});
