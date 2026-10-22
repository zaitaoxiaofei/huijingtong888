import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { inspectReviewedUniqueRepair, applyReviewedUniqueRepair, rollbackReviewedUniqueRepair, inspectUniqueRepairJournal } from '../scripts/lib/reviewed-unique-index-repair.mjs';

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
async function fixture(run) {
  const db = await mysql.createConnection({ socketPath, user: 'root', multipleStatements: true, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true });
  const database = `ozon_unique_test_${randomBytes(8).toString('hex')}`;
  let created = false;
  try {
    const [[server]] = await db.query('SELECT @@skip_networking AS disabled');
    assert.equal(Number(server.disabled), 1);
    await db.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); created = true;
    await db.changeUser({ database });
    await db.query("SET SESSION time_zone='+00:00'"); await db.query('SET SESSION max_execution_time=10000');
    // The source corruption is represented by NONUNIQUE versions of the three
    // exact keys, just like the full-row recovery clone. InnoDB correctly
    // refuses inserting these duplicates into a healthy UNIQUE key.
    await db.query(`
      CREATE TABLE tenants(id BIGINT UNSIGNED PRIMARY KEY,slug VARCHAR(64) UNIQUE) ENGINE=InnoDB;
      INSERT INTO tenants VALUES(1,'default'),(2,'customer-a'),(3,'customer-b');
      CREATE TABLE shops(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED NULL) ENGINE=InnoDB;
      INSERT INTO shops VALUES(10,NULL),(20,2),(30,3);
      CREATE TABLE products(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED NULL) ENGINE=InnoDB;
      INSERT INTO products VALUES(100,NULL),(200,2),(300,3);
      CREATE TABLE orders(id BIGINT UNSIGNED PRIMARY KEY,shop_id BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB;
      INSERT INTO orders VALUES(1000,10),(2000,20),(3000,30);
      CREATE TABLE order_items(id BIGINT UNSIGNED PRIMARY KEY,order_id BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB;
      INSERT INTO order_items VALUES(10001,1000);
      CREATE TABLE online_products(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,shop_id BIGINT UNSIGNED NOT NULL,ozon_sku VARCHAR(128) NOT NULL,
        ozon_product_id VARCHAR(128),product_id BIGINT UNSIGNED NULL,status VARCHAR(32),raw_json LONGTEXT,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY uk_online_products_shop_sku(shop_id,ozon_sku)) ENGINE=InnoDB;
      INSERT INTO online_products(id,shop_id,ozon_sku,ozon_product_id,product_id,status,raw_json,updated_at) VALUES
        (11,10,'PRIVATE-SKU','EXT-A',100,'historical','{"title":"old"}','2025-01-01'),
        (12,10,'PRIVATE-SKU','EXT-A',100,'ready','{"title":"new"}','2025-01-02'),
        (21,20,'PRIVATE-SKU','EXT-B',200,'ready','{}','2025-01-01');
      CREATE TABLE order_status_history(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,order_id BIGINT UNSIGNED NOT NULL,shop_id BIGINT UNSIGNED NOT NULL,
        observed_hour DATETIME NOT NULL,status VARCHAR(64) NOT NULL,logistics_status VARCHAR(64) NOT NULL,tracking_stage VARCHAR(64) NOT NULL,sync_state VARCHAR(32) NOT NULL,
        raw_status_json LONGTEXT,KEY uk_order_status_history_hour_state(order_id,observed_hour,status,logistics_status,tracking_stage,sync_state)) ENGINE=InnoDB;
      INSERT INTO order_status_history VALUES(31,1000,10,'2025-01-01','delivered','','','synced','{"event":1}'),(32,1000,10,'2025-01-01','delivered','','','synced','{"event":2}');
      CREATE TABLE ozon_category_mappings(id BIGINT AUTO_INCREMENT PRIMARY KEY,description_category_id BIGINT NOT NULL,type_id BIGINT NOT NULL,
        name_ru VARCHAR(500) NOT NULL,name_zh VARCHAR(500),status VARCHAR(32),is_auto TINYINT,raw_json LONGTEXT,source_shop_id BIGINT NULL,
        UNIQUE KEY other_unique(id),KEY uq_ozon_category_mapping(description_category_id,type_id)) ENGINE=InnoDB;
      INSERT INTO ozon_category_mappings VALUES(41,100,101,'name','old','inactive',1,'{}',10),(42,100,101,'name','current','active',0,'{"official":true}',20);
      CREATE TABLE online_product_actions(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED NOT NULL,shop_id BIGINT UNSIGNED NOT NULL,tenant_id VARCHAR(64),request_json LONGTEXT) ENGINE=InnoDB;
      INSERT INTO online_product_actions VALUES(1,11,10,'admin','{"online_product_id":11}');
      CREATE TABLE outbound_records(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,product_id BIGINT UNSIGNED,
        order_item_id BIGINT UNSIGNED,quantity INT,ozon_sku VARCHAR(128)) ENGINE=InnoDB;
      INSERT INTO outbound_records VALUES(2,11,10,100,10001,2,'PRIVATE-SKU');
      CREATE TABLE ozon_stock_snapshots(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,product_id BIGINT UNSIGNED,
        ozon_sku VARCHAR(128),warehouse_id BIGINT,stock_type VARCHAR(32),UNIQUE KEY stock_key(shop_id,ozon_sku,warehouse_id,stock_type)) ENGINE=InnoDB;
      INSERT INTO ozon_stock_snapshots VALUES(3,11,10,100,'PRIVATE-SKU',99,'fbs');
      CREATE TABLE product_barcode_label_cache(online_product_id BIGINT UNSIGNED PRIMARY KEY,shop_id BIGINT UNSIGNED,label_pdf LONGBLOB NOT NULL,ozon_product_id VARCHAR(128)) ENGINE=InnoDB;
      INSERT INTO product_barcode_label_cache VALUES(11,10,UNHEX('000102FF'),'EXT-A'),(12,10,UNHEX('ABCDEF'),'EXT-A');
      CREATE TABLE sku_inventory_recipes(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,ozon_sku VARCHAR(128),UNIQUE KEY recipe_key(shop_id,ozon_sku)) ENGINE=InnoDB;
      INSERT INTO sku_inventory_recipes VALUES(4,11,10,'PRIVATE-SKU');
      CREATE TABLE sku_mappings(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,tenant_id BIGINT UNSIGNED NULL,product_id BIGINT UNSIGNED,ozon_sku VARCHAR(128),active TINYINT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE KEY mapping_key(shop_id,ozon_sku)) ENGINE=InnoDB;
      INSERT INTO sku_mappings VALUES(5,11,10,NULL,100,'PRIVATE-SKU',1,'2025-01-01');
      CREATE TABLE inventory_product_requests(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED NULL,product_id BIGINT UNSIGNED NULL,payload_json LONGTEXT NOT NULL,status VARCHAR(32),binding_status VARCHAR(32),updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB;
      INSERT INTO inventory_product_requests VALUES(6,NULL,100,'{ "online_product_id":11, "shop_id":10, "unchanged":"evidence" }','approved','pending','2025-01-01');
    `);
    await run({ db, database, query: async (text, args = []) => (await db.query(text, args))[0] });
  } finally { if (created) await db.query(`DROP DATABASE \`${database}\``); await db.end(); }
}
function plan(tables = ['online_products', 'order_status_history', 'ozon_category_mappings']) {
  const groups = { online_products: { row_ids: [11,12], keeper_id: 12 }, order_status_history: { row_ids: [31,32], keeper_id: 31 }, ozon_category_mappings: { row_ids: [41,42], keeper_id: 42 } };
  return { version: 1, repair_id: randomBytes(6).toString('hex'), tables: tables.map(table => ({ table, groups: [groups[table]] })), reviewed_by: 'isolated-test-reviewer', reason: 'Reviewed historical duplicate fixture', maintenance_confirmed: true, rollback_restores_nonunique_schema: true, invalidate_barcode_cache: true, preserve_historical_json: true };
}
async function reviewed(db, value = plan()) {
  const report = await inspectReviewedUniqueRepair(db, value);
  value.expected_reference_digest = report.expected_reference_digest;
  for (const entry of value.tables) for (let n = 0; n < entry.groups.length; n++) {
    const group = report.tables.find(row => row.table === entry.table).groups[n];
    entry.groups[n].expected_hashes = group.expected_hashes;
    entry.groups[n].accepted_differing_columns = group.differing_columns;
  }
  return value;
}
const options = { skip: !socketPath };

