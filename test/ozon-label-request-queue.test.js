import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {createOzonLabelRequestQueue} from '../src/services/ozon-label-request-queue.js';

test('same-client prefetch and printing serialize with a gap while preserving caller results', async () => {
  let now=0,active=0,max=0;
  const times=[];
  const run=createOzonLabelRequestQueue({now:()=>now,wait:async ms=>{now+=ms;}});
  const result=await Promise.all(Array.from({length:11},(_,i)=>run('shop-client',async()=>{
    times.push(now);max=Math.max(max,++active);await Promise.resolve();active--;return i;
  })));
  assert.deepEqual(result,Array.from({length:11},(_,i)=>i));assert.equal(max,1);
  assert.ok(times.slice(1).every((time,i)=>time-times[i]>=1100));
});

test('429 honors Retry-After and retries; other errors do not retry or poison the queue',async()=>{
  let now=0,count=0;
  const times=[];
  const run=createOzonLabelRequestQueue({now:()=>now,wait:async ms=>{now+=ms;}});
  const result=await run('one',async()=>{times.push(now);if(++count<3)throw Object.assign(Error('limited'),{statusCode:429,retryAfterMs:3000});return 'pdf';});
  assert.equal(result,'pdf');assert.equal(count,3);assert.ok(times[1]-times[0]>=3000);assert.ok(times[2]-times[1]>=4000);
  count=0;await assert.rejects(run('one',async()=>{count++;throw Error('invalid credentials');}),/credentials/);assert.equal(count,1);
  assert.equal(await run('one',async()=>42),42);
});

test('persistent limits stop after three attempts and cancelled jobs never send requests',async()=>{
  let now=0,count=0;
  const run=createOzonLabelRequestQueue({now:()=>now,wait:async ms=>{now+=ms;}});
  await assert.rejects(run('one',async()=>{count++;throw Error('You have reached request rate limit per second');}),/rate limit/);assert.equal(count,3);
  const controller=new AbortController();controller.abort(Error('cancelled'));
  await assert.rejects(run('one',async()=>{count++;},{signal:controller.signal}),/cancelled/);assert.equal(count,3);
});

test('another client can download while one client is busy',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const run=createOzonLabelRequestQueue({wait:async()=>{}});
  const first=run('one',()=>gate);
  assert.equal(await run('two',async()=>2),2);release(1);assert.equal(await first,1);
});

test('failed PDF request replaces loading page with a safe visible error and retains the original failure',async()=>{
  const source=fs.readFileSync(new URL('../frontend/orders/services/orders-service.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'');
  const elements={printErrorTitle:{},printErrorMessage:{}};const writes=[];
  const printWindow={closed:false,document:{open(){},write(html){writes.push(html);},close(){},getElementById(id){return elements[id];}}};
  const failure=Error('<script>bad</script> Ozon rate limit');
  const context=vm.createContext({window:{open:()=>printWindow},apiClient:{blobResponse:async()=>{throw failure;}},URL,setInterval,clearInterval});
  vm.runInContext(source,context);
  await assert.rejects(context.previewOrderLabels([3,2,1]),error=>error===failure);
  assert.match(writes[0],/spinner/);assert.doesNotMatch(writes.at(-1),/spinner|<script>bad/);
  assert.equal(elements.printErrorTitle.textContent,'面单预览失败');assert.equal(elements.printErrorMessage.textContent,failure.message);
});
