import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {loadTenantOrderService} from './helpers/tenant-order-service.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('page rows and canonical inventory facts load in parallel without mutating cached rows or losing unknown/negative values',async()=>{
 const rowGate=deferred(),factGate=deferred(),started=[];
 const original={id:10,estimated_profit:17,total_quantity:2};
 const {service}=loadTenantOrderService({}, {orderInventoryAvailabilityMysql:async(query,tenant)=>{started.push('facts');assert.equal(query.orderIds,'10');assert.equal(tenant,'2');return factGate.promise;}});
 service.orderRowsByIdsMysql=async()=>{started.push('rows');return rowGate.promise;};
 const pending=service.orderPageRowsMysql([10],null,'2',true);
 assert.deepEqual(started.sort(),['facts','rows']);
 factGate.resolve({rows:[{order_id:10,inventory_availability:[{product_id:8,physical_stock:-3,available_stock:0,inventory_needs_review:true}]}]});rowGate.resolve([original]);
 const result=await pending;assert.equal(result[0].estimated_profit,17);assert.equal(result[0].inventory_availability[0].physical_stock,-3);assert.ok(!('inventory_availability' in original));
});
test('balance failures and callers without the optional flag retain rows for the established lazy fallback',async()=>{
 let calls=0;const {service}=loadTenantOrderService({}, {console:{warn(){}},orderInventoryAvailabilityMysql:async()=>{calls++;throw Error('unavailable');}});
 const rows=[{id:1}];service.orderRowsByIdsMysql=async()=>rows;
 assert.equal(await service.orderPageRowsMysql([1],null,'2',false),rows);assert.equal(calls,0);
 assert.equal(await service.orderPageRowsMysql([1],null,'2',true),rows);assert.equal(calls,1);assert.ok(!('inventory_availability' in rows[0]));
});
test('current-page balance endpoint gets foreground priority while full row refresh avoids waiting on its own background coverage',async()=>{
 const source=readFileSync(new URL('../src/services/mysql-runtime-services.js',import.meta.url),'utf8');
 const body=source.match(/orderInventoryAvailability: ([\s\S]*?),\n  updateInventoryProductLeadTimes:/)?.[1];assert.ok(body);
 const events=[];const context=vm.createContext({String,withRequestReadCache:op=>op(),withMysqlWorkload:(priority,op)=>{events.push(priority);return op();},withMysqlInteractiveRead:op=>{events.push('interactive');return op();},orderInventoryAvailabilityMysql:async(query,tenant)=>({query,tenant})});
 const read=vm.runInContext('('+body+')',context);
 for(const query of [{},{includeRows:'0'},{includeRows:'1'}]){events.length=0;const result=await read(query,'2');assert.equal(result.tenant,'2');assert.deepEqual(events,query.includeRows==='1'?['foreground']:['foreground','interactive']);}
});
