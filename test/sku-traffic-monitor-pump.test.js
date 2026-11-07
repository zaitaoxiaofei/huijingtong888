import test from 'node:test';
import assert from 'node:assert/strict';
import {createDailyTrafficMonitor} from '../frontend/admin/utils/sku-traffic-monitor-pump.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('daily monitor refreshes before waking and repeats without manual extension polling',async()=>{
 const events=[];let tick,scheduled=0,cancelled=0;
 const pump=createDailyTrafficMonitor({refresh:async()=>events.push('refresh'),wake:()=>events.push('wake'),schedule:(fn,delay)=>{assert.equal(delay,60000);scheduled++;tick=fn;return 7;},cancel:id=>{assert.equal(id,7);cancelled++;}});
 pump.start();pump.start();await flush();assert.deepEqual(events,['refresh','wake']);assert.equal(scheduled,1);
 tick();await flush();assert.deepEqual(events,['refresh','wake','refresh','wake']);pump.stop();assert.equal(cancelled,1);
 pump.start();tick();await flush();assert.equal(events.length,4);
});
test('late or failed refreshes do not wake after disposal or wedge later checks',async()=>{
 let finish,wakes=0,reads=0,fail=true;
 const pump=createDailyTrafficMonitor({refresh:async()=>{reads++;if(fail)throw Error('fixture');},wake:()=>wakes++});
 await assert.rejects(pump.check());fail=false;await pump.check();assert.equal(reads,2);assert.equal(wakes,1);
 const stopped=createDailyTrafficMonitor({refresh:()=>new Promise(resolve=>finish=resolve),wake:()=>wakes++});
 const running=stopped.check();await stopped.check();stopped.stop();finish();await running;assert.equal(wakes,1);
});
test('manual loads and queue submission suppress overlapping monitor reads',async()=>{
 let busy=true,reads=0;const pump=createDailyTrafficMonitor({refresh:async()=>reads++,wake:()=>{},busy:()=>busy});
 await pump.check();assert.equal(reads,0);busy=false;await pump.check();assert.equal(reads,1);pump.stop();
});
