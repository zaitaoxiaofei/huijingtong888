import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { writeOnlineProductSync, writeStockSnapshotSync } from '../src/services/online-product-sync-write.js';

const largeBody = JSON.stringify({ facts: 'x'.repeat(100 * 1024), source: 'isolated-fixture' });
const payload = (shop = 20, sku = '101', body = largeBody) => [shop, sku, 'offer-' + sku, 'product-' + sku,
  'Fixture ' + sku, 'https://fixture.invalid/main.jpg', 'https://fixture.invalid/main.jpg', 100, 'RUB', 110, 120,
  'online', 'VISIBLE', 0, 0, JSON.stringify(['a'.repeat(12000)]), '["barcode"]', '[{"stock":5}]',
  '[{"fee":10}]', '{"color":"red"}', body, null, '2026-11-27 00:00:00'];
const stockPayload = (shop = 20, sku = '101', warehouse = 'warehouse-1', type = 'fbp_real', body = largeBody) =>
  [shop, null, null, 'product-' + sku, sku, 'offer-' + sku, warehouse, 'Fixture warehouse', type,
    5, 1, 4, 0, 0, 0, 0, null, null, null, '', body];

test('online product sync omits unchanged TEXT under row locks while retaining observation timestamps and tenant keys', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 60000
}, async t => {
  const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
  const database = 'ozon_sync_write_' + randomBytes(8).toString('hex');
  const admin = await mysql.createConnection({ socketPath, user: 'root', dateStrings: true });
  const connections = new Set(), statements = [];
  let created = false;
  const connect = async () => {
    const connection = await mysql.createConnection({ socketPath, user: 'root', database, dateStrings: true });
    connections.add(connection);
    await connection.query("SET time_zone = '+00:00'");
    await connection.query("SET SESSION binlog_row_image = 'NOBLOB'");
    return connection;
  };
  const query = async (sql, params = []) => (await admin.execute(sql, params))[0];
  const transaction = async operation => {
    const connection = await connect();
    try {
      await connection.beginTransaction();
      const result = await operation({ execute: async (sql, params) => { statements.push(sql); return connection.execute(sql, params); } });
      await connection.commit(); return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connections.delete(connection); await connection.end(); }
  };
  const write = (values, beforeWrite) => writeOnlineProductSync({ transaction, payload: values, beforeWrite });
  const lastUpdate = () => statements.findLast(sql => sql.startsWith('UPDATE online_products'));
  const logPoint = async () => (await admin.query('SHOW BINARY LOG STATUS'))[0][0];
  const updateEventBytes = async (point, tableName = 'online_products') => {
    const logs = (await admin.query('SHOW BINARY LOGS'))[0];
    const selected = logs.slice(logs.findIndex(log => log.Log_name === point.File));
    let bytes = 0;
    const tables = new Set();
    for (const log of selected) {
      assert.match(log.Log_name, /^[a-zA-Z0-9_.-]+$/);
      const start = log.Log_name === point.File ? Number(point.Position) : 4;
      const events = (await admin.query(`SHOW BINLOG EVENTS IN '${log.Log_name}' FROM ${start}`))[0];
      for (const event of events) {
        const table = String(event.Info).match(/table_id: (\d+)/)?.[1];
        if (event.Event_type === 'Table_map' && String(event.Info).includes(`(${database}.${tableName})`)) tables.add(table);
        if (event.Event_type === 'Update_rows' && tables.has(table)) bytes += Number(event.End_log_pos) - Number(event.Pos);
      }
    }
    return bytes;
  };
  try {
    assert.equal(Number((await query('SELECT @@skip_networking isolated'))[0].isolated), 1);
    await admin.query(`CREATE DATABASE \`${database}\``); created = true;
    await admin.changeUser({ database });
    await admin.query("SET time_zone = '+00:00'");
    const schema = readFileSync(new URL('../scripts/init-mysql-schema.mjs', import.meta.url), 'utf8');
    const table = schema.match(/CREATE TABLE IF NOT EXISTS online_products \([\s\S]*?ENGINE=InnoDB[^;]+;/)?.[0];
    assert.ok(table); await admin.query(table);
    const stockTable = schema.match(/CREATE TABLE IF NOT EXISTS ozon_stock_snapshots \([\s\S]*?ENGINE=InnoDB[^;]+;/)?.[0];
    assert.ok(stockTable); await admin.query(stockTable);
    await admin.query('CREATE TABLE write_authority (id BIGINT PRIMARY KEY, allowed TINYINT NOT NULL)');
    await admin.query('INSERT INTO write_authority VALUES(1,1)');

    await t.test('identical JSON is omitted, timestamp refresh survives, and NOBLOB update rows stay small', async () => {
      await write(payload());
      await query("UPDATE online_products SET product_id=777,synced_at='2000-01-01',updated_at='2000-01-01' WHERE shop_id=20 AND ozon_sku='101'");
      const point = await logPoint();
      await write(payload());
      for (const field of ['image_url', 'primary_image', 'images_json', 'barcodes_json', 'stocks_json', 'commissions_json', 'attributes_json', 'raw_json']) {
        assert.doesNotMatch(lastUpdate(), new RegExp(`\\b${field}\\s*=`));
      }
      const [row] = await query("SELECT * FROM online_products WHERE shop_id=20 AND ozon_sku='101'");
      assert.equal(row.raw_json, largeBody); assert.equal(Number(row.product_id), 777);
      assert.notEqual(row.synced_at, '2000-01-01 00:00:00'); assert.notEqual(row.updated_at, '2000-01-01 00:00:00');
      const bytes = await updateEventBytes(point);
      assert.ok(bytes > 0 && bytes < 4096, `unchanged 100KB body produced ${bytes} update-event bytes`);
      t.diagnostic(`unchanged online product NOBLOB update event: ${bytes} bytes`);
    });

    await t.test('a changed raw document is assigned without resending unchanged JSON columns', async () => {
      const point = await logPoint(), next = payload(20, '101', largeBody.replace('isolated-fixture', 'changed-fixture'));
      next[17] = '[{"stock":6}]';
      await write(next);
      assert.match(lastUpdate(), /raw_json\s*=\s*\?/); assert.match(lastUpdate(), /stocks_json\s*=\s*\?/);
      assert.doesNotMatch(lastUpdate(), /images_json\s*=/); assert.doesNotMatch(lastUpdate(), /attributes_json\s*=/);
      const [row] = await query("SELECT raw_json,stocks_json FROM online_products WHERE shop_id=20 AND ozon_sku='101'");
      assert.equal(row.raw_json, next[20]); assert.equal(row.stocks_json, next[17]);
      const bytes = await updateEventBytes(point); assert.ok(bytes > 100 * 1024);
      t.diagnostic(`changed 100KB online product NOBLOB update event: ${bytes} bytes`);
    });

    await t.test('comparison sees the latest locked JSON and preserves a concurrent manual product binding', async () => {
      const blocker = await connect(); await blocker.beginTransaction();
      await blocker.execute("UPDATE online_products SET raw_json='concurrent-json',product_id=12345 WHERE shop_id=20 AND ozon_sku='101'");
      let lockedChecks = 0;
      const saving = write(payload(), async connection => {
        lockedChecks++;
        if (lockedChecks === 2) {
          const [rows] = await connection.execute("SELECT raw_json FROM online_products WHERE shop_id=20 AND ozon_sku='101'");
          assert.equal(rows[0].raw_json, 'concurrent-json');
        }
      });
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(lockedChecks, 1, 'the writer must wait for the competing exclusive lock');
      await blocker.commit(); await saving;
      const [row] = await query("SELECT raw_json,product_id FROM online_products WHERE shop_id=20 AND ozon_sku='101'");
      assert.equal(row.raw_json, largeBody); assert.equal(Number(row.product_id), 12345);
      connections.delete(blocker); await blocker.end();
    });

    await t.test('revocation while waiting rolls back without touching the row or its observation times', async () => {
      const before = await query("SELECT * FROM online_products WHERE shop_id=20 AND ozon_sku='101'");
      const blocker = await connect(); await blocker.beginTransaction();
      await blocker.execute("SELECT id FROM online_products WHERE shop_id=20 AND ozon_sku='101' FOR UPDATE");
      let allowed = true, checks = 0;
      const saving = write(payload(20, '101', 'must-not-save'), async () => {
        checks++; if (!allowed) throw Object.assign(new Error('fixture authority revoked'), { status: 403 });
      });
      const rejected = assert.rejects(saving, /authority revoked/);
      await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(checks, 1);
      allowed = false; await blocker.commit(); await rejected;
      assert.deepEqual(await query("SELECT * FROM online_products WHERE shop_id=20 AND ozon_sku='101'"), before);
      connections.delete(blocker); await blocker.end();
    });

    await t.test('RR authorization reads begin after the row wait and observe a database revocation', async () => {
      const before = await query("SELECT * FROM online_products WHERE shop_id=20 AND ozon_sku='101'");
      const blocker = await connect(); await blocker.beginTransaction();
      await blocker.execute("SELECT id FROM online_products WHERE shop_id=20 AND ozon_sku='101' FOR UPDATE");
      let checks = 0;
      const saving = write(payload(20, '101', 'must-not-save'), async connection => {
        checks++;
        const [rows] = await (connection || admin).execute('SELECT allowed FROM write_authority WHERE id=1');
        if (!Number(rows[0].allowed)) throw Error('fixture database permission revoked');
      });
      const rejected = assert.rejects(saving, /database permission revoked/);
      await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(checks, 1);
      await query('UPDATE write_authority SET allowed=0 WHERE id=1');
      await blocker.commit(); await rejected;
      assert.deepEqual(await query("SELECT * FROM online_products WHERE shop_id=20 AND ozon_sku='101'"), before);
      await query('UPDATE write_authority SET allowed=1 WHERE id=1');
      connections.delete(blocker); await blocker.end();
    });

    await t.test('a denied first insert rolls back and concurrent first inserts retain one coherent row', async () => {
      let checks = 0;
      await assert.rejects(write(payload(20, 'new-denied'), async () => { if (++checks === 2) throw Error('fixture denied after lock'); }), /denied after lock/);
      assert.equal(Number((await query("SELECT COUNT(*) n FROM online_products WHERE ozon_sku='new-denied'"))[0].n), 0);
      const first = payload(20, 'new-race', 'first'), second = payload(20, 'new-race', 'second');
      first[4] = 'first'; second[4] = 'second';
      await Promise.all([write(first), write(second)]);
      const rows = await query("SELECT name,raw_json FROM online_products WHERE shop_id=20 AND ozon_sku='new-race'");
      assert.equal(rows.length, 1); assert.equal(rows[0].name, rows[0].raw_json);
    });

    await t.test('equal SKU values in another shop are untouched and NULL is not confused with an empty document', async () => {
      await write(payload(30, '101', 'foreign-row'));
      const foreign = await query('SELECT * FROM online_products WHERE shop_id=30');
      await query("UPDATE online_products SET images_json=NULL,raw_json=NULL WHERE shop_id=20 AND ozon_sku='101'");
      const next = payload(); next[15] = ''; next[20] = '';
      await write(next);
      assert.match(lastUpdate(), /images_json\s*=/); assert.match(lastUpdate(), /raw_json\s*=/);
      const [row] = await query("SELECT images_json,raw_json FROM online_products WHERE shop_id=20 AND ozon_sku='101'");
      assert.equal(row.images_json, ''); assert.equal(row.raw_json, '');
      assert.deepEqual(await query('SELECT * FROM online_products WHERE shop_id=30'), foreign);
    });

    await t.test('stock upserts omit identical raw JSON, refresh observations and preserve the complete natural key', async () => {
      const save = values => writeStockSnapshotSync({ transaction, payload: values });
      await save(stockPayload()); await save(stockPayload(30));
      await save(stockPayload(20, '101', 'warehouse-2')); await save(stockPayload(20, '101', 'warehouse-1', 'fbs_virtual'));
      const protectedRows = await query("SELECT * FROM ozon_stock_snapshots WHERE NOT(shop_id=20 AND ozon_sku='101' AND warehouse_id='warehouse-1' AND stock_type='fbp_real') ORDER BY id");
      await query("UPDATE ozon_stock_snapshots SET synced_at='2000-01-01' WHERE shop_id=20 AND warehouse_id='warehouse-1' AND stock_type='fbp_real'");
      const point = await logPoint(); await save(stockPayload());
      const update = statements.findLast(sql => sql.startsWith('UPDATE ozon_stock_snapshots'));
      assert.doesNotMatch(update, /raw_json\s*=/);
      const [row] = await query("SELECT * FROM ozon_stock_snapshots WHERE shop_id=20 AND warehouse_id='warehouse-1' AND stock_type='fbp_real'");
      assert.equal(row.raw_json, largeBody); assert.notEqual(row.synced_at, '2000-01-01 00:00:00');
      const bytes = await updateEventBytes(point, 'ozon_stock_snapshots');
      assert.ok(bytes > 0 && bytes < 4096, `unchanged stock 100KB JSON produced ${bytes} update-event bytes`);
      t.diagnostic(`unchanged stock snapshot NOBLOB update event: ${bytes} bytes`);
      const next = stockPayload(20, '101', 'warehouse-1', 'fbp_real', '{"changed":true}'); next[11] = 3;
      await save(next);
      assert.match(statements.findLast(sql => sql.startsWith('UPDATE ozon_stock_snapshots')), /raw_json\s*=/);
      const [changed] = await query("SELECT raw_json,available FROM ozon_stock_snapshots WHERE shop_id=20 AND warehouse_id='warehouse-1' AND stock_type='fbp_real'");
      assert.equal(changed.raw_json, next[20]); assert.equal(Number(changed.available), 3);
      assert.deepEqual(await query("SELECT * FROM ozon_stock_snapshots WHERE NOT(shop_id=20 AND ozon_sku='101' AND warehouse_id='warehouse-1' AND stock_type='fbp_real') ORDER BY id"), protectedRows);
    });

    await t.test('concurrent first stock upserts and denied writes retain coherent snapshots', async () => {
      const save = (values, beforeWrite) => writeStockSnapshotSync({ transaction, payload: values, beforeWrite });
      const first = stockPayload(20, 'race-stock', 'warehouse', 'fbp_real', 'first'), second = stockPayload(20, 'race-stock', 'warehouse', 'fbp_real', 'second');
      first[9] = 10; second[9] = 20;
      await Promise.all([save(first), save(second)]);
      const rows = await query("SELECT raw_json,present FROM ozon_stock_snapshots WHERE ozon_sku='race-stock'");
      assert.equal(rows.length, 1); assert.equal(Number(rows[0].present), rows[0].raw_json === 'first' ? 10 : 20);
      let checks = 0;
      await assert.rejects(save(stockPayload(20, 'denied-stock'), async () => { if (++checks === 2) throw Error('fixture denied stock'); }), /denied stock/);
      assert.equal(Number((await query("SELECT COUNT(*) n FROM ozon_stock_snapshots WHERE ozon_sku='denied-stock'"))[0].n), 0);
    });
  } finally {
    for (const connection of connections) await connection.end().catch(() => {});
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
