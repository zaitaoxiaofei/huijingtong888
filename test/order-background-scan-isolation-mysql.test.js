import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {withMysqlWorkload} from '../src/mysql-workload.js';
test('a saturated single background connection does not hold interactive SQL',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:30000
},async()=>{
 const fixture=await createTenantMysqlFixture('workload_isolation');fixture.useEnvironment();process.env.DB_POOL_MAX='10';
 const {getMysqlPool,mysqlQuery,closeMysqlPool}=await import('../src/mysql-pool.js');let held;
 try{
  const background=withMysqlWorkload('background',()=>getMysqlPool());
  const foreground=withMysqlWorkload('foreground',()=>getMysqlPool());
  assert.equal(background.pool.config.connectionLimit,1);assert.equal(foreground.pool.config.connectionLimit,9);
  held=await background.getConnection();const queued=once(background.pool,'enqueue');
  const pending=withMysqlWorkload('background',()=>mysqlQuery('SELECT 7 AS background_value'));
  await queued;
  assert.equal((await withMysqlWorkload('foreground',()=>mysqlQuery('SELECT 9 AS foreground_value')))[0].foreground_value,9);
  held.release();held=null;assert.equal((await pending)[0].background_value,7);
 }finally{held?.release();await closeMysqlPool();await fixture.cleanup();}
});
