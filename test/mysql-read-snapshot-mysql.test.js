import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { currentMysqlWorkload, withMysqlWorkload } from '../src/mysql-workload.js';

test('read snapshots preserve one RR view and clean every real pooled connection lease', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('read_snapshot');
  fixture.useEnvironment();
  process.env.DB_POOL_MAX = '2';
  process.env.DB_POOL_MIN = '0';
  const { getMysqlPool, getMysqlPoolMetrics, mysqlQuery, withMysqlTransaction,
    withMysqlReadSnapshot, closeMysqlPool } = await import('../src/mysql-pool.js');
  const foreground = getMysqlPool();
  const background = withMysqlWorkload('background', () => getMysqlPool());
  const nativeGet = foreground.getConnection.bind(foreground);
  const sessions = [];
  let nextLease = null, utcInitializations = 0;

  for (const pool of [foreground, background]) {
    pool.pool.on('connection', physical => {
      sessions.push(physical);
      // A successful snapshot must not rely on the server's default RR/UTC.
      physical.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
      physical.query("SET time_zone = '+08:00'");
      const nativeQuery = physical.query;
      physical.query = function(sql, ...args) {
        if (sql === 'SET time_zone = ?') utcInitializations++;
        return nativeQuery.call(this, sql, ...args);
      };
    });
  }
  foreground.getConnection = async () => {
    const connection = await nativeGet();
    const instrument = nextLease;
    nextLease = null;
    if (instrument) instrument(connection);
    return connection;
  };
  const idle = () => {
    const metrics = getMysqlPoolMetrics();
    assert.equal(metrics.activeConnections, 0);
    assert.equal(metrics.foregroundActive, 0);
    assert.equal(metrics.backgroundActive, 0);
  };
  const identity = async () => (await mysqlQuery('SELECT CONNECTION_ID() AS id, @@session.time_zone AS tz'))[0];
  const inject = (method, matches, failure) => {
    const observed = { destroys: 0, failed: false };
    nextLease = connection => {
      observed.id = connection.threadId;
      const original = connection[method].bind(connection);
      connection[method] = async (...args) => {
        if (!observed.failed && matches(...args)) {
          observed.failed = true;
          throw failure;
        }
        return original(...args);
      };
      const destroy = connection.destroy.bind(connection);
      connection.destroy = () => { observed.destroys++; return destroy(); };
    };
    return observed;
  };

  try {
    await fixture.query('CREATE TABLE snapshot_probe (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB');
    await fixture.query('INSERT INTO snapshot_probe VALUES (1,10),(2,20)');

    await t.test('both reads share a snapshot despite an independent committed writer', async () => {
      const result = { retained: true };
      let snapshotId;
      assert.equal(await withMysqlReadSnapshot(async query => {
        const [session] = await query('SELECT CONNECTION_ID() AS id, @@session.time_zone AS tz');
        snapshotId = session.id;
        assert.equal(session.tz, '+00:00');
        const first = await query('SELECT id,value FROM snapshot_probe ORDER BY id');
        await fixture.connection.beginTransaction();
        await fixture.query('UPDATE snapshot_probe SET value=11 WHERE id=1');
        await fixture.query('DELETE FROM snapshot_probe WHERE id=2');
        await fixture.query('INSERT INTO snapshot_probe VALUES (3,30)');
        await fixture.connection.commit();
        assert.deepEqual(await query('SELECT id,value FROM snapshot_probe ORDER BY id'), first);
        assert.equal((await query('SELECT CONNECTION_ID() AS id'))[0].id, snapshotId);
        return result;
      }, { interactive: true }), result, 'the operation return value is preserved');
      assert.deepEqual(await withMysqlReadSnapshot(query => query('SELECT id,value FROM snapshot_probe ORDER BY id')),
        [{ id: 1, value: 11 }, { id: 3, value: 30 }]);
      assert.equal((await identity()).id, snapshotId, 'clean snapshots reuse the physical session');
      assert.equal(utcInitializations, 1, 'UTC initialization is once per physical session');
      idle();
    });

    await t.test('read-only rejects writes, preserves errors and leaves the following transaction writable RC', async () => {
      const before = await identity();
      let originalError;
      await assert.rejects(withMysqlReadSnapshot(async query => {
        try { await query('UPDATE snapshot_probe SET value=99 WHERE id=1'); }
        catch (error) { originalError = error; throw error; }
      }), error => error === originalError && error.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION');
      assert.equal((await identity()).id, before.id, 'successful failure cleanup can reuse the session');
      await withMysqlTransaction(async connection => {
        const [[session]] = await connection.query('SELECT @@session.time_zone AS tz, @@session.transaction_isolation AS isolation');
        assert.equal(session.tz, '+00:00');
        assert.equal(session.isolation, 'READ-COMMITTED');
        assert.equal((await connection.query('SELECT value FROM snapshot_probe WHERE id=1'))[0][0].value, 11);
        await fixture.query('UPDATE snapshot_probe SET value=12 WHERE id=1');
        assert.equal((await connection.query('SELECT value FROM snapshot_probe WHERE id=1'))[0][0].value, 12,
          'next-only RR did not change the following transaction isolation');
        await connection.query('UPDATE snapshot_probe SET value=31 WHERE id=3');
      });
      assert.equal((await fixture.query('SELECT value FROM snapshot_probe WHERE id=3'))[0].value, 31);
      idle();
    });

    await t.test('background callers retain their lane even when interactive is requested', async () => {
      const before = await identity();
      await withMysqlWorkload('background', () => withMysqlReadSnapshot(async query => {
        assert.equal(currentMysqlWorkload(), 'background');
        const [session] = await query('SELECT CONNECTION_ID() AS id, @@session.time_zone AS tz');
        assert.notEqual(session.id, before.id, 'the independent background pool is used');
        assert.equal(session.tz, '+00:00');
        const metrics = getMysqlPoolMetrics();
        assert.equal(metrics.activeConnections, 1);
        assert.equal(metrics.foregroundActive, 0);
        assert.equal(metrics.backgroundActive, 1);
      }, { interactive: true }));
      idle();
    });

    for (const statement of ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY']) {
      await t.test(`failed ${statement.startsWith('SET') ? 'isolation setup' : 'snapshot start'} discards the lease without running the callback`, async () => {
        const before = await identity();
        const failure = new Error('injected snapshot setup failure');
        const observed = inject('query', sql => sql === statement, failure);
        let called = false;
        await assert.rejects(withMysqlReadSnapshot(async () => { called = true; }), error => error === failure);
        assert.equal(called, false);
        assert.equal(observed.failed, true);
        assert.equal(observed.id, before.id);
        assert.equal(observed.destroys, 1);
        idle();
        const after = await identity();
        assert.notEqual(after.id, before.id);
        assert.equal(after.tz, '+00:00');
        idle();
      });
    }

    await t.test('UTC setup failure destroys the uninitialized physical session and reconnects', async () => {
      const previous = await identity();
      const connection = await nativeGet();
      connection.destroy();
      const failure = new Error('injected UTC setup failure');
      const observed = inject('query', sql => sql === 'SET time_zone = ?', failure);
      await assert.rejects(withMysqlReadSnapshot(() => assert.fail('callback must not run')), error => error === failure);
      assert.equal(observed.failed, true);
      assert.equal(observed.destroys, 1);
      idle();
      const after = await identity();
      assert.notEqual(after.id, previous.id);
      assert.notEqual(after.id, observed.id);
      assert.equal(after.tz, '+00:00');
      idle();
    });

    await t.test('failed successful-operation cleanup discards the connection and returns its original error', async () => {
      const before = await identity();
      const failure = new Error('injected successful-operation rollback failure');
      const observed = inject('rollback', () => true, failure);
      await assert.rejects(withMysqlReadSnapshot(query => query('SELECT value FROM snapshot_probe')),
        error => error === failure);
      assert.equal(observed.destroys, 1);
      idle();
      assert.notEqual((await identity()).id, before.id);
      idle();
    });

    await t.test('callback failure stays original when rollback also fails, with no transaction or metric leak', async () => {
      const before = await identity();
      const failure = new Error('original callback failure');
      const observed = inject('rollback', () => true, new Error('secondary cleanup failure'));
      await assert.rejects(withMysqlReadSnapshot(async query => {
        await query('SELECT value FROM snapshot_probe');
        throw failure;
      }, { interactive: true }), error => error === failure);
      assert.equal(observed.destroys, 1);
      idle();
      const after = await identity();
      assert.notEqual(after.id, before.id);
      await withMysqlTransaction(connection => connection.query('UPDATE snapshot_probe SET value=32 WHERE id=3'));
      assert.equal((await fixture.query('SELECT value FROM snapshot_probe WHERE id=3'))[0].value, 32);
      assert.ok(sessions.length >= 6, 'injected failures exercised real replacement physical sessions');
      idle();
    });
  } finally {
    foreground.getConnection = nativeGet;
    await closeMysqlPool();
    await fixture.cleanup();
  }
});
