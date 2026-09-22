import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { initializeOrderQueryFacts, stockLocationSql, transportStatusesSql } from '../src/services/order-query-facts.js';

test('query facts preserve JSON fallback and transactional history changes', {
  skip: !process.env.ORDER_QUERY_FACTS_TEST_DATABASE
}, async () => {
  const database = process.env.ORDER_QUERY_FACTS_TEST_DATABASE;
  assert.match(database, /^ozon_query_facts_test_[0-9]+$/);
  const connection = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root' });
  let created = false;
  try {
    await connection.query('CREATE DATABASE ' + connection.escapeId(database));
    created = true;
    await connection.query('USE ' + connection.escapeId(database));
    await connection.query('CREATE TABLE ozon_orders_raw (id INT PRIMARY KEY, store_id BIGINT DEFAULT 1, posting_number VARCHAR(64), raw_json LONGTEXT NULL)');
    await connection.query('CREATE TABLE order_status_history (id INT PRIMARY KEY, order_id BIGINT UNSIGNED NOT NULL, status VARCHAR(64), last_status_changed_at DATETIME NULL, KEY idx_order_history_transport (order_id,status,last_status_changed_at))');
    await connection.query("INSERT INTO order_status_history VALUES (1,1,'delivering','2026-09-01'),(2,1,'delivered',NULL),(3,2,'delivered',NULL)");
    await connection.query('INSERT INTO ozon_orders_raw (id, raw_json) VALUES (1, ?)', ['{"delivery_method":{"warehouse":"FBP"}}']);
    await initializeOrderQueryFacts(connection);
    const read = async id => (await connection.query(`SELECT COUNT(*) > 0 AS has_history, MIN(last_status_changed_at) AS transport_at
      FROM order_status_history WHERE order_id=? AND status IN ${transportStatusesSql}`, [id]))[0][0];
    assert.equal((await read(1)).transport_at.getDate(), 1);
    assert.equal((await read(2)).has_history, 1);
    await connection.query("INSERT INTO order_status_history VALUES (4,1,'delivering','2026-08-01')");
    assert.equal((await read(1)).transport_at.getMonth(), 7);
    await connection.beginTransaction();
    await connection.query('DELETE FROM order_status_history WHERE id=4');
    assert.equal((await read(1)).transport_at.getMonth(), 8);
    await connection.rollback();
    assert.equal((await read(1)).transport_at.getMonth(), 7);
    await connection.query("UPDATE order_status_history SET order_id=3, status='cancelled' WHERE id=4");
    assert.equal((await read(1)).transport_at.getMonth(), 8);
    await connection.query('DELETE FROM order_status_history WHERE order_id=1');
    assert.equal((await read(1)).has_history, 0);
    const fixtures = [
      [null, 'LOCAL'], [{}, 'LOCAL'], [{ delivery_method: { name: 'FBP' } }, 'FBP'],
      [{ analytics_data: { warehouse: '珲春' } }, 'FBP'],
      [{ delivery_method: { name: 'LOCAL' }, raw: { delivery_method: { name: 'FBP' } } }, 'FBP'],
      [{ delivery_method: { name: 'FBP' }, raw: { delivery_method: { name: null } } }, 'LOCAL'],
      [{ delivery_method: { name: 'FBP' }, raw: { delivery_method: null } }, 'FBP'],
      [{ analytics_data: { tpl_provider: 'hch-pd' } }, 'FBP'],
      [{ raw: { analytics_data: { warehouse: '' } }, analytics_data: { warehouse: 'FBP' } }, 'LOCAL']
    ];
    for (const [fixture, expected] of fixtures) {
      await connection.query('UPDATE ozon_orders_raw SET raw_json=? WHERE id=1', [fixture === null ? null : JSON.stringify(fixture)]);
      const [[row]] = await connection.query('SELECT query_stock_location AS actual, ' + stockLocationSql('raw_json') + ' AS projected FROM ozon_orders_raw WHERE id=1');
      assert.equal(row.actual, expected, JSON.stringify(fixture));
      assert.equal(row.projected, expected);
    }
    await connection.beginTransaction();
    await connection.query('UPDATE ozon_orders_raw SET raw_json=? WHERE id=1', ['{"delivery_method":{"name":"FBP"}}']);
    assert.equal((await connection.query('SELECT query_stock_location FROM ozon_orders_raw WHERE id=1'))[0][0].query_stock_location, 'FBP');
    await connection.rollback();
    assert.equal((await connection.query('SELECT query_stock_location FROM ozon_orders_raw WHERE id=1'))[0][0].query_stock_location, 'LOCAL');
    await initializeOrderQueryFacts(connection);
    assert.equal((await read(1)).has_history, 0);
    const concurrent = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database });
    try {
      for (let i = 0; i < 5; i += 1) {
        await Promise.all([
          connection.query("INSERT INTO order_status_history VALUES (?,10,'delivering','2026-09-01')", [100 + i]),
          concurrent.query("INSERT INTO order_status_history VALUES (?,10,'delivering','2026-08-01')", [200 + i])
        ]);
      }
      assert.equal((await read(10)).transport_at.getMonth(), 7);
    } finally { await concurrent.end(); }
    console.log('Isolated query-facts test passed; production tables were not changed.');
  } finally {
    if (created) await connection.query('DROP DATABASE ' + connection.escapeId(database));
    await connection.end();
  }
});