test('read-only repair audit emits IDs/hashes only, has no DDL/DML and recommends live/active keepers', options, async () => fixture(async ({ db, query }) => {
  const before = await query('SHOW TABLES');
  await db.query('START TRANSACTION READ ONLY');
  const report = await inspectReviewedUniqueRepair(db, plan());
  await db.rollback();
  assert.deepEqual(await query('SHOW TABLES'), before);
  assert.equal(report.changes_database, false);
  assert.equal(report.tables[0].groups[0].recommended_keeper_id, '12');
  assert.equal(report.tables[2].groups[0].recommended_keeper_id, '42');
  assert.equal(report.references.length, 7);
  assert.equal(report.conflicts.length, 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-SKU|EXT-A|"official"|"unchanged"/);
}));

test('three-table apply preserves every original row/full BLOB and remaps only audited live references; guarded undo restores data', options, async () => fixture(async ({ db, query, database }) => {
  const value = await reviewed(db);
  const baseline = {};
  for (const table of ['online_products','order_status_history','ozon_category_mappings','online_product_actions','outbound_records','ozon_stock_snapshots','product_barcode_label_cache','sku_inventory_recipes','sku_mappings','inventory_product_requests']) baseline[table] = await query(`SELECT * FROM ${table} FORCE INDEX(PRIMARY) ORDER BY 1`);
  const result = await applyReviewedUniqueRepair(db, value, database);
  assert.equal(result.phase, 'applied');
  for (const target of result.rows_archived) {
    assert.deepEqual(await query(`SELECT * FROM \`${target.archive}\` FORCE INDEX(PRIMARY) ORDER BY 1`), baseline[target.table]);
    const indexes = await query('SELECT NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?', [target.archive, { online_products:'uk_online_products_shop_sku',order_status_history:'uk_order_status_history_hour_state',ozon_category_mappings:'uq_ozon_category_mapping' }[target.table]]);
    assert.ok(indexes.every(row => Number(row.NON_UNIQUE) === 1), 'archive itself must be dump/restorable');
  }
  assert.deepEqual((await query('SELECT id FROM online_products ORDER BY id')).map(row => Number(row.id)), [12,21]);
  for (const table of ['online_product_actions','outbound_records','ozon_stock_snapshots','sku_inventory_recipes','sku_mappings']) assert.equal(Number((await query(`SELECT online_product_id FROM ${table}`))[0].online_product_id), 12);
  const [request] = await query('SELECT payload_json,updated_at FROM inventory_product_requests');
  assert.equal(JSON.parse(request.payload_json).online_product_id, 12);
  assert.equal(request.updated_at, baseline.inventory_product_requests[0].updated_at);
  assert.equal((await query('SELECT * FROM product_barcode_label_cache')).length, 0);
  assert.equal((await query('SELECT request_json FROM online_product_actions'))[0].request_json, baseline.online_product_actions[0].request_json, 'historical JSON evidence is unchanged');
  await assert.rejects(query("INSERT INTO online_products(id,shop_id,ozon_sku) VALUES(99,10,'PRIVATE-SKU')"), { code: 'ER_DUP_ENTRY' });
  // Failed inserts may advance AUTO_INCREMENT, but no row data changed.
  const undone = await rollbackReviewedUniqueRepair(db, value.repair_id, database, true);
  assert.equal(undone.schema_exact, false);
  for (const [table, rows] of Object.entries(baseline)) assert.deepEqual(await query(`SELECT * FROM ${table} FORCE INDEX(PRIMARY) ORDER BY 1`), rows, table);
}));

