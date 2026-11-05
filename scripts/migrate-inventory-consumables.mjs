import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONSUMABLE_COLUMN_SQL = 'ALTER TABLE products ADD COLUMN is_consumable TINYINT(1) NOT NULL DEFAULT 0, ALGORITHM=INSTANT';
const categories = new Set(['礼盒', '气泡袋', '香薰片']);
const expectedFields = ['tenant_id', 'code', 'inventory_number', 'inventory_category', 'product_type', 'is_accessory', 'is_consumable', 'active', 'updated_at'];
const refuse = message => Object.assign(new Error(message), { code: 'INVENTORY_CONSUMABLE_MIGRATION_REFUSED', safe: true });
const positive = value => Number.isSafeInteger(value) && value > 0;
const query = async (db, sql, params = []) => (await db.query(sql, params))[0];
const stable = row => JSON.parse(JSON.stringify(row));

export function normalizeConsumableManifest(value) {
  if (value?.version !== 1 || !positive(value.tenant_id) || typeof value.include_legacy_null !== 'boolean'
    || !String(value.reviewed_by || '').trim() || !String(value.reason || '').trim()
    || !Array.isArray(value.products) || !value.products.length || value.products.length > 1000) {
    throw refuse('A version 1 manifest needs an explicit tenant_id, include_legacy_null, reviewer, reason and 1-1000 reviewed product IDs');
  }
  const seen = new Set();
  const products = value.products.map(item => {
    if (!positive(item.product_id) || seen.has(item.product_id) || ![0, 1].includes(item.set_is_consumable)) throw refuse('Reviewed IDs must be unique; set_is_consumable must explicitly be 0 or 1');
    seen.add(item.product_id);
    const before = item.expected;
    if (!before || Object.keys(before).sort().join(',') !== [...expectedFields].sort().join(',')) throw refuse('Every product needs the complete expected before-image fields');
    if (before.tenant_id !== value.tenant_id && !(value.include_legacy_null && before.tenant_id === null)) throw refuse('Reviewed product ownership differs from the explicit tenant scope');
    if (![0, 1].includes(before.is_consumable) || ![0, 1].includes(before.is_accessory) || before.active !== 1
      || !categories.has(before.inventory_category) || typeof before.product_type !== 'string' || !before.product_type
      || ![before.code, before.inventory_number].every(text => text === null || typeof text === 'string')
      || typeof before.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(before.updated_at)) {
      throw refuse('Invalid reviewed before-image: only active, individually reviewed gift boxes, bubble bags and fragrance sheets are supported');
    }
    return { product_id: item.product_id, expected: { ...before }, set_is_consumable: item.set_is_consumable };
  }).sort((left, right) => left.product_id - right.product_id);
  return { version: 1, tenant_id: value.tenant_id, include_legacy_null: value.include_legacy_null,
    reviewed_by: String(value.reviewed_by).trim(), reason: String(value.reason).trim(), products };
}

export async function inspectConsumableSchema(db) {
  const [table] = await query(db, "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products'");
  if (table?.ENGINE !== 'InnoDB') throw refuse('An existing InnoDB products table is required');
  const columns = await query(db, 'SHOW COLUMNS FROM products');
  const column = columns.find(row => row.Field === 'is_consumable');
  if (column && (!/^tinyint(?:\(1\))?$/.test(String(column.Type).toLowerCase()) || column.Null !== 'NO'
    || String(column.Default) !== '0' || /GENERATED|INVISIBLE/i.test(column.Extra || ''))) throw refuse('Existing is_consumable schema is incompatible; no implicit alteration is allowed');
  return { column_exists: Boolean(column), compatible: Boolean(column), required_definition: 'TINYINT(1) NOT NULL DEFAULT 0', columns };
}

