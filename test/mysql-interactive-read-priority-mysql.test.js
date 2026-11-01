import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {withMysqlInteractiveRead,withMysqlWorkload} from '../src/mysql-workload.js';
test('background SQL admission pauses before acquiring a connection while ordinary rows remain readable',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:30000
},async()=>{
 const fixture=await createTenantMysqlFixture('interactive_admission');fixture.useEnvironment();process.env.DB_POOL_MAX='10';
 const {mysqlQuery,closeMysqlPool,getMysqlPoolMetrics,getMysqlPool}=await import('../src/mysql-pool.js');
 let release;const held=new Promise(r=>release=r),events=[];
 try{
  const rows=withMysqlInteractiveRead(async()=>{assert.equal((await mysqlQuery('SELECT 21 AS result'))[0].result,21);await held;});
  const scan=withMysqlWorkload('background',async()=>{const result=await mysqlQuery('SELECT 22 AS result');events.push(result[0].result);});
  await new Promise(r=>setTimeout(r,50));assert.deepEqual(events,[]);assert.equal(getMysqlPoolMetrics().backgroundActive,0);
  assert.equal((await mysqlQuery('SELECT 23 AS result'))[0].result,23);
  release();await rows;await scan;assert.deepEqual(events,[22]);
  // Also pause queries that queued before an interactive request arrived.
  const pool=withMysqlWorkload('background',()=>getMysqlPool());
  const connection=await pool.getConnection(),queued=once(pool.pool,'enqueue');
  const waiting=withMysqlWorkload('background',async()=>{await mysqlQuery('SELECT 24 AS result');events.push(24);});
  await queued;
  let finish;const finished=new Promise(r=>finish=r);
  const interactive=withMysqlInteractiveRead(async()=>{connection.release();assert.equal((await mysqlQuery('SELECT 25 AS result'))[0].result,25);await finished;});
  try{await new Promise(r=>setTimeout(r,50));assert.deepEqual(events,[22]);}
  finally{finish();await interactive;await waiting;}
  assert.deepEqual(events,[22,24]);
 }finally{release();await closeMysqlPool();await fixture.cleanup();}
});
