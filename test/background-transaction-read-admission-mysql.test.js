import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {withMysqlWorkload} from '../src/mysql-workload.js';
test('interactive SQL overtakes scheduled nested reads without changing transaction commit semantics',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:30000
},async()=>{
 const f=await createTenantMysqlFixture('tx_read_admit');f.useEnvironment();process.env.DB_POOL_MAX='3';
 const {mysqlQuery,withMysqlTransaction,getMysqlPoolMetrics,closeMysqlPool}=await import('../src/mysql-pool.js');
 await f.query('CREATE TABLE marker (id INT PRIMARY KEY)');let start;const started=new Promise(r=>start=r),events=[];
 try{
  const writer=withMysqlWorkload('background',()=>withMysqlTransaction(async c=>{
   await c.execute('INSERT INTO marker VALUES(1)');
   const reads=Array.from({length:12},(_,id)=>mysqlQuery('SELECT SLEEP(0.025) AS delay, ? AS value',[id]).then(()=>events.push(id)));
   start();await Promise.all(reads);
  }));
  await started;const deadline=Date.now()+2000;while(getMysqlPoolMetrics().foregroundActive<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,2));
  assert.equal(getMysqlPoolMetrics().foregroundActive,2);
  assert.equal((await mysqlQuery('SELECT 99 AS value'))[0].value,99);events.push('interactive');
  await writer;assert.ok(events.indexOf('interactive')<12,'interactive query must not queue behind the entire scheduled fan-out');
  assert.equal((await f.query('SELECT COUNT(*) AS total FROM marker'))[0].total,1);
 }finally{await closeMysqlPool();await f.cleanup();}
});
