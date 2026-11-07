import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const scheduler=readFileSync(new URL('../src/services/scheduled-jobs.js',import.meta.url),'utf8');
const definition=vm.runInNewContext(`(${server.match(/\{\s*key: "ogl_official_monitor",[\s\S]*?\n  \}/)[0]})`);
function fn(source,name,async=false) {
  const start=source.indexOf(`${async?'async ':''}function ${name}(`);assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n}',start)+2);
}
async function claimFixture(overrides={},crowded=false) {
  const now=Date.parse('2026-10-22T12:00:00Z');
  class Clock extends Date {constructor(value=now){super(value);}static now(){return now;}}
  let id=0;
  const row=(key,category,priority,age)=>({id:++id,job_key:key,category,priority,next_run_at:new Clock(now-age)});
  const rows=[row('order_status_sync','orders','critical',180000),
    ...Array.from({length:crowded?14:1},(_,index)=>row(`posting-${index}`,'orders','high',90000-index*1000)),
    row('operational_notifications','operations','high',45000),row('ozon_stock_sync','inventory','high',30000),
    row(definition.key,overrides.category||definition.category,overrides.priority||definition.priority,120000)];
  const claimed=[];let candidates=[];
  const context=vm.createContext({Date:Clock,Set,Math,Number,String,DEFAULT_LOCK_TTL_MINUTES:120,
    sqlDate:value=>value.toISOString().slice(0,19).replace('T',' '),addMinutes:(date,minutes)=>new Clock(date.getTime()+minutes*60000),randomUUID:()=>`fixture-lock-${claimed.length}`,
    mysqlQuery:async(sql,params)=>{
      assert.match(sql,/FIELD\(priority, 'critical', 'high', 'normal', 'low'\)/);assert.match(sql,/INTERVAL 120 MINUTE/);
      const priorities=['critical','high','normal','low'];
      candidates=rows.toSorted((a,b)=>priorities.indexOf(a.priority)-priorities.indexOf(b.priority)||a.next_run_at-b.next_run_at).slice(0,params.at(-1));
      return candidates;
    },mysqlExecute:async(_sql,params)=>{claimed.push(rows.find(row=>row.id===params[3]).job_key);return {affectedRows:1};}});
  vm.runInContext(fn(scheduler,'claimDueJobs',true),context);
  await context.claimDueJobs({limit:3,includeCatchup:true});return {claimed,candidates:candidates.map(row=>row.job_key)};
}
test('OGL has its own high-priority category and permits one bounded catchup execution',()=>{
  assert.equal(definition.category,'ogl');assert.equal(definition.priority,'high');assert.equal(definition.intervalMinutes,5);
  assert.equal(definition.catchupEnabled,true);assert.equal(definition.maxCatchupRuns,1);
});
test('actual candidate selection admits OGL before the low-priority cutoff and avoids the shared orders-category collision',async()=>{
  assert.ok(!(await claimFixture({priority:'low',category:'orders'},true)).candidates.includes(definition.key));
  assert.ok((await claimFixture({},true)).claimed.includes(definition.key));
  assert.ok(!(await claimFixture({category:'orders'})).claimed.includes(definition.key));
  assert.ok((await claimFixture()).claimed.includes(definition.key));
});
function deferralFixture(maxDelay=300000) {
  let now=Date.parse('2026-10-22T12:00:00Z'),pressure=false,busy=false,runs=0,releases=0;
  class Clock extends Date {constructor(value=now){super(value);}static now(){return now;}}
  const context=vm.createContext({Date:Clock,Math,Number,String,Set,console:{log:()=>{}},
    BACKGROUND_TASK_FOREGROUND_IDLE_MS:20000,BACKGROUND_CRITICAL_JOB_MAX_DEFERRAL_MS:maxDelay,
    activeForegroundApiRequests:1,lastForegroundApiAt:now,
    getMysqlPoolMetrics:()=>({activeConnections:pressure?8:0,connectionLimit:10}),
    claimBackgroundModuleLane:()=>busy?'fixture-lane-busy':null,releaseBackgroundModuleLane:()=>{releases++;},
    oglDispatch:{monitorRecent:async()=>{runs++;return {tenants:1};}}});
  const bounded=server.match(/const FOREGROUND_DEFERRAL_BOUNDED_JOBS = new Set\(\[[\s\S]*?\]\);/)[0];
  vm.runInContext(`${bounded}\nlet oglMonitorFirstDueAt=0;\n${['criticalJobForegroundDeferralExpired','foregroundApiDeferral','databasePoolDeferral','backgroundJobDeferral','withForegroundApiDeferral'].map(name=>fn(server,name)).join('\n')}`,context);
  const handlerStart=server.indexOf('withForegroundApiDeferral("ogl_official_monitor", async () =>');
  const handlerEnd=server.indexOf('\n  inventory_alert_snapshot_refresh:',handlerStart);
  vm.runInContext(`globalThis.handler=${server.slice(handlerStart,handlerEnd).trim().replace(/,$/,'')};`,context);
  return {context,advance:milliseconds=>{now+=milliseconds;},at:()=>new Clock(),pressure:value=>{pressure=value;},busy:value=>{busy=value;},runs:()=>runs,releases:()=>releases};
}
test('first OGL due anchor survives repeated retry planning; five minutes never bypasses DB pressure or its independent lane',async()=>{
  const fixture=deferralFixture();
  assert.equal((await fixture.context.handler({plannedFor:fixture.at(),intervalMinutes:5})).reason,'foreground_api_active');
  fixture.advance(299000);
  assert.equal((await fixture.context.handler({plannedFor:fixture.at(),intervalMinutes:5})).reason,'foreground_api_active','Retry next_run_at must not restart the first due anchor');
  fixture.advance(1000);fixture.pressure(true);
  assert.equal((await fixture.context.handler({plannedFor:fixture.at(),intervalMinutes:5})).reason,'database_pool_pressure');assert.equal(fixture.runs(),0);
  fixture.pressure(false);fixture.busy(true);
  const skipped=await fixture.context.handler({plannedFor:fixture.at(),intervalMinutes:5});assert.equal(skipped.skipped,true);assert.equal(skipped.reason,'fixture-lane-busy');assert.equal(fixture.runs(),0);
  fixture.busy(false);assert.equal((await fixture.context.handler({plannedFor:fixture.at(),intervalMinutes:5})).tenants,1);assert.equal(fixture.runs(),1);assert.equal(fixture.releases(),1);
  assert.equal((await fixture.context.handler({plannedFor:fixture.at(),intervalMinutes:5})).reason,'foreground_api_active','Only actually entering the lane resets the first-run anchor');
  assert.equal(fixture.context.foregroundApiDeferral('unbounded-maintenance',{plannedFor:new Date('2026-10-21')} ).reason,'foreground_api_active','Unrelated jobs retain their policy');
});
test('OGL keeps at least a five-minute foreground grace even if the general critical-job override is shorter',async()=>{
  const fixture=deferralFixture(1000);
  await fixture.context.handler({plannedFor:fixture.at()});fixture.advance(1000);
  assert.equal((await fixture.context.handler({plannedFor:fixture.at()})).reason,'foreground_api_active');assert.equal(fixture.runs(),0);
});
