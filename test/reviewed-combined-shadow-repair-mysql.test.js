import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { inspectReviewedUniqueRepair, rollbackReviewedUniqueRepair } from '../scripts/lib/reviewed-unique-index-repair.mjs';
import { apply as applyLinks, inspect as inspectLinks } from '../scripts/lib/reviewed-legacy-link-corrections.mjs';
import { COMBINED_SCOPE, captureCombinedSource, inspectCombined, prepareCombined, installCombined, rollbackCombined, inspectCombinedJournal, parseCombinedArguments, nativeDigest } from '../scripts/lib/reviewed-combined-shadow-repair.mjs';

import { socketPath, fixture, unchangedOutboundFixture } from './helpers/reviewed-unique-fixture.js';
const q = value => '`' + String(value).replaceAll('`', '``') + '`';
const space = { freeSpace: async () => 100n * 1024n ** 3n };
const equalSnapshots = (a, b) => assert.deepEqual(a.map(({ table, count, sha256 }) => ({ table, count, sha256 })), b.map(({ table, count, sha256 }) => ({ table, count, sha256 })));
async function scenario(action, { generatedParent = false, preserveOutbound = false } = {}) {
  await fixture(async ({ db, database, query }) => {
    const outer = randomBytes(6).toString('hex'), stage = `_uir_stage_${outer}`, review = `_uir_review_${outer}`;
    try {
      await query("ALTER TABLE shops ADD status VARCHAR(32) DEFAULT 'active'; ALTER TABLE products ADD active TINYINT DEFAULT 1; ALTER TABLE orders ADD posting_number VARCHAR(128); UPDATE orders SET posting_number=CONCAT('post-',id)");
      await query("ALTER TABLE order_status_history ADD posting_number VARCHAR(128); UPDATE order_status_history SET posting_number='post-1000'; UPDATE order_status_history SET order_id=2000 WHERE id=31");
      await query("ALTER TABLE outbound_records ADD order_ref VARCHAR(128); UPDATE outbound_records SET order_ref='post-1000'; ALTER TABLE order_items ADD ozon_sku VARCHAR(128),ADD quantity INT; UPDATE order_items SET ozon_sku='PRIVATE-SKU',quantity=1; INSERT INTO order_items VALUES(10002,1000,'PRIVATE-SKU',2)");
      await query("UPDATE online_products SET ozon_product_id='100001' WHERE shop_id=10; UPDATE product_barcode_label_cache SET ozon_product_id='100001'; UPDATE online_products SET product_id=200,ozon_product_id='WRONG' WHERE id=11");
      if (generatedParent) await query('ALTER TABLE products ADD fixture_stored TINYINT GENERATED ALWAYS AS (active=1) STORED');
      const unchangedOutbound = preserveOutbound ? await unchangedOutboundFixture(query) : null;
      const before = await captureCombinedSource(db, database);
      const plan = { version: 1, source_kind: 'isolated_fixture', repair_id: outer, reviewed_by: 'Isolated test reviewer', reason: 'Combine reviewed exact parent/identity correction with strict reconstruction', maintenance_confirmed: true, rollback_restores_nonunique_schema: true,
        source_database: database, stage_database: stage, source_snapshots: before,
        link_plan: { version: 1, repair_id: randomBytes(6).toString('hex'), reviewed_by: 'Isolated test reviewer', reason: 'Reviewed fixture parent and external identity', maintenance_confirmed: true, changes: [] },
        unique_plan: { version: 1, repair_id: randomBytes(6).toString('hex'), reviewed_by: 'Isolated test reviewer', reason: 'Reviewed fixture exact key keepers', maintenance_confirmed: true, rollback_restores_nonunique_schema: true, invalidate_barcode_cache: true, preserve_historical_json: true,
          tables: [{ table: 'online_products', groups: [{ row_ids: [11, 12], keeper_id: 12 }] }, { table: 'order_status_history', groups: [{ row_ids: [31, 32], keeper_id: 31 }] }, { table: 'ozon_category_mappings', groups: [{ row_ids: [41, 42], keeper_id: 42 }] }] }
      };
      if (unchangedOutbound) plan.unique_plan.unchanged_outbound_reference = unchangedOutbound;
      const rowHash = meta => `SHA2(CONCAT(${meta.columns.map(column => `IF(${q(column)} IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(${q(column)} AS BINARY)),':',HEX(CAST(${q(column)} AS BINARY))))`).join(',')}),256)`;
      for (const change of [
        { table: 'online_products', id: '11', fields: { product_id: { before: '200', after: '100' }, ozon_product_id: { before: 'WRONG', after: '100001' } }, official_evidence_sha256: 'a'.repeat(64), user_confirmation_reference: 'Fixture owner explicitly approved inventory 100' },
        { table: 'order_status_history', id: '31', fields: { order_id: { before: '2000', after: '1000' } } },
        ...(!preserveOutbound ? [{ table: 'outbound_records', id: '2', fields: { order_item_id: { before: '10001', after: '10002' } } }] : [])
      ]) {
        const [row] = await query(`SELECT ${rowHash(before.find(meta => meta.table === change.table))} sha256 FROM ${q(change.table)} FORCE INDEX(PRIMARY) WHERE id=?`, [change.id]);
        plan.link_plan.changes.push({ ...change, expected_full_row_sha256: row.sha256, original_shop_id: '10', expected_tenant_id: '1' });
      }
      await query(`CREATE DATABASE ${q(review)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      for (const table of COMBINED_SCOPE) {
        const columns = before.find(entry => entry.table === table).insert_columns.map(q).join(',');
        await query(`CREATE TABLE ${q(review)}.${q(table)} LIKE ${q(database)}.${q(table)}`);
        await query(`INSERT INTO ${q(review)}.${q(table)} (${columns}) SELECT ${columns} FROM ${q(database)}.${q(table)} FORCE INDEX(PRIMARY)`);
      }
      await query(`USE ${q(review)}`); await applyLinks(db, plan.link_plan, review);
      const audit = await inspectReviewedUniqueRepair(db, plan.unique_plan); assert.equal(audit.conflicts.length, 0);
      plan.unique_plan.expected_reference_digest = 'pending_actual_stage_inspection_after_link_correction';
      for (const entry of plan.unique_plan.tables) for (const group of entry.groups) {
        const inspected = audit.tables.find(row => row.table === entry.table).groups.find(row => row.keeper_id === String(group.keeper_id));
        group.expected_hashes = inspected.expected_hashes; group.accepted_differing_columns = inspected.differing_columns;
      }
      await query(`USE ${q(database)}`);
      await action({ db, database, query, plan, before });
    } finally { await query(`USE ${q(database)}`); await query(`DROP DATABASE IF EXISTS ${q(stage)}`); await query(`DROP DATABASE IF EXISTS ${q(review)}`); }
  });
}

test('combined preflight is read-only and capacity failure leaves no stage or journal', { skip: !socketPath }, async () => scenario(async ({ db, query, plan, before }) => {
  await assert.rejects(inspectCombined(db, plan, { freeSpace: async () => 3n * 1024n ** 3n }), /Insufficient maintenance capacity/);
  assert.equal((await query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [plan.stage_database])).length, 0);
  equalSnapshots(before, await captureCombinedSource(db, plan.source_database));
}));
test('installation cannot claim capacity credit from a future or missing prepared stage', { skip: !socketPath }, async () => scenario(async ({ db, query, plan }) => {
  await assert.rejects(installCombined(db, plan, { freeSpace: async () => 11n * 1024n ** 3n }));
  assert.equal((await query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [plan.stage_database])).length, 0);
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_unique_index_repairs'")).length, 0);
}));
test('prepared staging does not excuse insufficient remaining installation headroom', { skip: !socketPath }, async () => scenario(async ({ db, query, plan, before }) => {
  await prepareCombined(db, plan, space);
  await assert.rejects(installCombined(db, plan, { freeSpace: async () => 1024n ** 3n }), /Insufficient installation capacity/);
  equalSnapshots(before, await captureCombinedSource(db, plan.source_database));
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_unique_index_repairs'")).length, 0);
}));

test('unchanged staging references require exact native rows and DDL before receiving installation capacity credit', { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan }) => {
  await query("UPDATE online_product_actions SET online_product_id=12; UPDATE sku_inventory_recipes SET online_product_id=12; UPDATE inventory_product_requests SET payload_json=JSON_SET(payload_json,'$.online_product_id',12),updated_at=updated_at");
  plan.source_snapshots = await captureCombinedSource(db, database);
  const before = plan.source_snapshots;
  const prepared = await prepareCombined(db, plan, space);
  for (const table of ['online_product_actions', 'sku_inventory_recipes', 'inventory_product_requests']) {
    assert.ok(!prepared.references.some(ref => ref.table === table), `${table} is an unchanged stage reference`);
  }
  await query(`UPDATE ${q(plan.stage_database)}.online_product_actions SET request_json='unreviewed native evidence' WHERE id=1`);
  await assert.rejects(installCombined(db, plan, space), /Prepared unchanged reference changed: online_product_actions/);
  await query(`UPDATE ${q(plan.stage_database)}.online_product_actions stage JOIN ${q(database)}.online_product_actions source ON source.id=stage.id SET stage.request_json=source.request_json`);
  await query(`INSERT INTO ${q(plan.stage_database)}.sku_inventory_recipes VALUES(99,12,10,'unreviewed-extra-reference')`);
  await assert.rejects(installCombined(db, plan, space), /Prepared unchanged reference changed: sku_inventory_recipes/);
  await query(`DELETE FROM ${q(plan.stage_database)}.sku_inventory_recipes WHERE id=99`);
  await query(`ALTER TABLE ${q(plan.stage_database)}.inventory_product_requests ADD KEY fixture_unreviewed_stage(id)`);
  await assert.rejects(installCombined(db, plan, space), /Prepared unchanged reference changed: inventory_product_requests/);
  await query(`ALTER TABLE ${q(plan.stage_database)}.inventory_product_requests DROP KEY fixture_unreviewed_stage`);
  equalSnapshots(before, await captureCombinedSource(db, database));
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_unique_index_repairs'")).length, 0, 'tampering is refused before source journal or writes');
  await installCombined(db, plan, space);
  await rollbackCombined(db, plan.repair_id, database, true);
  equalSnapshots(before, await captureCombinedSource(db, database));
}));
test('installation credits only current owned staging objects with a fixed ceiling, never unrelated tables or DATA_FREE', { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan }) => {
  await prepareCombined(db, plan, space);
  await query(`CREATE TABLE ${q(plan.stage_database)}.unrelated_capacity(id BIGINT PRIMARY KEY,payload LONGBLOB) ENGINE=InnoDB`);
  let unrelatedRead = false;
  const wrapped = { query: async (statement, args) => {
    const result = await db.query(statement, args);
    if (statement.startsWith('SELECT SPACE,NAME,SPACE_TYPE,FILE_SIZE,ALLOCATED_SIZE')) {
      if (args?.[0] === `${plan.stage_database}/unrelated_capacity`) unrelatedRead = true;
      if (args?.[0] === `${plan.stage_database}/online_products`) result[0][0] = { ...result[0][0], FILE_SIZE: String(5n * 1024n ** 3n), ALLOCATED_SIZE: String(5n * 1024n ** 3n) };
    }
    return result;
  }, beginTransaction: db.beginTransaction.bind(db), commit: db.commit.bind(db), rollback: db.rollback.bind(db) };
  const result = await installCombined(wrapped, plan, space);
  assert.ok(BigInt(result.capacity.actual_prepared_stage_allocated_bytes) > 2480603136n);
  assert.equal(result.capacity.credited_prepared_stage_bytes, '2480603136');
  assert.equal(result.capacity.required_remaining_free_bytes, String(12n * 1024n ** 3n - 2480603136n));
  assert.equal(unrelatedRead, false);
  await rollbackCombined(db, plan.repair_id, database, true);
}));
test('staging credit uses allocated file bytes rather than table estimates, logical file size or a shared tablespace', { skip: !socketPath }, async () => scenario(async ({ db, database, plan }) => {
  await prepareCombined(db, plan, space);
  const wrapped = { query: async (statement, args) => {
    const result = await db.query(statement, args);
    if (statement.startsWith('SELECT ENGINE,DATA_LENGTH,INDEX_LENGTH,AUTO_INCREMENT') && args?.[0] === plan.stage_database) result[0][0] = { ...result[0][0], DATA_LENGTH: 50 * 1024 ** 3, INDEX_LENGTH: 50 * 1024 ** 3 };
    if (statement.startsWith('SELECT SPACE,NAME,SPACE_TYPE,FILE_SIZE,ALLOCATED_SIZE')) {
      result[0][0] = { ...result[0][0], FILE_SIZE: String(50n * 1024n ** 3n), ALLOCATED_SIZE: '4096' };
      if (args?.[0] === `${plan.stage_database}/products`) result[0][0].SPACE_TYPE = 'General';
    }
    return result;
  }, beginTransaction: db.beginTransaction.bind(db), commit: db.commit.bind(db), rollback: db.rollback.bind(db) };
  const result = await installCombined(wrapped, plan, space);
  assert.equal(result.capacity.actual_prepared_stage_allocated_bytes, String(17 * 4096));
  assert.deepEqual(result.capacity.uncredited_stage_tables, ['products']);
  assert.equal(result.capacity.credited_prepared_stage_bytes, String(17 * 4096));
  await rollbackCombined(db, plan.repair_id, database, true);
}));
test('installation refreshes filesystem capacity after full prepared verification and rejects a fresh drop before source writes', { skip: !socketPath }, async () => scenario(async ({ db, query, plan }) => {
  await prepareCombined(db, plan, space); let checks = 0;
  await assert.rejects(installCombined(db, plan, { freeSpace: async () => (++checks === 1 ? 100n : 1n) * 1024n ** 3n }), /Insufficient installation capacity/);
  assert.equal(checks, 2);
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_unique_index_repairs'")).length, 0);
}));
test('verified staging consumes its reserved initial budget so normal install can proceed below the original 12 GiB threshold', { skip: !socketPath }, async () => scenario(async ({ db, database, plan }) => {
  await prepareCombined(db, plan, space);
  const result = await installCombined(db, plan, { freeSpace: async () => 12n * 1024n ** 3n - 1n });
  assert.equal(result.phase, 'applied'); assert.ok(BigInt(result.capacity.credited_prepared_stage_bytes) > 0n);
  assert.ok(BigInt(result.capacity.required_remaining_free_bytes) < 12n * 1024n ** 3n);
  assert.ok(BigInt(result.capacity.required_remaining_free_bytes) >= 9n * 1024n ** 3n);
  await rollbackCombined(db, plan.repair_id, database, true);
}));
test('combined prepared corrections never touch source; strict installation archives originals and full native undo restores them', { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan, before }) => {
  const prepared = await prepareCombined(db, plan, space); assert.equal(prepared.changes_source, false);
  equalSnapshots(before, await captureCombinedSource(db, database));
  const installed = await installCombined(db, plan, space); assert.equal(installed.phase, 'applied');
  assert.equal(String((await query('SELECT order_id FROM order_status_history WHERE id=31'))[0].order_id), '1000');
  assert.equal(String((await query('SELECT order_item_id FROM outbound_records WHERE id=2'))[0].order_item_id), '10002');
  for (const table of ['online_products', 'order_status_history', 'ozon_category_mappings']) assert.ok((await query('SELECT NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME<>\'PRIMARY\'', [table])).some(row => Number(row.NON_UNIQUE) === 0));
  const undone = await rollbackCombined(db, plan.repair_id, database, true); assert.equal(undone.schema_exact, false);
  equalSnapshots(before, await captureCombinedSource(db, database));
}));
for (const checkpoint of ['references_applied', 'archive_index:online_products', 'forward_rename_before_journal']) test(`combined interruption after ${checkpoint} is recoverable from the one source journal`, { skip: !socketPath }, async () => scenario(async ({ db, database, plan, before }) => {
  await prepareCombined(db, plan, space);
  await assert.rejects(installCombined(db, plan, { ...space, checkpoint: async phase => { if (phase === checkpoint) throw Error('Simulated interruption'); } }), /Simulated interruption/);
  const state = await inspectCombinedJournal(db, plan.repair_id, database); assert.equal(state.mode, 'combined-shadow');
  await rollbackCombined(db, plan.repair_id, database, true);
  equalSnapshots(before, await captureCombinedSource(db, database));
}));
test('interruption after reverse rename resumes without a second rename or duplicated reference writes', { skip: !socketPath }, async () => scenario(async ({ db, database, plan, before }) => {
  await prepareCombined(db, plan, space); await installCombined(db, plan, space);
  await assert.rejects(rollbackCombined(db, plan.repair_id, database, true, { checkpoint: async () => { throw Error('Simulated reverse interruption'); } }), /Simulated reverse interruption/);
  await rollbackCombined(db, plan.repair_id, database, true); equalSnapshots(before, await captureCombinedSource(db, database));
}));
test('source rows changed after preparation refuse installation before source business writes', { skip: !socketPath }, async () => scenario(async ({ db, query, plan }) => {
  await prepareCombined(db, plan, space); await query("UPDATE products SET active=0 WHERE id=100");
  await assert.rejects(installCombined(db, plan, space), /Reviewed native source rows changed/);
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_unique_index_repairs'")).length, 0);
}));
test('tampered complete target archive refuses automatic rollback', { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan }) => {
  await prepareCombined(db, plan, space); await installCombined(db, plan, space);
  await query(`UPDATE ${q(`_uir_${plan.repair_id}_old_online_products`)} SET raw_json='tampered' WHERE id=11`);
  await assert.rejects(rollbackCombined(db, plan.repair_id, database, true), /Complete original target archive changed/);
}));
test('tampered complete native reference beforeimage refuses automatic rollback', { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan }) => {
  await prepareCombined(db, plan, space); await installCombined(db, plan, space);
  await query(`UPDATE ${q(`_uir_${plan.repair_id}_before_product_barcode_label_cache`)} SET label_pdf=UNHEX('DEAD') WHERE online_product_id=11`);
  await assert.rejects(rollbackCombined(db, plan.repair_id, database, true), /Native reference before\/after image changed/);
}));
test('stored generated parent columns are verified but never written; writable generated columns still refuse', { skip: !socketPath }, async () => scenario(async ({ db, database, plan, before }) => {
  await prepareCombined(db, plan, space); equalSnapshots(before, await captureCombinedSource(db, database));
  assert.equal((await db.query(`SELECT fixture_stored FROM ${q(plan.stage_database)}.products WHERE id=100`))[0][0].fixture_stored, 1);
}, { generatedParent: true }));
test('production placeholders are refused before any stage DDL or source installation', { skip: !socketPath }, async () => scenario(async ({ db, query, plan }) => {
  plan.source_kind = 'production_maintenance_snapshot'; plan.production_approved = true;
  await assert.rejects(prepareCombined(db, plan, space), /independently reviewed actual reference digest/);
  await assert.rejects(installCombined(db, plan, space), /reviewed actual reference digest/);
  assert.equal((await query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [plan.stage_database])).length, 0);
}));
test('production writing actions require actual boolean approval after fresh independent plan review', { skip: !socketPath }, async () => scenario(async ({ db, query, plan }) => {
  plan.source_kind = 'production_maintenance_snapshot';
  for (const approval of [undefined, false, 'true']) {
    if (approval === undefined) delete plan.production_approved; else plan.production_approved = approval;
    await inspectCombined(db, plan, space);
    await assert.rejects(prepareCombined(db, plan, space), /production_approved=true/);
    await assert.rejects(installCombined(db, plan, space), /production_approved=true/);
    assert.equal((await query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [plan.stage_database])).length, 0);
    assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_unique_index_repairs'")).length, 0);
  }
}));
test('strict CLI parser refuses false booleans, unknown/duplicate flags and mixed actions before opening MySQL', () => {
  const base = ['--database=fixture', '--mysql-admin-socket=explicit-pipe', '--plan=reviewed.json'];
  assert.equal(parseCombinedArguments([...base, '--install']).install, true);
  assert.equal(parseCombinedArguments(base).install, undefined);
  for (const extra of [['--install=false'], ['--install=true'], ['--prepare=false'], ['--install', '--prepare'], ['--install', '--rollback=123'], ['--install', '--install'], ['--unknown'], ['--plan=again.json'], ['--stage'], ['--maintenance-confirmed']]) {
    assert.throws(() => parseCombinedArguments([...base, ...extra]));
  }
});
test('unsafe numeric row IDs are refused before SQL rather than rounded into a valid identifier', async () => {
  await assert.rejects(nativeDigest({ query() { throw Error('Unexpected SQL'); } }, { primary: 'id' }, [9007199254740992]), /safe JSON integer precision must be strings/);
});
for (const [label, mutation] of [['shop enterprise', 'UPDATE shops SET tenant_id=3 WHERE id=10'], ['order parent', 'UPDATE orders SET shop_id=30 WHERE id=1000']]) test(`a ${label} change after initial install inspection is refused by current locked parent reads before reference writes`, { skip: !socketPath }, async () => scenario(async ({ db, query, plan }) => {
  await prepareCombined(db, plan, space);
  const references = {};
  for (const table of COMBINED_SCOPE.slice(3, 10)) references[table] = await query(`SELECT * FROM ${q(table)} FORCE INDEX(PRIMARY) ORDER BY 1`);
  await assert.rejects(installCombined(db, plan, { ...space, checkpoint: async phase => { if (phase === 'before_reference_transaction') await query(mutation); } }), /Fresh locked parent data changed/);
  for (const [table, rows] of Object.entries(references)) assert.deepEqual(await query(`SELECT * FROM ${q(table)} FORCE INDEX(PRIMARY) ORDER BY 1`), rows, table);
  assert.equal((await inspectCombinedJournal(db, plan.repair_id, plan.source_database)).phase, 'preparing');
}));
test('link helper refuses unsafe row IDs and invalid after IDs before issuing SQL', async () => {
  const base = { version: 1, repair_id: 'a'.repeat(12), reviewed_by: 'Test reviewer', reason: 'Boundary test', maintenance_confirmed: true,
    changes: [{ table: 'order_status_history', id: '31', expected_full_row_sha256: 'b'.repeat(64), original_shop_id: '10', expected_tenant_id: '1', fields: { order_id: { before: null, after: '1000' } } }] };
  const db = { query() { throw Error('Unexpected SQL'); } };
  const unsafe = structuredClone(base); unsafe.changes[0].id = 9007199254740992;
  await assert.rejects(inspectLinks(db, unsafe, 'fixture'), /safe|precision|integer/i);
  for (const value of [9007199254740992, 0, -1, null, '0', '-2']) {
    const invalid = structuredClone(base); invalid.changes[0].fields.order_id.after = value;
    await assert.rejects(inspectLinks(db, invalid, 'fixture'), /safe|precision|integer|ID/i);
  }
});
for (const table of ['online_products', 'outbound_records']) test(`cross-schema foreign key to ${table} refuses combined preparation without creating stage`, { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan }) => {
  const foreignDatabase = `${database}_fk`;
  try {
    await query(`CREATE DATABASE ${q(foreignDatabase)}`);
    await query(`CREATE TABLE ${q(foreignDatabase)}.external_child (id BIGINT PRIMARY KEY, remote_id BIGINT UNSIGNED,
      FOREIGN KEY(remote_id) REFERENCES ${q(database)}.${q(table)}(id)) ENGINE=InnoDB`);
    await assert.rejects(prepareCombined(db, plan, space), /Triggers\/FKs require separate review/);
    assert.equal((await query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [plan.stage_database])).length, 0);
  } finally { await query(`DROP DATABASE IF EXISTS ${q(foreignDatabase)}`); }
}));

test('combined unchanged outbound preservation reports unresolved history and installs no rewrite of any field', { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan, before }) => {
  const original = await query('SELECT * FROM outbound_records FORCE INDEX(PRIMARY) ORDER BY id');
  const prepared = await prepareCombined(db, plan, space);
  assert.equal(prepared.unchanged_outbound_reference.relationship_reconciled, false);
  assert.equal(prepared.unchanged_outbound_reference.byte_unchanged, true);
  assert.deepEqual(prepared.unchanged_outbound_reference.before_digest, prepared.unchanged_outbound_reference.after_digest);
  assert.ok(!prepared.references.some(ref => ref.table === 'outbound_records'), 'preserved row has no outbound DML or archive install');
  const installed = await installCombined(db, plan, space);
  assert.deepEqual(installed.unchanged_outbound_reference, prepared.unchanged_outbound_reference);
  assert.deepEqual(await query('SELECT * FROM outbound_records FORCE INDEX(PRIMARY) ORDER BY id'), original);
  await rollbackCombined(db, plan.repair_id, database, true);
  equalSnapshots(before, await captureCombinedSource(db, database));
}, { preserveOutbound: true }));

test('combined installation checks unchanged outbound current bytes even when that table has no changed rows', { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan }) => {
  await prepareCombined(db, plan, space);
  const originals = {};
  for (const table of COMBINED_SCOPE.slice(3, 10)) originals[table] = await query(`SELECT * FROM ${q(table)} FORCE INDEX(PRIMARY) ORDER BY 1`);
  await assert.rejects(installCombined(db, plan, { ...space, checkpoint: async phase => {
    if (phase === 'before_reference_transaction') await query('UPDATE outbound_records SET quantity=99 WHERE id=2');
  } }), /native row hash changed/);
  for (const [table, rows] of Object.entries(originals)) if (table !== 'outbound_records') assert.deepEqual(await query(`SELECT * FROM ${q(table)} FORCE INDEX(PRIMARY) ORDER BY 1`), rows);
  assert.equal(Number((await query('SELECT quantity FROM outbound_records WHERE id=2'))[0].quantity), 99, 'refusal preserves the independent changed row');
  assert.equal((await inspectCombinedJournal(db, plan.repair_id, database)).phase, 'preparing');
}, { preserveOutbound: true }));

test('read-only parent FK and trigger definitions are captured and preserved; staging carries neither and external native rows never change', { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan }) => {
  const foreignDatabase = `${database}_fk`;
  try {
    await query(`CREATE DATABASE ${q(foreignDatabase)}`);
    await query(`CREATE TABLE ${q(foreignDatabase)}.parent_effects(id BIGINT PRIMARY KEY,n INT) ENGINE=InnoDB; INSERT INTO ${q(foreignDatabase)}.parent_effects VALUES(1,0)`);
    await query(`CREATE TABLE ${q(foreignDatabase)}.external_child(id BIGINT PRIMARY KEY,remote_id BIGINT UNSIGNED,
      CONSTRAINT fixture_readonly_fk FOREIGN KEY(remote_id) REFERENCES ${q(database)}.products(id)) ENGINE=InnoDB; INSERT INTO ${q(foreignDatabase)}.external_child VALUES(1,100)`);
    await query(`CREATE TRIGGER readonly_parent_fixture AFTER INSERT ON products FOR EACH ROW UPDATE ${q(foreignDatabase)}.parent_effects SET n=n+1 WHERE id=1`);
    plan.source_snapshots = await captureCombinedSource(db, database);
    const dependencies = plan.source_snapshots.find(row => row.table === 'products').readonly_dependencies;
    assert.equal(dependencies.triggers.length, 1); assert.equal(dependencies.foreign_keys.length, 1);
    const externalRows = await query(`SELECT * FROM ${q(foreignDatabase)}.external_child`), effectRows = await query(`SELECT * FROM ${q(foreignDatabase)}.parent_effects`);
    const externalDDL = await query(`SHOW CREATE TABLE ${q(foreignDatabase)}.external_child`), effectDDL = await query(`SHOW CREATE TABLE ${q(foreignDatabase)}.parent_effects`);
    await prepareCombined(db, plan, space);
    const [stageDependencies] = await query(`SELECT (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?) AS triggers_count,
      (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL AND
      (TABLE_SCHEMA=? OR REFERENCED_TABLE_SCHEMA=?)) AS foreign_count`, [plan.stage_database, plan.stage_database, plan.stage_database]);
    assert.equal(Number(stageDependencies.triggers_count), 0); assert.equal(Number(stageDependencies.foreign_count), 0);
    await installCombined(db, plan, space);
    const after = await captureCombinedSource(db, database);
    for (const table of COMBINED_SCOPE.slice(10)) assert.deepEqual(after.find(row => row.table === table), plan.source_snapshots.find(row => row.table === table));
    assert.deepEqual(await query(`SELECT * FROM ${q(foreignDatabase)}.external_child`), externalRows);
    assert.deepEqual(await query(`SELECT * FROM ${q(foreignDatabase)}.parent_effects`), effectRows);
    assert.deepEqual(await query(`SHOW CREATE TABLE ${q(foreignDatabase)}.external_child`), externalDDL);
    assert.deepEqual(await query(`SHOW CREATE TABLE ${q(foreignDatabase)}.parent_effects`), effectDDL);
    await rollbackCombined(db, plan.repair_id, database, true);
  } finally { await query(`DROP TRIGGER IF EXISTS readonly_parent_fixture`); await query(`DROP DATABASE IF EXISTS ${q(foreignDatabase)}`); }
}));

test('a read-only dependency definition changed after snapshot refuses source installation', { skip: !socketPath }, async () => scenario(async ({ db, query, plan }) => {
  await prepareCombined(db, plan, space);
  await query('CREATE TRIGGER changed_parent_fixture BEFORE UPDATE ON products FOR EACH ROW SET NEW.active=NEW.active');
  await assert.rejects(installCombined(db, plan, space), /read-only dependencies changed/);
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_unique_index_repairs'")).length, 0);
}));

test('same trigger definition recreated by dump restoration keeps its definition fingerprint and source-only rollback works', { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan }) => {
  const statement = 'CREATE TRIGGER restored_parent_fixture BEFORE UPDATE ON products FOR EACH ROW SET NEW.active=NEW.active';
  await query(statement); plan.source_snapshots = await captureCombinedSource(db, database);
  const [createdBefore] = await query('SHOW CREATE TRIGGER restored_parent_fixture');
  await prepareCombined(db, plan, space); await installCombined(db, plan, space); await query(`DROP DATABASE ${q(plan.stage_database)}`);
  await query('DROP TRIGGER restored_parent_fixture'); await query(statement);
  const [createdAfter] = await query('SHOW CREATE TRIGGER restored_parent_fixture');
  assert.notEqual(createdAfter.Created, createdBefore.Created, 'server creation time changes when an otherwise identical trigger is restored');
  const restored = await captureCombinedSource(db, database);
  assert.deepEqual(restored.find(entry => entry.table === 'products').readonly_dependencies, plan.source_snapshots.find(entry => entry.table === 'products').readonly_dependencies);
  await query('DROP TRIGGER restored_parent_fixture');
  await query('CREATE TRIGGER restored_parent_fixture BEFORE UPDATE ON products FOR EACH ROW SET NEW.active=1');
  await assert.rejects(rollbackCombined(db, plan.repair_id, database, true), /Fresh locked parent data changed/);
  assert.equal((await inspectCombinedJournal(db, plan.repair_id, database)).phase, 'applied');
  await query('DROP TRIGGER restored_parent_fixture'); await query(statement);
  const result = await rollbackCombined(db, plan.repair_id, database, true);
  assert.equal(result.native_original_data_restored, true);
  equalSnapshots(plan.source_snapshots, await captureCombinedSource(db, database));
}));

test('matching combined rollback uses only source archives and journal after the independent stage database is dropped', { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan, before }) => {
  await prepareCombined(db, plan, space); await installCombined(db, plan, space);
  await query(`DROP DATABASE ${q(plan.stage_database)}`);
  const result = await rollbackCombined(db, plan.repair_id, database, true);
  assert.equal(result.native_original_data_restored, true);
  equalSnapshots(before, await captureCombinedSource(db, database));
}, { preserveOutbound: true }));

for (const [label, mutation, expected] of [
  ['unchanged outbound native bytes', 'UPDATE outbound_records SET quantity=99 WHERE id=2', /native row hash changed/],
  ['read-only parent enterprise', 'UPDATE shops SET tenant_id=2 WHERE id=11', /Fresh locked parent data changed/]
]) test(`rollback refuses later ${label} even without changed outbound rows or a remaining stage database`, { skip: !socketPath }, async () => scenario(async ({ db, database, query, plan }) => {
  const prepared = await prepareCombined(db, plan, space);
  assert.ok(!prepared.references.some(ref => ref.table === 'outbound_records'));
  await installCombined(db, plan, space); await query(`DROP DATABASE ${q(plan.stage_database)}`); await query(mutation);
  const before = {};
  for (const table of COMBINED_SCOPE) before[table] = await query(`SELECT * FROM ${q(table)} FORCE INDEX(PRIMARY) ORDER BY 1`);
  await assert.rejects(rollbackCombined(db, plan.repair_id, database, true), expected);
  for (const table of COMBINED_SCOPE) assert.deepEqual(await query(`SELECT * FROM ${q(table)} FORCE INDEX(PRIMARY) ORDER BY 1`), before[table], table);
  assert.equal((await inspectCombinedJournal(db, plan.repair_id, database)).phase, 'applied');
}, { preserveOutbound: true }));
test('the old ordinary rollback CLI explicitly refuses an installed combined-mode journal', { skip: !socketPath }, async () => scenario(async ({ db, database, plan }) => {
  await prepareCombined(db, plan, space); await installCombined(db, plan, space);
  await assert.rejects(rollbackReviewedUniqueRepair(db, plan.repair_id, database, true), /Combined shadow repair requires its matching coordinator rollback/);
  assert.equal((await inspectCombinedJournal(db, plan.repair_id, database)).phase, 'applied');
  await rollbackCombined(db, plan.repair_id, database, true);
}));
