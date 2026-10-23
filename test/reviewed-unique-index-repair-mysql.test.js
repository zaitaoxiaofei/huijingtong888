import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectReviewedUniqueRepair, applyReviewedUniqueRepair, rollbackReviewedUniqueRepair, inspectUniqueRepairJournal } from '../scripts/lib/reviewed-unique-index-repair.mjs';

import { socketPath, fixture, plan, reviewed, unchangedOutboundFixture } from './helpers/reviewed-unique-fixture.js';
const options = { skip: !socketPath };

test('a foreign key declared in another schema blocks reviewed unique repair before any writes', options, async () => fixture(async ({ db, database, query }) => {
  const foreignDatabase = `${database}_fk`;
  try {
    await query(`CREATE DATABASE \`${foreignDatabase}\``);
    await query(`CREATE TABLE \`${foreignDatabase}\`.external_child (id BIGINT PRIMARY KEY, remote_id BIGINT UNSIGNED,
      FOREIGN KEY(remote_id) REFERENCES \`${database}\`.online_products(id)) ENGINE=InnoDB`);
    await assert.rejects(inspectReviewedUniqueRepair(db, plan(['online_products'])), /Triggers or foreign keys/);
    assert.equal((await query("SHOW TABLES LIKE '\\_uir\\_%'")).length, 0);
  } finally { await query(`DROP DATABASE IF EXISTS \`${foreignDatabase}\``); }
}));

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

test('one explicitly approved unresolved outbound row retains every native field and old parent across strict apply and undo', options, async () => fixture(async ({ db, query, database }) => {
  const exception = await unchangedOutboundFixture(query), value = plan(['online_products']);
  const original = await query('SELECT * FROM outbound_records FORCE INDEX(PRIMARY) ORDER BY id');
  await assert.rejects(inspectReviewedUniqueRepair(db, value), /Outbound reference and order-item ownership disagree/);
  value.unchanged_outbound_reference = exception;
  await reviewed(db, value);
  const result = await applyReviewedUniqueRepair(db, value, database), proof = result.unchanged_outbound_reference;
  assert.equal(proof.byte_unchanged, true); assert.equal(proof.relationship_reconciled, false);
  assert.equal(proof.full_row_sha256, exception.expected_full_row_sha256);
  assert.deepEqual(proof.before_digest, proof.after_digest);
  assert.equal(proof.before_digest.count, 1);
  assert.deepEqual(await query('SELECT * FROM outbound_records FORCE INDEX(PRIMARY) ORDER BY id'), original);
  const state = await inspectUniqueRepairJournal(db, value.repair_id);
  assert.deepEqual(state.unchanged_outbound_reference, proof);
  await rollbackReviewedUniqueRepair(db, value.repair_id, database, true);
  assert.deepEqual(await query('SELECT * FROM outbound_records FORCE INDEX(PRIMARY) ORDER BY id'), original);
}));

test('unchanged outbound approval is one exact complete object and cannot whitelist another row or missing confirmation', options, async () => fixture(async ({ db, query }) => {
  const exception = await unchangedOutboundFixture(query), value = { ...plan(['online_products']), unchanged_outbound_reference: exception };
  for (const override of [null, [exception], { ...exception, table: 'sku_mappings' }, { ...exception, reason: '' }, { ...exception, user_confirmation_reference: '' },
    { ...exception, row_id: 9007199254740992 }, { ...exception, row_id: ['2'] }, { ...exception, extra_row_ids: ['3'] }, { ...exception, online_product_id: '11' },
    { ...exception, row_id: '999' }, { ...exception, order_item_id: '999' }, { ...exception, expected_parent_shop_id: '20' }, { ...exception, expected_full_row_sha256: 'a'.repeat(64) }]) {
    await assert.rejects(inspectReviewedUniqueRepair(db, { ...value, unchanged_outbound_reference: override }));
  }
  await assert.rejects(inspectReviewedUniqueRepair(db, { ...value, unchanged_outbound_references: [exception] }), /never an exception list/);
  await query('INSERT INTO outbound_records(id,online_product_id,shop_id,product_id,order_item_id,quantity) VALUES(3,12,10,100,11001,1)');
  await assert.rejects(inspectReviewedUniqueRepair(db, value), /Outbound reference and order-item ownership disagree/);
  assert.equal((await query("SHOW TABLES LIKE '\\_uir\\_%'")).length, 0);
}));

test('unchanged outbound exception keeps tenant, product, current parent and full native fingerprint guards', options, async () => fixture(async ({ db, query }) => {
  const exception = await unchangedOutboundFixture(query), value = { ...plan(['online_products']), unchanged_outbound_reference: exception };
  await query('UPDATE shops SET tenant_id=2 WHERE id=11');
  await assert.rejects(inspectReviewedUniqueRepair(db, value), /old parent crosses enterprises/);
  await query('UPDATE shops SET tenant_id=NULL WHERE id=11');
  await query('UPDATE shops SET tenant_id=2 WHERE id=10');
  await assert.rejects(inspectReviewedUniqueRepair(db, value), /preservation crosses enterprises/);
  await query('UPDATE shops SET tenant_id=NULL WHERE id=10');
  await query('INSERT INTO orders(id,shop_id) VALUES(1101,11); UPDATE order_items SET order_id=1101 WHERE id=11001');
  await assert.rejects(inspectReviewedUniqueRepair(db, value), /old parent is missing or changed/);
  await query('UPDATE order_items SET order_id=1100 WHERE id=11001');
  await query('UPDATE orders SET shop_id=10 WHERE id=1100');
  await assert.rejects(inspectReviewedUniqueRepair(db, value), /old parent is missing or changed/);
  await query('UPDATE orders SET shop_id=11 WHERE id=1100');
  await query('DELETE FROM order_items WHERE id=11001');
  await assert.rejects(inspectReviewedUniqueRepair(db, value), /old parent is missing or changed/);
  await query('INSERT INTO order_items(id,order_id) VALUES(11001,1100)');
  await query('UPDATE products SET tenant_id=2 WHERE id=100');
  await assert.rejects(inspectReviewedUniqueRepair(db, value), /product binding crosses/);
  await query('UPDATE products SET tenant_id=NULL WHERE id=100');
  await query("UPDATE outbound_records SET evidence_blob=UNHEX('0000FFABCD00') WHERE id=2");
  await assert.rejects(inspectReviewedUniqueRepair(db, value), /native row hash changed/);
}));