test('apply rejects changed row hashes/reference hashes before creating any repair artifacts', options, async () => fixture(async ({ db, query, database }) => {
  let value = await reviewed(db, plan(['online_products']));
  await query("UPDATE online_products SET raw_json='changed' WHERE id=11");
  await assert.rejects(applyReviewedUniqueRepair(db, value, database), /fingerprint/);
  value = await reviewed(db, plan(['online_products']));
  await query('UPDATE outbound_records SET quantity=3 WHERE id=2');
  await assert.rejects(applyReviewedUniqueRepair(db, value, database), /Reference rows changed/);
  assert.equal((await query("SHOW TABLES LIKE '\\_uir\\_%'")).length, 0);
}));

test('cross-enterprise NULL ownership, typed shop and request JSON ownership fail closed', options, async () => fixture(async ({ db, query }) => {
  await query('UPDATE sku_mappings SET tenant_id=2 WHERE id=5');
  await assert.rejects(inspectReviewedUniqueRepair(db, plan(['online_products'])), /crosses enterprises/);
  await query('UPDATE sku_mappings SET tenant_id=NULL WHERE id=5');
  await query('UPDATE outbound_records SET shop_id=20 WHERE id=2');
  await assert.rejects(inspectReviewedUniqueRepair(db, plan(['online_products'])), /crosses shops/);
  await query('UPDATE outbound_records SET shop_id=10 WHERE id=2');
  await query('UPDATE inventory_product_requests SET tenant_id=2 WHERE id=6');
  await assert.rejects(inspectReviewedUniqueRepair(db, plan(['online_products'])), /crosses enterprises/);
}));

