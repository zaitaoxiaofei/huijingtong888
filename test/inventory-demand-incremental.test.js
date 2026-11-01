import test from 'node:test';
import assert from 'node:assert/strict';
import {createInventoryDemandSnapshot,waitForInventoryDemandJobs} from '../src/services/inventory-demand-snapshot.js';
import {workflowRevision,invalidateInventoryWorkflow,inventoryWorkflowChanges} from '../src/services/inventory-workflow-cache.js';
function fixture(){
 let time=1000000,revision=0,hold=null,bad=false,ids=[1,2,3];const events=[],calls=[],values=new Map([[1,10],[2,20],[3,30]]),disk=new Map();
 const read=createInventoryDemandSnapshot({now:()=>time,revision:()=>revision,changes:(since,tenant)=>{const changed=events.filter(e=>e.revision>since);return changed.some(e=>!e.ids)?null:[...new Set(changed.filter(e=>e.tenant===tenant).flatMap(e=>e.ids))];},query:async(sql,args)=>{if(sql.startsWith('SELECT'))return disk.has(args[0])?[disk.get(args[0])]:[];disk.set(args[0],{version:args[1],payload_json:args[2],calculated_at:args[3]+'Z'});},products:async()=>ids.map(product_id=>({product_id})),calculate:async needed=>{calls.push([...needed]);if(hold)await hold;return bad?[]:needed.map(product_id=>({product_id,physical:values.get(product_id),calculated_at:new Date(time).toISOString()}));}});
 return{read,calls,disk,values,advance:n=>time+=n,change:(list,tenant=2)=>events.push({revision:++revision,tenant,ids:list}),hold:p=>hold=p,bad:v=>bad=v,setIds:v=>ids=v};
}
async function ready(f){await f.read(2);await waitForInventoryDemandJobs();return f.read(2);}
test('scoped changes recalculate only affected inventory and preserve unrelated quantities and full-rebuild time',async()=>{
 const f=fixture(),before=await ready(f);f.advance(1000);f.values.set(2,99);f.change([2]);const stale=await f.read(2);assert.equal(stale.rows[1].physical,20);assert.equal(stale.snapshot.refreshing,true);await waitForInventoryDemandJobs();const after=await f.read(2);
 assert.deepEqual(f.calls,[[1,2,3],[2]]);assert.equal(after.rows[1].physical,99);assert.deepEqual(after.rows[0],before.rows[0]);assert.equal(after.snapshot.stale,false);assert.equal(JSON.parse(f.disk.get(2).payload_json).full_calculated_at,before.snapshot.calculated_at);
});
test('changes in another tenant do not recalculate this tenant; unknown impact and manual refresh always rebuild fully',async()=>{
 const f=fixture();await ready(f);f.change([2],3);f.advance(60001);await f.read(2);await waitForInventoryDemandJobs();assert.equal(f.calls.length,1);
 f.change(null);f.advance(60001);await f.read(2);await waitForInventoryDemandJobs();assert.deepEqual(f.calls.at(-1),[1,2,3]);
 f.change([1]);await f.read(2,{fresh:true});await waitForInventoryDemandJobs();assert.deepEqual(f.calls.at(-1),[1,2,3]);
});
test('incremental writes cannot indefinitely delay periodic reconciliation, and new/removed inventories merge safely',async()=>{
 const f=fixture();await ready(f);for(let i=0;i<3;i++){f.advance(60001);f.change([2]);await f.read(2);await waitForInventoryDemandJobs();assert.deepEqual(f.calls.at(-1),[2]);}
 f.setIds([2,3,4]);f.values.set(4,40);f.change([4]);await f.read(2);await waitForInventoryDemandJobs();assert.deepEqual((await f.read(2)).rows.map(r=>r.product_id),[2,3,4]);assert.deepEqual(f.calls.at(-1),[4]);
 f.advance(130000);f.change([2]);await f.read(2);await waitForInventoryDemandJobs();assert.deepEqual(f.calls.at(-1),[2,3,4]);
});
test('partial calculation failure keeps the complete previous snapshot instead of inventing zero',async()=>{
 const f=fixture(),before=await ready(f);f.change([2]);f.bad(true);await f.read(2);await waitForInventoryDemandJobs();const failed=await f.read(2);assert.deepEqual(failed.rows,before.rows);assert.ok(failed.snapshot.error);
 f.bad(false);await f.read(2,{fresh:true});await waitForInventoryDemandJobs();assert.equal((await f.read(2)).snapshot.error,null);
});
test('manual reconciliation during an incremental job schedules one complete follow-up',async()=>{
 const f=fixture();await ready(f);let release;f.hold(new Promise(r=>release=r));f.change([2]);await f.read(2);await new Promise(r=>setImmediate(r));await f.read(2,{fresh:true});await f.read(2,{fresh:true});release();f.hold(null);await waitForInventoryDemandJobs();assert.deepEqual(f.calls,[[1,2,3],[2],[1,2,3]]);
});
test('bounded invalidation history is tenant scoped and fails closed after global changes or eviction',()=>{
 const start=workflowRevision();invalidateInventoryWorkflow({tenantId:2,productIds:[1,2,2]});assert.deepEqual(inventoryWorkflowChanges(start,2),[1,2]);assert.deepEqual(inventoryWorkflowChanges(start,3),[]);
 invalidateInventoryWorkflow();assert.equal(inventoryWorkflowChanges(start,2),null);const old=workflowRevision();for(let i=0;i<257;i++)invalidateInventoryWorkflow({tenantId:2,productIds:[1]});assert.equal(inventoryWorkflowChanges(old,2),null);assert.equal(inventoryWorkflowChanges(null,2),null);
});
