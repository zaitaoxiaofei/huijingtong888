import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { migrateInventoryConsumables, normalizeConsumableManifest, runInventoryConsumableMigrationCli } from '../scripts/migrate-inventory-consumables.mjs';

const updatedAt = '2026-11-05 00:00:00.000000';
const product = (id, tenantId, extra = {}) => ({ id, tenant_id: tenantId, code: `P-TEST-${id}`, inventory_number: `60-${id}`,
  inventory_category: '礼盒', product_type: 'main', is_accessory: 0, is_consumable: 0, active: 1, updated_at: updatedAt,
  name: `reviewed product ${id}`, ...extra });
function manifest(rows, extra = {}) {
  return { version: 1, tenant_id: 7, include_legacy_null: false, reviewed_by: 'test-reviewer', reason: 'Explicitly reviewed product IDs',
    products: rows.map(row => ({ product_id: Number(row.id), set_is_consumable: 1,
      expected: Object.fromEntries(['tenant_id', 'code', 'inventory_number', 'inventory_category', 'product_type', 'is_accessory', 'is_consumable', 'active', 'updated_at'].map(key => [key, row[key]])) })), ...extra };
}
function fakeDatabase(initialRows, { hasColumn = true, tenantSlug = 'default', sideEffect = false } = {}) {
  let rows = structuredClone(initialRows), before;
  const statements = [];
  const db = {
    statements, rows: () => structuredClone(rows),
    async query(sql, values = []) {
      statements.push(sql);
      if (sql.includes('information_schema.TABLES')) return [[{ ENGINE: 'InnoDB' }]];
      if (sql.startsWith('SHOW COLUMNS')) {
        const fields = Object.keys(initialRows[0] || product(1, 7)).filter(field => hasColumn || field !== 'is_consumable');
        return [fields.map(Field => ({ Field, Type: Field === 'is_consumable' ? 'tinyint(1)' : 'varchar(255)', Null: 'NO', Default: '0', Extra: '' }))];
      }
      if (sql.startsWith('ALTER TABLE')) { hasColumn = true; return [{}]; }
      if (sql.startsWith('SELECT id, slug')) return [[{ id: values[0], slug: tenantSlug, status: 'active' }]];
      if (sql.startsWith('SELECT p.*')) return [rows.filter(row => values.slice(1).includes(row.id)
        && (row.tenant_id === values[0] || (sql.includes('OR p.tenant_id IS NULL') && row.tenant_id === null))).map(row => structuredClone(row))];
      throw new Error(`Unexpected test query: ${sql}`);
    },
    async execute(sql, values) {
      statements.push(sql);
      const [flag, id, tenantId, oldFlag] = values;
      const row = rows.find(row => row.id === id && row.tenant_id === tenantId && row.is_consumable === oldFlag);
      if (!row) return [{ affectedRows: 0 }];
      row.is_consumable = flag;
      if (sideEffect) row.inventory_number = 'changed-by-trigger';
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() { before = structuredClone(rows); },
    async commit() { before = undefined; },
    async rollback() { if (before) rows = before; before = undefined; }
  };
  return db;
}
async function privateDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inventory-consumable-test-'));
  return { directory, cleanup: async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('inventory-consumable-test-'));
    await rm(directory, { recursive: true, force: true });
  } };
}

test('schema dry-run never writes and additive apply does not classify any product', async () => {
  const db = fakeDatabase([product(1, 7)], { hasColumn: false });
  const report = await migrateInventoryConsumables(db);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.schema_would_add_column, true);
  assert.ok(db.statements.every(sql => !/^(?:ALTER|UPDATE|INSERT|DELETE)/.test(sql)));
  assert.equal((await migrateInventoryConsumables(db, { apply: true })).schema_ready, true);
  assert.equal(db.rows()[0].is_consumable, 0);
  assert.equal(db.statements.filter(sql => sql.startsWith('ALTER')).length, 1);
  await migrateInventoryConsumables(db, { apply: true });
  assert.equal(db.statements.filter(sql => sql.startsWith('ALTER')).length, 1);
});

test('manifest rejects broad classification, duplicate IDs, incomplete before images and implicit tenant scope', () => {
  const row = product(1, 7);
  for (const invalid of [
    { ...manifest([row]), products: [] },
    manifest([row, row]),
    manifest([product(1, 8)]),
    manifest([product(1, 7, { inventory_category: '钥匙壳' })]),
    manifest([product(1, 7, { active: 0 })]),
    { ...manifest([row]), include_legacy_null: undefined }
  ]) assert.throws(() => normalizeConsumableManifest(invalid));
  const incomplete = manifest([row]); delete incomplete.products[0].expected.code;
  assert.throws(() => normalizeConsumableManifest(incomplete), /complete expected/);
});

