import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedOrderRead, invalidateOrderReadCache } from '../src/services/order-read-cache.js';
import { invalidateInventoryWorkflow } from '../src/services/inventory-workflow-cache.js';

test('enterprise keys isolate values; concurrent requests coalesce and both workflow and direct writes invalidate immediately', async () => {
  invalidateOrderReadCache();
  let calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const a=cachedOrderRead('coverage:1:1',async()=>{calls++;await gate;return {quantity:5};});
  const b=cachedOrderRead('coverage:1:1',async()=>{throw Error('Duplicate load');});
  assert.equal((await cachedOrderRead('coverage:2:0',async()=>({quantity:9}))).quantity,9);
  release(); assert.equal(await a,await b);assert.equal(calls,1);
  invalidateInventoryWorkflow({tenantId:1,productIds:[7]});
  assert.equal((await cachedOrderRead('coverage:1:1',async()=>({quantity:3}))).quantity,3);
  invalidateOrderReadCache();
  assert.equal((await cachedOrderRead('coverage:1:1',async()=>({quantity:1}))).quantity,1);
});

test('invalidation during a read cannot resurrect stale rows, and failures can be retried', async()=>{
  invalidateOrderReadCache();let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const old=cachedOrderRead('rows:1:1:7',async()=>{await gate;return 'old';});
  invalidateInventoryWorkflow();
  assert.equal(await cachedOrderRead('rows:1:1:7',async()=>'new'),'new');
  release();await old;
  assert.equal(await cachedOrderRead('rows:1:1:7',async()=>{throw Error('Stale result replaced current');}),'new');
  await assert.rejects(cachedOrderRead('failure',async()=>{throw Error('temporary');}),/temporary/);
  assert.equal(await cachedOrderRead('failure',async()=>'recovered'),'recovered');
});

test('expired values reload; bounded cache cannot retain an unlimited number of page results',async()=>{
  invalidateOrderReadCache();
  await cachedOrderRead('expired',async()=>'old',-1);
  assert.equal(await cachedOrderRead('expired',async()=>'new'),'new');
  await cachedOrderRead('oldest',async()=>'old');
  for(let i=0;i<81;i++) await cachedOrderRead(`page-${i}`,async()=>i);
  assert.equal(await cachedOrderRead('oldest',async()=>'evicted'),'evicted');
});
