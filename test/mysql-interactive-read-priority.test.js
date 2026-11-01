import test from 'node:test';
import assert from 'node:assert/strict';
import {withMysqlWorkload,withMysqlInteractiveRead,waitForMysqlInteractiveReads} from '../src/mysql-workload.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('new background reads wait for concurrent interactive rows, foreground and errors remain live',async()=>{
 const a=deferred(),b=deferred(),events=[];
 const first=withMysqlInteractiveRead(()=>a.promise);
 const second=withMysqlInteractiveRead(async()=>{await b.promise;throw Error('reader failed');});
 const failed=assert.rejects(second,/reader failed/);
 const background=withMysqlWorkload('background',async()=>{await waitForMysqlInteractiveReads();events.push('scan');});
 await withMysqlWorkload('foreground',()=>waitForMysqlInteractiveReads());
 a.resolve();await first;assert.deepEqual(events,[]);
 b.resolve();await failed;await background;assert.deepEqual(events,['scan']);
 await withMysqlWorkload('background',()=>waitForMysqlInteractiveReads());
});
test('continuous interactive reads cannot indefinitely starve background work',{timeout:3500},async()=>{
 const hold=deferred(),read=withMysqlInteractiveRead(()=>hold.promise),started=performance.now();
 try{await withMysqlWorkload('background',()=>waitForMysqlInteractiveReads());assert.ok(performance.now()-started>=1900);assert.ok(performance.now()-started<3000);}
 finally{hold.resolve();await read;}
});
test('only ordinary row-only order pages pause scans; coverage-dependent pages remain outside the gate',async()=>{
 const {readFileSync}=await import('node:fs');const vm=await import('node:vm');
 const runtime=readFileSync(new URL('../src/services/mysql-runtime-services.js',import.meta.url),'utf8');
 const body=runtime.match(/ordersPaged: ([\s\S]*?),\n  outboundRecords:/)?.[1];assert.ok(body);
 const seen=[];const context=vm.createContext({String,withRequestReadCache:op=>op(),withMysqlWorkload:(_,op)=>op(),withMysqlInteractiveRead:op=>{seen.push('interactive');return op();},ordersPagedMysql:async()=>seen.push('rows')});
 const read=vm.runInContext('('+body+')',context);
 for(const query of [{includeCounts:0},{include_counts:'0',include_rows:1,status:'all'}]){seen.length=0;await read(query);assert.deepEqual(seen,['interactive','rows']);}
 for(const query of [{},{includeCounts:1},{includeRows:0,includeCounts:0},...['pending_purchase','purchase_in_transit','purchase_records_missing'].map(status=>({status,includeCounts:0}))]){seen.length=0;await read(query);assert.deepEqual(seen,['rows']);}
});
test('background read admission is serial, preserves priority, and recovers after errors without delaying foreground SQL',async()=>{
 const {withMysqlBackgroundReadAdmission,currentMysqlWorkload}=await import('../src/mysql-workload.js');
 const hold=deferred(),events=[];
 const first=withMysqlWorkload('background',()=>withMysqlBackgroundReadAdmission(async()=>{events.push('first');assert.equal(currentMysqlWorkload(),'background');await hold.promise;throw Error('failed scan');}));
 const rejected=assert.rejects(first,/failed scan/);
 const next=withMysqlWorkload('background',()=>withMysqlBackgroundReadAdmission(async()=>{events.push('next');return 42;}));
 await withMysqlWorkload('foreground',()=>withMysqlBackgroundReadAdmission(async()=>events.push('foreground')));
 assert.ok(!events.includes('next'));hold.resolve();await rejected;assert.equal(await next,42);assert.ok(events.indexOf('next')>events.indexOf('first'));
});