test('different referenced Ozon identity or product binding refuses automatic merge without deleting originals', options, async () => fixture(async ({ db, query, database }) => {
  await query("UPDATE online_products SET ozon_product_id='OTHER',product_id=NULL WHERE id=11");
  const value = await reviewed(db, plan(['online_products']));
  const report = await inspectReviewedUniqueRepair(db, value);
  assert.ok(report.conflicts.some(row => row.reason.includes('ozon_product_id')));
  await assert.rejects(applyReviewedUniqueRepair(db, value, database), /Ambiguous product/);
  assert.equal((await query('SELECT id FROM online_products FORCE INDEX(PRIMARY)')).length, 3);
}));

test('unreviewed third duplicate causes strict shadow UNIQUE failure with zero source/reference mutation', options, async () => fixture(async ({ db, query, database }) => {
  await query("INSERT INTO online_products(id,shop_id,ozon_sku,ozon_product_id,product_id,status) VALUES(13,10,'PRIVATE-SKU','EXT-A',100,'historical')");
  const value = await reviewed(db, plan(['online_products']));
  await assert.rejects(applyReviewedUniqueRepair(db, value, database), { code: 'ER_DUP_ENTRY' });
  assert.equal(Number((await query('SELECT online_product_id FROM sku_mappings'))[0].online_product_id), 11);
  assert.equal((await query('SELECT id FROM online_products FORCE INDEX(PRIMARY)')).length, 4);
  assert.equal((await inspectUniqueRepairJournal(db, value.repair_id)).phase, 'preparing');
  assert.equal((await rollbackReviewedUniqueRepair(db, value.repair_id, database, true)).phase, 'rolled_back');
}));

