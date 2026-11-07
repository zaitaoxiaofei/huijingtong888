import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { withMysqlWorkload } from '../src/mysql-workload.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('foreground SQL protection releases before separate inventory facts, including failures and background callers', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 30000
}, async () => {
  const fixture = await createTenantMysqlFixture('interactive_query');
  fixture.useEnvironment();
  process.env.DB_POOL_MAX = '2';
  process.env.DB_POOL_MIN = '0';
  const { getMysqlPool, mysqlQuery, closeMysqlPool, getMysqlPoolMetrics } = await import('../src/mysql-pool.js');
  const foreground = getMysqlPool(), background = withMysqlWorkload('background', getMysqlPool);
  const coreEntered = deferred(), coreGate = deferred(), factsEntered = deferred(), factsGate = deferred();
  const failure = new Error('controlled core failure');
  const borrowForeground = foreground.getConnection.bind(foreground), borrowBackground = background.getConnection.bind(background);
  let backgroundAcquires = 0, aggregate;
  foreground.getConnection = async () => {
    const connection = await borrowForeground(), query = connection.query.bind(connection);
    connection.query = async (sql, params) => {
      if (sql === 'SELECT 1 AS core_value') { coreEntered.resolve(); const result = await query(sql, params); await coreGate.promise; return result; }
      if (sql === 'SELECT 2 AS failing_core') throw failure;
      return query(sql, params);
    };
    return connection;
  };
  background.getConnection = async () => {
    backgroundAcquires++;
    const connection = await borrowBackground(), query = connection.query.bind(connection);
    connection.query = async (sql, params) => {
      const result = await query(sql, params);
      if (sql === 'SELECT 0 AS available_stock') { factsEntered.resolve(); await factsGate.promise; }
      return result;
    };
    return connection;
  };
  try {
    const core = mysqlQuery('SELECT 1 AS core_value', [], { interactive: true });
    await coreEntered.promise;
    const facts = withMysqlWorkload('background', () => mysqlQuery('SELECT 0 AS available_stock'));
    aggregate = Promise.all([core, facts]);
    await new Promise(setImmediate);
    assert.equal(backgroundAcquires, 0, 'the new background read waits before acquiring a connection');
    coreGate.resolve();
    assert.equal((await core)[0].core_value, 1);
    await factsEntered.promise;
    assert.equal(backgroundAcquires, 1, 'facts can start as soon as core SQL returns, while the aggregate is still pending');
    factsGate.resolve();
    assert.equal((await aggregate)[1][0].available_stock, 0);

    await assert.rejects(mysqlQuery('SELECT 2 AS failing_core', [], { interactive: true }), error => error === failure);
    assert.equal((await withMysqlWorkload('background', () => mysqlQuery('SELECT 3 AS after_failure')))[0].after_failure, 3);
    const began = performance.now();
    assert.equal((await withMysqlWorkload('background', () => mysqlQuery('SELECT 4 AS background_value', [], { interactive: true })))[0].background_value, 4);
    assert.ok(performance.now() - began < 1500, 'a background caller must not wait on a guard it created itself');
    assert.equal(getMysqlPoolMetrics().activeConnections, 0);
  } finally {
    coreGate.resolve(); factsGate.resolve();
    await aggregate?.catch(() => {});
    foreground.getConnection = borrowForeground; background.getConnection = borrowBackground;
    await closeMysqlPool();
    await fixture.cleanup();
  }
});
