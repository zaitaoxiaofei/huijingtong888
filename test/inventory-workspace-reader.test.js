import test from 'node:test';
import assert from 'node:assert/strict';
import {createInventoryWorkspaceReader} from '../src/services/inventory-workspace-reader.js';

test('workspace scans coverage once, batches forecasts, and preserves every product',async()=>{
  let reads=0;const batches=[],snapshot=new Map();
  const read=createInventoryWorkspaceReader({revision:()=>0,coverage:async(ids,tenant)=>{reads++;assert.equal(ids.length,2001);assert.equal(tenant,2);return snapshot;},batch:async(ids,tenant,options)=>{assert.equal(options.coverage,snapshot);assert.equal(options.cache,false);assert.equal(options.fresh,true);batches.push(ids.length);return ids.map(product_id=>({product_id}));}});
  const ids=Array.from({length:2001},(_,i)=>i+1);
  const rows=await read(ids,2);assert.equal(reads,1);assert.deepEqual(batches,[1000,1000,1]);assert.deepEqual(rows.map(r=>r.product_id),ids);
  assert.equal(await read([...ids].reverse(),2),rows);assert.equal(reads,1);
});

test('concurrent requests share work; refresh, writes, TTL and tenant changes cannot reuse stale snapshots',async()=>{
  let epoch=0,time=0,reads=0,release;
  const gate=new Promise(resolve=>release=resolve);
  const read=createInventoryWorkspaceReader({revision:()=>epoch,now:()=>time,coverage:async()=>{reads++;await gate;return new Map();},batch:async(ids)=>ids.map(product_id=>({product_id,epoch}))});
  const a=read([1],2),b=read([1],2,{fresh:true});release();assert.equal(await a,await b);assert.equal(reads,1);
  await read([1],2,{fresh:true});assert.equal(reads,2);
  epoch++;await read([1],2);assert.equal(reads,3);
  time=20001;await read([1],2);assert.equal(reads,4);
  await read([1],3);assert.equal(reads,5);
});

test('failure is never cached as empty or success; retry and empty inventories are safe',async()=>{
  let reads=0;
  const read=createInventoryWorkspaceReader({revision:()=>0,coverage:async()=>{if(!reads++)throw Error('busy');return new Map();},batch:async ids=>ids});
  await assert.rejects(read([1],2),/busy/);assert.deepEqual(await read([1],2),[1]);assert.equal(reads,2);
  assert.deepEqual(await read([],2),[]);assert.equal(reads,2);
});