test('reference DML failure rolls back the entire remap/cache/snapshot transaction', options, async () => fixture(async ({ db, query, database }) => {
  await query('ALTER TABLE sku_mappings ADD CONSTRAINT cannot_use_keeper CHECK(online_product_id<>12)');
  const value = await reviewed(db, plan(['online_products']));
  await assert.rejects(applyReviewedUniqueRepair(db, value, database), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  for (const table of ['online_product_actions','outbound_records','ozon_stock_snapshots','sku_inventory_recipes','sku_mappings']) assert.equal(Number((await query(`SELECT online_product_id FROM ${table}`))[0].online_product_id), 11);
  assert.equal((await query('SELECT * FROM product_barcode_label_cache')).length, 2);
  assert.equal((await inspectUniqueRepairJournal(db, value.repair_id)).phase, 'preparing');
  await rollbackReviewedUniqueRepair(db, value.repair_id, database, true);
}));

test('undo refuses both later reference writes and later canonical writes; no overwrite', options, async () => fixture(async ({ db, query, database }) => {
  const value = await reviewed(db, plan(['online_products']));
  await applyReviewedUniqueRepair(db, value, database);
  await query('UPDATE outbound_records SET quantity=9 WHERE id=2');
  await assert.rejects(rollbackReviewedUniqueRepair(db, value.repair_id, database, true), /Reference rows or archives changed/);
  await query('UPDATE outbound_records SET quantity=2 WHERE id=2');
  await query("UPDATE online_products SET raw_json='later' WHERE id=12");
  await assert.rejects(rollbackReviewedUniqueRepair(db, value.repair_id, database, true), /Current table changed/);
  assert.equal((await query('SELECT raw_json FROM online_products WHERE id=12'))[0].raw_json, 'later');
}));

test('unknown typed refs, foreign keys and triggers require separate review', options, async () => fixture(async ({ db, query }) => {
  await query('CREATE TABLE unknown_refs(id BIGINT PRIMARY KEY,online_product_id BIGINT) ENGINE=InnoDB');
  await assert.rejects(inspectReviewedUniqueRepair(db, plan(['online_products'])), /unaudited typed/);
  await query('DROP TABLE unknown_refs');
  await query('CREATE TABLE unknown_history(id BIGINT PRIMARY KEY,order_status_history_id BIGINT) ENGINE=InnoDB');
  await assert.rejects(inspectReviewedUniqueRepair(db, plan(['order_status_history'])), /unaudited history/);
  await query('DROP TABLE unknown_history');
  await query('CREATE TRIGGER repair_test BEFORE UPDATE ON sku_mappings FOR EACH ROW SET NEW.active=NEW.active');
  await assert.rejects(inspectReviewedUniqueRepair(db, plan(['online_products'])), /Triggers or foreign keys/);
}));

test('explicit active category keeper required; no latest-time/is_auto inference', options, async () => fixture(async ({ db, database }) => {
  const value = plan(['ozon_category_mappings']); value.tables[0].groups[0].keeper_id = 41;
  await reviewed(db, value);
  await assert.rejects(applyReviewedUniqueRepair(db, value, database), /keeper must be active/);
}));

test('keeper cannot discard the only valid binding/Ozon identity even when reviewed and newer', options, async () => fixture(async ({ db, query, database }) => {
  await query('UPDATE online_products SET product_id=NULL,ozon_product_id=NULL WHERE id=12');
  const value = await reviewed(db, plan(['online_products']));
  const report = await inspectReviewedUniqueRepair(db, value);
  assert.equal(report.tables[0].groups[0].recommended_keeper_id, '11');
  assert.deepEqual(report.tables[0].groups[0].identity_preserving_keeper_ids, ['11']);
  await assert.rejects(applyReviewedUniqueRepair(db, value, database), /discard a valid/);
}));

test('maintenance, whitelist, precision-safe IDs, reviewed keeper and database guards are mandatory', options, async () => fixture(async ({ db, database }) => {
  const value = await reviewed(db, plan(['online_products']));
  await assert.rejects(applyReviewedUniqueRepair(db, { ...value, maintenance_confirmed: false }, database), /maintenance/);
  await assert.rejects(applyReviewedUniqueRepair(db, value, 'unrelated_database'), /database mismatch/);
  await assert.rejects(inspectReviewedUniqueRepair(db, { ...value, tables:[{table:'people',groups:[{row_ids:[1,2]}]}] }), /three documented/);
  await assert.rejects(inspectReviewedUniqueRepair(db, { ...value, tables:[{table:'online_products',groups:[{row_ids:['11 OR 1=1',12]}]}] }), /Invalid positive/);
  await assert.rejects(rollbackReviewedUniqueRepair(db, value.repair_id, database, false), /confirmed maintenance/);
  await db.query('SET SESSION unique_checks=0');
  await assert.rejects(applyReviewedUniqueRepair(db, value, database), /unique_checks must be 1/);
  await db.query('SET SESSION unique_checks=1');
}));

test('crash after reference COMMIT is recoverable without a table swap or lost cache rows', options, async () => fixture(async ({ db, query, database }) => {
  const value = await reviewed(db, plan(['online_products']));
  const wrapped = { query: db.query.bind(db), beginTransaction: db.beginTransaction.bind(db), rollback: db.rollback.bind(db), commit: async () => { await db.commit(); throw new Error('simulated disconnect after COMMIT'); } };
  await assert.rejects(applyReviewedUniqueRepair(wrapped, value, database), /simulated disconnect/);
  assert.equal((await inspectUniqueRepairJournal(db, value.repair_id)).phase, 'references_applied');
  assert.equal(Number((await query('SELECT online_product_id FROM sku_mappings'))[0].online_product_id), 12);
  await rollbackReviewedUniqueRepair(db, value.repair_id, database, true);
  assert.equal(Number((await query('SELECT online_product_id FROM sku_mappings'))[0].online_product_id), 11);
  assert.equal((await query('SELECT * FROM product_barcode_label_cache')).length, 2);
}));

test('crash after atomic RENAME and after rollback RENAME can both resume from journal/table identities', options, async () => fixture(async ({ db, query, database }) => {
  const value = await reviewed(db, plan(['online_products']));
  const wrapped = { query: async (text, args) => {
    if (text.startsWith('UPDATE `_reviewed_unique_index_repairs`') && args?.[0] === 'applied') throw new Error('simulated disconnect after RENAME');
    return db.query(text, args);
  }, beginTransaction: db.beginTransaction.bind(db), rollback: db.rollback.bind(db), commit: db.commit.bind(db) };
  await assert.rejects(applyReviewedUniqueRepair(wrapped, value, database), /simulated disconnect after RENAME/);
  assert.equal((await inspectUniqueRepairJournal(db, value.repair_id)).phase, 'swap_pending');
  assert.equal((await query('SELECT id FROM online_products WHERE id=11')).length, 0);
  const undoWrapped = { ...wrapped, query: db.query.bind(db), beginTransaction: async () => { throw new Error('simulated disconnect after undo RENAME'); } };
  await assert.rejects(rollbackReviewedUniqueRepair(undoWrapped, value.repair_id, database, true), /simulated disconnect after undo/);
  assert.equal((await inspectUniqueRepairJournal(db, value.repair_id)).phase, 'rollback_swap_pending');
  assert.equal((await query('SELECT id FROM online_products WHERE id=11')).length, 1);
  await rollbackReviewedUniqueRepair(db, value.repair_id, database, true);
  assert.equal(Number((await query('SELECT online_product_id FROM sku_mappings'))[0].online_product_id), 11);
  assert.equal((await query('SELECT * FROM product_barcode_label_cache')).length, 2);
}));

test('full-row archive hashes include signed negative/zero category primary IDs', options, async () => fixture(async ({ db, query, database }) => {
  await query("INSERT INTO ozon_category_mappings(id,description_category_id,type_id,name_ru,status) VALUES(-5,500,501,'negative','active')");
  const value = await reviewed(db, plan(['ozon_category_mappings']));
  const result = await applyReviewedUniqueRepair(db, value, database);
  assert.equal(result.rows_archived[0].original_rows, 3);
  await query("UPDATE ozon_category_mappings SET name_ru='changed' WHERE id=-5");
  await assert.rejects(rollbackReviewedUniqueRepair(db, value.repair_id, database, true), /Current table changed/);
}));
