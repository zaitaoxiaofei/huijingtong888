import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { withMysqlWorkload, currentMysqlWorkload } from '../src/mysql-workload.js';

test('saturated background pool cannot take foreground capacity; transactions and session settings remain correct', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 120000
}, async () => {
  const fixture = await createTenantMysqlFixture('workload');
  fixture.useEnvironment();
  process.env.DB_POOL_MAX = '4';
  process.env.DB_POOL_MIN = '0';
  const { getMysqlPool, mysqlQuery, withMysqlTransaction, closeMysqlPool, getMysqlPoolMetrics } = await import('../src/mysql-pool.js');
  const backgroundPool = withMysqlWorkload('background', getMysqlPool);
  let held, pending;
  try {
    held = await backgroundPool.getConnection();
    const queued = once(backgroundPool.pool, 'enqueue');
    pending = withMysqlWorkload('background', () => mysqlQuery('SELECT 7 AS background_value, @@session.time_zone AS tz'));
    await queued;
    const foreground = await mysqlQuery('SELECT 9 AS foreground_value, @@session.time_zone AS tz');
    assert.equal(foreground[0].foreground_value, 9);
    assert.equal(foreground[0].tz, '+00:00');
    assert.equal(backgroundPool.pool._connectionQueue.length, 1, 'Background query must still be waiting');
    const foregroundPool = getMysqlPool();
    assert.notEqual(foregroundPool, backgroundPool);
    assert.equal(foregroundPool.pool.config.connectionLimit + backgroundPool.pool.config.connectionLimit, 4);
    await fixture.query('CREATE TABLE workload_check (id INT)');
    await withMysqlWorkload('background', async () => {
      await assert.rejects(withMysqlTransaction(async connection => {
        assert.equal(currentMysqlWorkload(), 'foreground');
        await connection.query('INSERT INTO workload_check VALUES (1)');
        assert.equal((await mysqlQuery('SELECT 11 AS nested_value'))[0].nested_value, 11);
        assert.equal(getMysqlPoolMetrics().foregroundActive, 1);
        assert.equal(getMysqlPoolMetrics().backgroundActive, 0);
        throw new Error('rollback fixture');
      }), /rollback fixture/);
      assert.equal(currentMysqlWorkload(), 'background');
    });
    assert.equal((await fixture.query('SELECT COUNT(*) AS n FROM workload_check'))[0].n, 0, 'Failed transaction must roll back');
    await withMysqlWorkload('background', () => withMysqlTransaction(connection => connection.query('INSERT INTO workload_check VALUES (2)')));
    assert.equal((await fixture.query('SELECT COUNT(*) AS n FROM workload_check'))[0].n, 1, 'Successful transaction must commit');
    assert.equal(getMysqlPoolMetrics().activeConnections, 0);
    held.release(); held = null;
    const rows = await pending;
    assert.equal(rows[0].background_value, 7);
    assert.equal(rows[0].tz, '+00:00');
    assert.equal(getMysqlPoolMetrics().backgroundActive, 0);
    await closeMysqlPool();
    assert.equal((await mysqlQuery('SELECT 13 AS reopened'))[0].reopened, 13);
    assert.equal(getMysqlPoolMetrics().activeConnections, 0);
  } finally {
    held?.release();
    await pending?.catch(() => {});
    await closeMysqlPool();
    await fixture.cleanup();
  }
});
