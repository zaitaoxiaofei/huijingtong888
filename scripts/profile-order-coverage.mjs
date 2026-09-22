// Read-only, cold full-coverage benchmark. Prints timings/counts, not business data.
import assert from 'node:assert/strict';
import { getMysqlPool, closeMysqlPool } from '../src/mysql-pool.js';
import { loadOrderProcurementCoverage } from '../src/services/mysql-order-procurement-coverage.js';
import { stockLocationSql } from '../src/services/order-query-facts.js';

const connection = await getMysqlPool().getConnection();
try {
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const [[raw]] = await connection.query(`SELECT COUNT(*) AS mismatches FROM ozon_orders_raw
    WHERE NOT (query_stock_location <=> (${stockLocationSql('raw_json')}))`);
  assert.equal(Number(raw.mismatches), 0, 'Query facts must match the raw warehouse classification');
  await connection.commit();
  const timings = [];
  const started = performance.now();
  const coverage = await loadOrderProcurementCoverage(async sql => {
    const start = performance.now();
    const [rows] = await connection.query(sql);
    timings.push({ query: timings.length + 1, rows: rows.length, ms: Math.round(performance.now() - start) });
    return rows;
  }, '', { fresh: true });
  console.log(JSON.stringify({ equivalent: true, orders: coverage.size,
    coldCoverageMs: Math.round(performance.now() - started), timings }));
} finally {
  connection.destroy();
  await closeMysqlPool();
}
