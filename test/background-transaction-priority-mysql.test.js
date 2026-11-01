import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {withMysqlWorkload,currentMysqlWorkload} from '../src/mysql-workload.js';
test('scheduled writers cannot occupy the foreground pool; interactive commit and background rollback stay correct',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:30000
},async()=>{
 const f=await createTenantMysqlFixture('writer_priority');f.useEnvironment();process.env.DB_POOL_MAX='4';
 const {withMysqlTransaction,mysqlQuery,closeMysqlPool}=await import('../src/mysql-pool.js');
 let release,started;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;}),events=[];let first,second;
 try{
  await f.query('CREATE TABLE writer_priority(id INT PRIMARY KEY)');
  first=withMysqlWorkload('background',()=>withMysqlTransaction(async c=>{events.push('first');assert.equal(currentMysqlWorkload(),'foreground');started();await gate;assert.equal((await mysqlQuery('SELECT 7 n'))[0].n,7);await c.query('INSERT INTO writer_priority VALUES(1)');}));
  await entered;
  second=withMysqlWorkload('background',()=>withMysqlTransaction(async c=>{events.push('second');await c.query('INSERT INTO writer_priority VALUES(2)');throw Error('expected rollback');}));
  const failed=assert.rejects(second,/expected rollback/);
  await withMysqlTransaction(c=>c.query('INSERT INTO writer_priority VALUES(3)'));
  assert.deepEqual(events,['first']);assert.deepEqual((await f.query('SELECT id FROM writer_priority')).map(r=>r.id),[3]);
  release();await first;await failed;
  await withMysqlWorkload('background',()=>withMysqlTransaction(c=>c.query('INSERT INTO writer_priority VALUES(4)')));
  assert.deepEqual((await f.query('SELECT id FROM writer_priority ORDER BY id')).map(r=>r.id),[1,3,4]);
 }finally{release?.();await Promise.allSettled([first,second].filter(Boolean));await closeMysqlPool();await f.cleanup();}
});
