import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';
import { calculateOrderProcurementCoverageAsync } from '../src/services/order-procurement-coverage-async.js';

function input(size) {
  return { demands:Array.from({length:size},(_,i)=>({order_id:i+1,order_item_id:i+1,product_id:1+i%20,
    ordered_at:'2026-11-01 00:00:00',quantity:1,needs_fulfillment:i%3?1:0,entered_transport:i%3?0:1,
    stock_location:i%11?'LOCAL':'FBP'})), stocks:Array.from({length:20},(_,i)=>({product_id:i+1,ledger:15})),
    allocations:[],inbounds:[],requests:[],marks:[],sources:[],stockSources:[],includeTrace:true };
}
test('worker and small synchronous path preserve the complete allocation map and properties',async()=>{
  for(const size of [5,1000]) {
    const data=input(size);
    assert.deepEqual(await calculateOrderProcurementCoverageAsync(data),calculateOrderProcurementCoverage(data));
  }
});
test('heavy calculation yields the API thread and successive heavy calls both complete',async()=>{
  const data=input(1200),order=[];
  const first=calculateOrderProcurementCoverageAsync(data).then(value=>{order.push('first');return value;});
  const second=calculateOrderProcurementCoverageAsync(data);
  await new Promise(resolve=>setImmediate(()=>{order.push('event-loop');resolve();}));
  const [a,b]=await Promise.all([first,second]);
  assert.equal(order[0],'event-loop');assert.deepEqual(a,b);
});

test('a production-sized reconciliation preserves map properties within the bounded worker heap', {timeout:30000}, async()=>{
  const data=input(30000);data.includeTrace=false;
  data.demands.forEach((row,index)=>{row.product_id=1+index%900;});
  data.stocks=Array.from({length:900},(_,i)=>({product_id:i+1,ledger:i%7?40:-1,fbp_reserved:i%13?0:3}));
  data.inbounds=Array.from({length:1500},(_,i)=>({id:i+1,product_id:1+i%900,quantity:10,amount:50,
    status:i%5?'approved':'pending_arrival',created_at:'2026-10-01 00:00:00',approved_at:'2026-10-03 00:00:00'}));
  const {isDeepStrictEqual}=await import('node:util');
  assert.equal(isDeepStrictEqual(await calculateOrderProcurementCoverageAsync(data),calculateOrderProcurementCoverage(data)),true);
});
