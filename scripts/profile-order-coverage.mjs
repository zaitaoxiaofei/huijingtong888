// Read-only production queries plus a session-local temporary history table.
// Run from the release directory with its environment loaded. Never creates a
// persistent index or changes business records. Prints timings, not order data.
import assert from 'node:assert/strict';
import { getMysqlPool, closeMysqlPool } from '../src/mysql-pool.js';
import { loadOrderProcurementCoverage } from '../src/services/mysql-order-procurement-coverage.js';

const connection = await getMysqlPool().getConnection();
try {
  // Include older orders, whose repeated status snapshots dominate cold loads.
  const [ids] = await connection.query('SELECT id FROM orders ORDER BY id ASC LIMIT 500');
  if (!ids.length) throw new Error('No orders available for profiling');
  const scope = ids.map(row => Number(row.id)).filter(Number.isSafeInteger).join(',');
  await connection.query(`CREATE TEMPORARY TABLE coverage_history_profile (
    order_id BIGINT UNSIGNED NOT NULL, status VARCHAR(64) NOT NULL,
    last_status_changed_at DATETIME NULL,
    KEY idx_order_history_transport (order_id, status, last_status_changed_at)
  )`);
  await connection.query(`INSERT INTO coverage_history_profile
    SELECT order_id, status, last_status_changed_at FROM order_status_history WHERE order_id IN (${scope})`);
  // MySQL cannot reopen the same temporary table in two subqueries.
  await connection.query('CREATE TEMPORARY TABLE coverage_history_exists LIKE coverage_history_profile');
  await connection.query('INSERT INTO coverage_history_exists SELECT * FROM coverage_history_profile');
  await loadOrderProcurementCoverage(async sql => {
    if (!sql.startsWith('SELECT o.id AS order_id')) return [];
    const scoped = `${sql} WHERE o.id IN (${scope})`;
    const start = performance.now();
    const [before] = await connection.query(scoped);
    const originalMs = performance.now() - start;
    const optimizedSql = scoped.replace('order_status_history h', 'coverage_history_profile h')
      .replace('order_status_history h', 'coverage_history_exists h');
    const optimizedStart = performance.now();
    const [after] = await connection.query(optimizedSql);
    const indexedMs = performance.now() - optimizedStart;
    const normalize = rows => rows.map(row => JSON.stringify(row)).sort();
    assert.deepEqual(normalize(after), normalize(before), 'Index must preserve every demand field');
    const [plan] = await connection.query(`EXPLAIN ${optimizedSql}`);
    assert.ok(plan.filter(row => row.table === 'h').every(row => row.key === 'idx_order_history_transport'));
    console.log(JSON.stringify({ sampleOrders: ids.length, demandRows: before.length,
      originalMs: Math.round(originalMs), indexedMs: Math.round(indexedMs), equivalent: true }));
    return [];
  }, '', { fresh: true });
} finally {
  // The temporary table disappears with this connection, even after failure.
  connection.destroy();
  await closeMysqlPool();
}
