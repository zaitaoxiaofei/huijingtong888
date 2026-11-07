import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('UTC initialization follows physical mysql2 sessions across wrapper leases, failures and reconnects', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('utc_session');
  fixture.useEnvironment();
  process.env.DB_POOL_MAX = '1';
  process.env.DB_POOL_MIN = '0';
  const { getMysqlPool, mysqlQuery, withMysqlTransaction, closeMysqlPool } = await import('../src/mysql-pool.js');
  const pool = getMysqlPool();
  let utcStatements = 0, failNextInitialization = false;
  const nativeConnections = [];
  pool.pool.on('connection', physical => {
    nativeConnections.push(physical);
    const query = physical.query;
    // Start each real connection outside UTC so merely omitting SET cannot pass.
    physical.query("SET time_zone = '+08:00'");
    physical.query = function(sql, ...args) {
      if (sql === 'SET time_zone = ?') {
        utcStatements++;
        if (failNextInitialization) {
          failNextInitialization = false;
          throw new Error('fixture UTC initialization failed');
        }
      }
      return query.call(this, sql, ...args);
    };
  });
  const read = async () => (await mysqlQuery('SELECT CONNECTION_ID() AS id, @@session.time_zone AS tz'))[0];
  try {
    await t.test('driver wrappers differ while repeated reads and transactions initialize the session once', async () => {
      const first = await pool.getConnection(), physical = first.connection;
      first.release();
      const second = await pool.getConnection();
      assert.notEqual(first, second, 'the installed driver returns new wrappers');
      assert.equal(second.connection, physical);
      second.release();
      const a = await read(), b = await read();
      assert.equal(a.id, b.id);
      assert.equal(a.tz, '+00:00');
      assert.equal(b.tz, '+00:00');
      await withMysqlTransaction(async connection => {
        assert.equal((await connection.query('SELECT @@session.time_zone AS tz'))[0][0].tz, '+00:00');
      });
      await assert.rejects(withMysqlTransaction(async connection => {
        assert.equal((await connection.query('SELECT @@session.time_zone AS tz'))[0][0].tz, '+00:00');
        throw new Error('fixture rollback');
      }), /fixture rollback/);
      assert.equal((await read()).tz, '+00:00');
      assert.equal(utcStatements, 1, 'UTC SET is not repeated for each query or transaction');
    });
    await t.test('a replacement physical connection receives its own UTC initialization', async () => {
      const previous = await read(), connection = await pool.getConnection();
      connection.destroy();
      const next = await read();
      assert.notEqual(next.id, previous.id);
      assert.equal(next.tz, '+00:00');
      assert.equal(utcStatements, 2);
      assert.equal(nativeConnections.length, 2);
    });
    await t.test('failed SET is retried on the same physical session before any business read', async () => {
      const connection = await pool.getConnection();
      connection.destroy();
      failNextInitialization = true;
      await assert.rejects(read(), /fixture UTC initialization failed/);
      assert.equal(utcStatements, 3);
      const retried = await read();
      assert.equal(retried.tz, '+00:00');
      assert.equal(utcStatements, 4);
      assert.equal(nativeConnections.length, 3, 'retry uses the same uninitialized physical session');
      assert.equal((await read()).id, retried.id);
      assert.equal(utcStatements, 4);
    });
  } finally {
    await closeMysqlPool();
    await fixture.cleanup();
  }
});