test('reviewed dry-run is tenant-scoped; NULL ownership requires actual default tenant and explicit row acknowledgement', async () => {
  const own = product(1, 7), foreign = product(2, 8), legacy = product(3, null);
  const db = fakeDatabase([own, foreign, legacy]);
  assert.deepEqual((await migrateInventoryConsumables(db, { manifest: manifest([own]) })).would_change_ids, [1]);
  assert.ok(db.statements.every(sql => !sql.startsWith('UPDATE')));
  const foreignClaim = manifest([foreign], { tenant_id: 8 });
  foreignClaim.tenant_id = 7; foreignClaim.products[0].expected.tenant_id = 7;
  await assert.rejects(migrateInventoryConsumables(db, { manifest: foreignClaim }), /missing or outside/);
  const legacyManifest = manifest([legacy], { include_legacy_null: true });
  assert.equal((await migrateInventoryConsumables(db, { manifest: legacyManifest })).reviewed_product_count, 1);
  await assert.rejects(migrateInventoryConsumables(fakeDatabase([legacy], { tenantSlug: 'customer' }), { manifest: legacyManifest }), /actual default tenant/);
});

test('reviewed apply backs up first and changes only the flag; stale data, backup failure and trigger side effects roll back', async () => {
  const temporary = await privateDirectory();
  const rows = [product(1, 7), product(2, 8), product(3, 7, { is_accessory: 1 })];
  try {
    const backupPath = path.join(temporary.directory, 'before.json');
    const db = fakeDatabase(rows);
    const result = await migrateInventoryConsumables(db, { apply: true, manifest: manifest([rows[0], rows[2]]), backupPath });
    assert.deepEqual(result.changed_product_ids, [1, 3]);
    assert.deepEqual(db.rows(), rows.map(row => ({ ...row, is_consumable: row.tenant_id === 7 ? 1 : 0 })));
    const backup = await readFile(backupPath, 'utf8');
    assert.deepEqual(JSON.parse(backup).products, [rows[0], rows[2]]);
    assert.equal((await readFile(`${backupPath}.sha256`, 'utf8')).trim(), createHash('sha256').update(backup).digest('hex'));
    if (process.platform !== 'win32') assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    const unchanged = fakeDatabase(rows);
    await assert.rejects(migrateInventoryConsumables(unchanged, { apply: true, manifest: manifest([rows[0]]), backupPath }), /EEXIST/);
    assert.deepEqual(unchanged.rows(), rows);
    const stale = manifest([rows[0]]); stale.products[0].expected.code = 'stale-code';
    await assert.rejects(migrateInventoryConsumables(unchanged, { apply: true, manifest: stale, backupPath: path.join(temporary.directory, 'stale.json') }), /before-image changed/);
    const sideEffect = fakeDatabase(rows, { sideEffect: true });
    await assert.rejects(migrateInventoryConsumables(sideEffect, { apply: true, manifest: manifest([rows[0]]), backupPath: path.join(temporary.directory, 'trigger.json') }));
    assert.deepEqual(sideEffect.rows(), rows);
  } finally { await temporary.cleanup(); }
});

test('CLI refuses implicit application databases and TCP before connecting', async () => {
  await assert.rejects(runInventoryConsumableMigrationCli([]), /Explicit --database/);
  await assert.rejects(runInventoryConsumableMigrationCli(['--database=test', '--mysql-admin-socket=127.0.0.1']), /no TCP/);
  await assert.rejects(runInventoryConsumableMigrationCli(['--database=test', '--host=example']), /Unknown/);
});

test('canonical schema and reviewed consumable migration work on an isolated real MySQL database', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent TCP-disabled test MySQL socket'
}, async () => {
  const fixture = await createTenantMysqlFixture('consumables');
  const temporary = await privateDirectory();
  try {
    assert.equal((await migrateInventoryConsumables(fixture.connection)).schema_ready, true);
    await fixture.connection.query('ALTER TABLE products DROP COLUMN is_consumable');
    await fixture.connection.query('ALTER TABLE products ADD COLUMN is_accessory TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN inventory_number VARCHAR(64) NULL');
    await fixture.connection.query("INSERT INTO tenants(id, slug, name, status) VALUES (7,'default','test','active'),(8,'customer','other','active')");
    await fixture.connection.query("INSERT INTO products(id,tenant_id,name,code,inventory_number,inventory_category,updated_at) VALUES (1,7,'box','P-TEST-1','60-1','礼盒','2026-11-05'),(2,8,'foreign','P-TEST-2','60-2','礼盒','2026-11-05')");
    assert.equal((await migrateInventoryConsumables(fixture.connection)).schema_ready, false);
    await migrateInventoryConsumables(fixture.connection, { apply: true });
    const before = await fixture.query("SELECT p.*,DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s.%f') AS updated_at FROM products p WHERE id=1");
    const reviewed = manifest(before);
    assert.equal((await migrateInventoryConsumables(fixture.connection, { manifest: reviewed })).changes_database, false);
    await migrateInventoryConsumables(fixture.connection, { apply: true, manifest: reviewed, backupPath: path.join(temporary.directory, 'mysql-before.json') });
    assert.deepEqual((await fixture.query('SELECT id,is_consumable FROM products ORDER BY id')).map(row => [Number(row.id), Number(row.is_consumable)]), [[1, 1], [2, 0]]);
    await assert.rejects(migrateInventoryConsumables(fixture.connection, { apply: true, manifest: reviewed, backupPath: path.join(temporary.directory, 'stale.json') }), /before-image changed/);
  } finally { await temporary.cleanup(); await fixture.cleanup(); }
});