async function reviewedRows(db, manifest, schema, lock = false) {
  const [tenant] = await query(db, `SELECT id, slug, status FROM tenants WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [manifest.tenant_id]);
  if (!tenant || tenant.status !== 'active' || (manifest.include_legacy_null && tenant.slug !== 'default')) throw refuse('Active reviewed tenant required; legacy NULL ownership is allowed only for the actual default tenant');
  for (const field of expectedFields.filter(field => field !== 'is_consumable')) {
    if (!schema.columns.some(column => column.Field === field)) throw refuse(`Required product column missing: ${field}`);
  }
  const ids = manifest.products.map(item => item.product_id);
  const rows = await query(db, `SELECT p.*${schema.column_exists ? '' : ', 0 AS is_consumable'},
    DATE_FORMAT(p.updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at FROM products p
    WHERE (p.tenant_id = ?${manifest.include_legacy_null ? ' OR p.tenant_id IS NULL' : ''})
      AND p.id IN (${ids.map(() => '?').join(',')}) ORDER BY p.id${lock ? ' FOR UPDATE' : ''}`, [manifest.tenant_id, ...ids]);
  if (rows.length !== ids.length) throw refuse('A reviewed product is missing or outside the explicit tenant scope');
  for (const item of manifest.products) {
    const row = rows.find(row => Number(row.id) === item.product_id);
    for (const field of expectedFields) {
      const actual = ['is_consumable', 'is_accessory', 'active'].includes(field) || (field === 'tenant_id' && row[field] !== null) ? Number(row[field]) : row[field];
      if (actual !== item.expected[field]) throw refuse(`Reviewed before-image changed for product ${item.product_id}: ${field}`);
    }
  }
  return rows.map(stable);
}

async function writePrivateBackup(filename, payload) {
  if (!filename || !path.isAbsolute(filename)) throw refuse('An absolute private --backup path outside the checkout is required');
  const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const parent = await realpath(path.dirname(filename));
  const relative = path.relative(repository, parent);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw refuse('Backup must stay outside the source checkout and public assets');
  const destination = path.join(parent, path.basename(filename));
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  // Exclusive creation and private POSIX mode; a failed backup aborts before DML.
  for (const [file, data] of [[destination, contents], [`${destination}.sha256`, `${createHash('sha256').update(contents).digest('hex')}\n`]]) {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  }
  return destination;
}

export async function migrateInventoryConsumables(db, { apply = false, manifest: rawManifest = null, backupPath = null } = {}) {
  const manifest = rawManifest ? normalizeConsumableManifest(rawManifest) : null;
  const schema = await inspectConsumableSchema(db);
  if (!manifest) {
    if (backupPath) throw refuse('A backup option requires a reviewed manifest');
    if (apply && !schema.column_exists) await db.query(CONSUMABLE_COLUMN_SQL);
    const after = apply ? await inspectConsumableSchema(db) : schema;
    return { mode: apply ? 'schema-applied' : 'dry-run', schema_ready: after.compatible,
      schema_would_add_column: !schema.column_exists, reviewed_product_count: 0, product_flags_changed: 0, changes_database: apply && !schema.column_exists };
  }
  if (apply && !schema.compatible) throw refuse('Apply the additive column separately before applying a reviewed product manifest');
  if (!apply) {
    const rows = await reviewedRows(db, manifest, schema);
    return { mode: 'dry-run', changes_database: false, schema_ready: schema.compatible, reviewed_product_count: rows.length,
      would_change_ids: manifest.products.filter(item => item.expected.is_consumable !== item.set_is_consumable).map(item => item.product_id),
      tenant_id: manifest.tenant_id, includes_explicit_legacy_null: manifest.include_legacy_null };
  }
  await db.beginTransaction();
  try {
    const before = await reviewedRows(db, manifest, schema, true);
    const backup = await writePrivateBackup(backupPath, { version: 1, purpose: 'inventory-consumable-before-image', captured_at: new Date().toISOString(), manifest, products: before });
    const changed = [];
    for (const item of manifest.products) {
      if (item.expected.is_consumable === item.set_is_consumable) continue;
      const [result] = await db.execute('UPDATE products SET is_consumable = ?, updated_at = updated_at WHERE id = ? AND tenant_id <=> ? AND is_consumable = ?',
        [item.set_is_consumable, item.product_id, item.expected.tenant_id, item.expected.is_consumable]);
      if (result.affectedRows !== 1) throw refuse(`Concurrent product change detected for ${item.product_id}`);
      changed.push(item.product_id);
    }
    const afterManifest = { ...manifest, products: manifest.products.map(item => ({ ...item, expected: { ...item.expected, is_consumable: item.set_is_consumable } })) };
    const after = await reviewedRows(db, afterManifest, schema, true);
    for (const previous of before) {
      const current = after.find(row => Number(row.id) === Number(previous.id));
      assert.deepEqual({ ...current, is_consumable: previous.is_consumable }, previous, 'Unexpected product changes beyond is_consumable; transaction rolled back');
    }
    await db.commit();
    return { mode: 'reviewed-manifest-applied', changes_database: Boolean(changed.length), reviewed_product_count: before.length,
      changed_product_ids: changed, tenant_id: manifest.tenant_id, backup_path: backup, preserved_identity_and_business_fields: true };
  } catch (error) { await db.rollback(); throw error; }
}

export async function runInventoryConsumableMigrationCli(args) {
  const options = new Map();
  for (const argument of args) {
    const match = /^--(database|mysql-admin-socket|manifest|backup|apply)(?:=(.*))?$/.exec(argument);
    if (!match || options.has(match[1]) || (match[1] === 'apply' ? match[2] !== undefined : !match[2])) throw refuse('Unknown or duplicate migration option');
    options.set(match[1], match[2] ?? true);
  }
  const database = options.get('database'), socketPath = options.get('mysql-admin-socket');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database || '') || typeof socketPath !== 'string'
    || !(socketPath.startsWith('/') || socketPath.startsWith('\\\\.\\pipe\\'))) throw refuse('Explicit --database and local administrator socket or named pipe required; no TCP or application configuration is used');
  const manifest = options.has('manifest') ? normalizeConsumableManifest(JSON.parse(await readFile(options.get('manifest'), 'utf8'))) : null;
  if (options.has('apply') && manifest && !options.get('backup')) throw refuse('Reviewed flag apply requires a private --backup path');
  const { default: mysql } = await import('mysql2/promise');
  const connection = await mysql.createConnection({ database, socketPath, user: 'root', timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  let locked = false;
  try {
    await connection.query('SET SESSION lock_wait_timeout = 5');
    await connection.query('SET SESSION innodb_lock_wait_timeout = 5');
    await connection.query('SET SESSION max_execution_time = 10000');
    await connection.query("SET SESSION time_zone = '+00:00'");
    if (options.has('apply')) {
      const [[lock]] = await connection.query("SELECT GET_LOCK('inventory_consumables_v1', 5) AS acquired");
      if (Number(lock.acquired) !== 1) throw refuse('Consumable migration lock unavailable');
      locked = true;
    } else await connection.query('START TRANSACTION READ ONLY');
    const report = await migrateInventoryConsumables(connection, { apply: options.has('apply'), manifest, backupPath: options.get('backup') });
    if (!options.has('apply')) await connection.rollback();
    return { ok: true, ...report };
  } finally {
    try { if (locked) await connection.query("SELECT RELEASE_LOCK('inventory_consumables_v1')"); }
    finally { await connection.end(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInventoryConsumableMigrationCli(process.argv.slice(2)).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'INVENTORY_CONSUMABLE_MIGRATION_REFUSED', error: error.safe ? error.message : 'Migration refused; raw database or private product data omitted' }));
    process.exitCode = 1;
  });
}
