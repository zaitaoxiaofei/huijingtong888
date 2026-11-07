import test from 'node:test';
import assert from 'node:assert/strict';
import {createThumbnailBatchLoader} from '../frontend/admin/utils/thumbnail-batch-loader.js';
const picture=()=>new Blob(['valid-image'],{type:'image/webp'});
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
test('thumbnail requests deduplicate, bound concurrency, and publish ready images in one batch',async()=>{
 const loads=[],releases=[],scheduled=[];
 const loader=createThumbnailBatchLoader({concurrency:2,load:async url=>{loads.push(url);return new Promise(resolve=>releases.push(()=>resolve(picture())));},schedule:(fn,ms)=>{const h={fn,ms};scheduled.push(h);return h;},cancel:h=>{h.cancelled=true;}});
 const a=loader.request('A','/a'),duplicate=loader.request('A','/a'),b=loader.request('B','/b'),c=loader.request('C','/c');assert.equal(a,duplicate);await turn();assert.deepEqual(loads,['/a','/b']);
 releases[0]();releases[1]();await turn();assert.deepEqual(loads,['/a','/b','/c']);
 let delivered=0;a.then(()=>delivered++);b.then(()=>delivered++);await turn();assert.equal(delivered,0);
 const flush=scheduled.find(h=>h.ms===40&&!h.cancelled);flush.fn();await turn();assert.equal(delivered,2);
 releases[2]();await turn();scheduled.filter(h=>h.ms===40&&!h.cancelled).at(-1).fn();await c;await loader.request('A','/a');assert.equal(loads.length,3);loader.clear();
});
test('one failed image does not block other images, cooldown prevents repeated failure and only explicit retry bypasses it',async()=>{
 let count=0;const loader=createThumbnailBatchLoader({flushMs:0,load:async url=>{count++;if(url==='/bad')throw Error('network');return picture();}});
 await Promise.all([assert.rejects(loader.request('bad','/bad'),/network/),loader.request('good','/good')]);
 await assert.rejects(loader.request('bad','/bad'),/network/);assert.equal(count,2);await assert.rejects(loader.request('bad','/bad',{force:true}),/network/);assert.equal(count,3);loader.clear();
});
test('tenant changes abort queued and running deliveries; stale images never enter the new scope cache',async()=>{
 let finish;const loader=createThumbnailBatchLoader({flushMs:0,load:async()=>new Promise(resolve=>finish=resolve)});
 const pending=loader.request('old|/a','/a');const rejection=assert.rejects(pending,{name:'AbortError'});await turn();loader.clear();await rejection;finish(picture());await turn();await turn();
 let called=false;const next=createThumbnailBatchLoader({flushMs:0,load:async()=>{called=true;return picture();}});await next.request('new|/a','/a');assert.equal(called,true);next.clear();
});
test('editing one image invalidates its pending response without evicting another product',async()=>{
 let finish,calls=0;const loader=createThumbnailBatchLoader({flushMs:0,load:async url=>{calls++;if(url==='/a'&&calls===2)return new Promise(resolve=>finish=resolve);return picture();}});
 await loader.request('B','/b');const old=loader.request('A','/a');const rejection=assert.rejects(old,{name:'AbortError'});await turn();loader.invalidate(key=>key==='A');await rejection;
 const fresh=await loader.request('A','/a',{force:true});finish(new Blob(['stale'],{type:'image/webp'}));await turn();assert.equal(await loader.request('A','/a'),fresh);await loader.request('B','/b');assert.equal(calls,3);loader.clear();
});
test('thumbnail cache has bounded size and expiry, and rejects placeholders/oversized/non-image responses',async()=>{
 let clock=0,calls=0;const loader=createThumbnailBatchLoader({flushMs:0,maxEntries:1,ttlMs:10,now:()=>clock,load:async()=>{calls++;return picture();}});
 await loader.request('A','/a');await loader.request('B','/b');await loader.request('A','/a');assert.equal(calls,3);clock=11;await loader.request('A','/a');assert.equal(calls,4);loader.clear();
 for(const response of [{blob:picture(),headers:new Headers({'X-Image-Proxy-Cache':'PLACEHOLDER'})},new Blob(['bad'],{type:'application/json'}),new Blob([new Uint8Array(512*1024+1)],{type:'image/webp'})]){
  const bad=createThumbnailBatchLoader({flushMs:0,load:async()=>response});await assert.rejects(bad.request('A','/a'));bad.clear();
 }
});
test('a timed-out thumbnail releases its slot for the next image',async()=>{
 const loader=createThumbnailBatchLoader({concurrency:1,flushMs:0,timeoutMs:10,load:async url=>url==='/stuck'?new Promise(()=>{}):picture()});
 const bad=assert.rejects(loader.request('A','/stuck'),/超时/),good=loader.request('B','/next');await Promise.all([bad,good]);loader.clear();
});
