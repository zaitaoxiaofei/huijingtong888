import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('actual mysql2 queue saturation becomes recoverable 503 only while acquiring a connection', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('pool_capacity');
  fixture.useEnvironment();
  process.env.DB_POOL_MAX = '1';
  process.env.DB_POOL_MIN = '0';
  process.env.DB_POOL_QUEUE_LIMIT = '1';
  const { getMysqlPool, mysqlQuery, closeMysqlPool } = await import('../src/mysql-pool.js');
  const pool = getMysqlPool();
  let held;
  try {
    await t.test('the installed driver rejects a full queue without an error code; service returns DB_POOL_BUSY', async () => {
      held = await pool.getConnection();
      const enqueued = once(pool.pool, 'enqueue');
      const waiting = mysqlQuery('SELECT 7 AS own_value');
      await enqueued;
      await assert.rejects(mysqlQuery('SELECT 99 AS must_not_execute'), error => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'DB_POOL_BUSY');
        assert.equal(error.message, '系统繁忙，请稍后重试');
        assert.equal(error.cause.message, 'Queue limit reached.');
        assert.equal(error.cause.code, undefined);
        return true;
      });
      held.release(); held = null;
      assert.equal((await waiting)[0].own_value, 7);
      assert.equal((await mysqlQuery('SELECT 8 AS recovered'))[0].recovered, 8);
    });
    await t.test('a SQL execution error with the same wording retains its SQL code and is not retried or relabeled', async () => {
      await assert.rejects(mysqlQuery("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Queue limit reached.'"), error => {
        assert.equal(error.code, 'ER_SIGNAL_EXCEPTION');
        assert.equal(error.sqlMessage, 'Queue limit reached.');
        assert.equal(error.status, undefined);
        return true;
      });
      assert.equal((await mysqlQuery('SELECT 9 AS recovered'))[0].recovered, 9);
    });
  } finally {
    held?.release();
    await closeMysqlPool();
    await fixture.cleanup();
  }
});
