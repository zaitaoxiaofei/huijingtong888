import test from 'node:test';
import assert from 'node:assert/strict';
import {createInventoryDemandSnapshot,waitForInventoryDemandJobs} from '../src/services/inventory-demand-snapshot.js';
import {currentMysqlWorkload,withMysqlWorkload,withMysqlInteractiveRead,withMysqlBackgroundReadAdmission,waitForMysqlInteractiveReads} from '../src/mysql-workload.js';

test('HTTP-triggered demand refresh uses the background lane without blocking its interactive reader',async()=>{
  const calls=[];
  const statement=name=>withMysqlBackgroundReadAdmission(async()=>{
    await waitForMysqlInteractiveReads();calls.push([name,currentMysqlWorkload()]);
  });
  const read=createInventoryDemandSnapshot({
    query:async sql=>{if(sql.startsWith('SELECT')){calls.push(['persisted',currentMysqlWorkload()]);return[];}await statement('save');return[];},
    products:async()=>{await statement('products');return[{product_id:20}];},
    calculate:async()=>{await Promise.all([statement('coverage'),statement('forecast')]);return[{product_id:20}];},
    revision:()=>0,readJson:async text=>text,writeJson:async text=>{calls.push(['encode',currentMysqlWorkload()]);return text;}
  });
  let timeout;
  try{
    const result=await Promise.race([
      withMysqlWorkload('foreground',()=>withMysqlInteractiveRead(()=>read(2,{fresh:true}))),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Interactive read awaited its paused background refresh')),300);})
    ]);
    assert.equal(result.snapshot.available,false);assert.equal(result.snapshot.refreshing,true);
  }finally{clearTimeout(timeout);}
  await waitForInventoryDemandJobs();
  assert.deepEqual(calls,[['persisted','foreground'],['products','background'],['coverage','background'],['forecast','background'],['encode','background'],['save','background']]);
  assert.equal((await read(2)).rows[0].product_id,20);
  assert.equal(currentMysqlWorkload(),'foreground','The job does not change its caller context');
});

test('queued enterprises and an explicit follow-up keep background priority after a write',async()=>{
  let epoch=0,release;
  const held=new Promise(resolve=>release=resolve),calls=[];
  const read=createInventoryDemandSnapshot({query:async sql=>sql.startsWith('SELECT')?[]:[],
    products:async tenant=>{calls.push(['products',tenant,currentMysqlWorkload()]);if(calls.length===1)await held;return[{product_id:tenant*10}];},
    calculate:async(ids,tenant)=>{calls.push(['calculate',tenant,currentMysqlWorkload()]);return ids.map(product_id=>({product_id}));},
    revision:()=>epoch,readJson:async text=>text,writeJson:async text=>text});
  await read(2,{fresh:true});await Promise.resolve();await read(3,{fresh:true});
  epoch++;await read(2,{fresh:true});release();await waitForInventoryDemandJobs();
  assert.ok(calls.length>=6);assert.ok(calls.every(([, ,lane])=>lane==='background'));
  assert.equal((await read(2)).rows[0].product_id,20);assert.equal((await read(3)).rows[0].product_id,30);
});
