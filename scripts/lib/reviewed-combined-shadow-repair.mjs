// Administrator-only reviewed maintenance coordinator. Never imported by the app.
// Source installation requires a separate explicit command after stage review.
import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { REPAIR_TABLES, inspectReviewedUniqueRepair, applyReviewedUniqueRepair, inspectUnchangedOutboundReference, inspectUniqueRepairJournal } from './reviewed-unique-index-repair.mjs';
import { apply as applyLinks } from './reviewed-legacy-link-corrections.mjs';

export const COMBINED_SCOPE = Object.freeze(['online_products', 'order_status_history', 'ozon_category_mappings',
  'online_product_actions', 'outbound_records', 'ozon_stock_snapshots', 'product_barcode_label_cache',
  'sku_inventory_recipes', 'sku_mappings', 'inventory_product_requests', 'tenants', 'shops', 'products', 'orders', 'order_items']);
const REFERENCES = COMBINED_SCOPE.slice(3, 10);
const READONLY_PARENTS = COMBINED_SCOPE.slice(10);
const TARGETS = Object.keys(REPAIR_TABLES);
const JOURNAL = '_reviewed_unique_index_repairs';
const STAGE_JOURNAL = '_reviewed_combined_shadow_prepare';
const MIN_FREE = 12n * 1024n ** 3n;
const INSTALL_MIN_FREE = 9n * 1024n ** 3n;
const MAX_PREPARED_STAGE_CREDIT = 2480603136n;
const q = value => '`' + String(value).replaceAll('`', '``') + '`';
const hash = value => createHash('sha256').update(value).digest('hex');
const run = async (db, sql, args = []) => (await db.query(sql, args))[0];
const identifier = value => { if (!/^[a-zA-Z0-9_]{1,64}$/.test(value || '')) throw Error('Invalid explicit database/table identifier'); return String(value); };
const id = value => { if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('IDs outside safe JSON integer precision must be strings'); const text = String(value); if (!/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > 18446744073709551615n) throw Error('Invalid explicit row ID'); return text; };
const same = (a, b) => a?.count === b?.count && a?.sha256 === b?.sha256;
const qualified = (database, table) => `${q(database)}.${q(table)}`;
const artifact = (repair, kind, table) => `_uir_${repair}_${kind}_${table}`;
const batches = (values, count = 500) => Array.from({ length: Math.ceil(values.length / count) }, (_, index) => values.slice(index * count, index * count + count));
function validate(plan) {
  if (plan?.version !== 1 || !/^[a-f0-9]{12}$/.test(plan.repair_id || '') || !plan.reviewed_by || !plan.reason
    || plan.maintenance_confirmed !== true || plan.rollback_restores_nonunique_schema !== true) throw Error('Reviewed v1 maintenance manifest and NONUNIQUE rollback acknowledgement required');
  identifier(plan.source_database); identifier(plan.stage_database);
  if (!['production_maintenance_snapshot', 'isolated_NONUNIQUE_backup', 'isolated_fixture', 'isolated_rehearsal'].includes(plan.source_kind)) throw Error('Explicit reviewed source_kind is required');
  if (plan.stage_database !== `_uir_stage_${plan.repair_id}` || plan.source_database === plan.stage_database) throw Error('Stage database must be the exact repair-owned identity');
  if (!Array.isArray(plan.source_snapshots) || plan.source_snapshots.length !== COMBINED_SCOPE.length
    || new Set(plan.source_snapshots.map(entry => entry.table)).size !== COMBINED_SCOPE.length
    || plan.source_snapshots.some(entry => !COMBINED_SCOPE.includes(entry.table) || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !Number.isSafeInteger(entry.count) || entry.count < 0 || !entry.ddl)) throw Error('Exactly fifteen full native source table fingerprints and DDL statements are required');
  if (plan.source_snapshots.some(entry => READONLY_PARENTS.includes(entry.table) && (!entry.readonly_dependencies
    || !Array.isArray(entry.readonly_dependencies.triggers) || !Array.isArray(entry.readonly_dependencies.foreign_keys)
    || !/^[a-f0-9]{64}$/.test(entry.readonly_dependencies.sha256 || '')))) throw Error('Read-only parent dependency definitions must be captured explicitly');
  for (const nested of [plan.link_plan, plan.unique_plan]) if (!nested || !/^[a-f0-9]{12}$/.test(nested.repair_id || '') || nested.maintenance_confirmed !== true) throw Error('Reviewed link and unique plans required');
  if (new Set([plan.repair_id, plan.link_plan.repair_id, plan.unique_plan.repair_id]).size !== 3) throw Error('Outer/link/unique repair IDs must be distinct to preserve native archives');
  if (!Array.isArray(plan.unique_plan.tables) || TARGETS.some(table => !plan.unique_plan.tables.some(entry => entry.table === table))) throw Error('All three strict target tables must be reviewed');
  if (plan.link_plan.changes.some(entry => !['online_products', 'order_status_history', 'outbound_records'].includes(entry.table))) throw Error('Unaudited link correction table');
  return plan;
}
async function selected(db, database) {
  const [row] = await run(db, 'SELECT DATABASE() db,@@SESSION.unique_checks unique_checks,@@event_scheduler scheduler');
  if (row.db !== database || Number(row.unique_checks) !== 1) throw Error('Explicit database and enabled unique checks are mandatory');
  if (String(row.scheduler).toUpperCase() === 'ON') throw Error('Event scheduler must be disabled for maintenance');
}
async function metadata(db, database, table) {
  const [object] = await run(db, 'SELECT ENGINE,DATA_LENGTH,INDEX_LENGTH,AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [database, table]);
  if (object?.ENGINE !== 'InnoDB') throw Error(`Expected InnoDB source table: ${table}`);
  const columns = await run(db, 'SELECT COLUMN_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [database, table]);
  if ((TARGETS.includes(table) || REFERENCES.includes(table)) && columns.some(column => /(?:VIRTUAL|STORED) GENERATED|INVISIBLE/i.test(column.EXTRA))) throw Error(`Generated/invisible writable columns require separate review: ${table}`);
  const indexes = await run(db, 'SELECT INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX,NON_UNIQUE,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', [database, table]);
  const primary = indexes.filter(index => index.INDEX_NAME === 'PRIMARY').map(index => index.COLUMN_NAME);
  if (primary.length !== 1 || !['id', 'online_product_id'].includes(primary[0])) throw Error(`Unsupported native primary key: ${table}`);
  const triggers = await run(db, `SELECT * FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? AND EVENT_OBJECT_TABLE=? ORDER BY TRIGGER_SCHEMA,TRIGGER_NAME`, [database, table]);
  const foreign = await run(db, `SELECT * FROM information_schema.KEY_COLUMN_USAGE
    WHERE REFERENCED_TABLE_NAME IS NOT NULL AND ((TABLE_SCHEMA=? AND TABLE_NAME=?)
      OR (REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=?))
    ORDER BY TABLE_SCHEMA,TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME`, [database, table, database, table]);
  let dependencies;
  if (READONLY_PARENTS.includes(table)) {
    const definitions = [];
    for (const trigger of triggers) {
      const [definition] = await run(db, `SHOW CREATE TRIGGER ${qualified(trigger.TRIGGER_SCHEMA, trigger.TRIGGER_NAME)}`);
      const storedMetadata = { ...trigger }, storedDefinition = { ...definition };
      // Dump/restore necessarily creates the trigger again. These two server
      // creation instants are not part of its executable definition; all SQL,
      // order, definer and charset/collation context remain byte-compared.
      delete storedMetadata.CREATED; delete storedDefinition.Created;
      definitions.push({ metadata: storedMetadata, definition: storedDefinition });
    }
    const rules = new Map(), foreignDefinitions = [];
    for (const column of foreign) {
      const identity = JSON.stringify([column.CONSTRAINT_SCHEMA, column.TABLE_NAME, column.CONSTRAINT_NAME]);
      if (!rules.has(identity)) {
        const rows = await run(db, 'SELECT * FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME=? AND CONSTRAINT_NAME=?', [column.CONSTRAINT_SCHEMA, column.TABLE_NAME, column.CONSTRAINT_NAME]);
        if (rows.length !== 1) throw Error(`Read-only foreign-key rules changed during capture: ${table}`);
        rules.set(identity, rows[0]);
      }
      foreignDefinitions.push({ ...column, referential_constraint: rules.get(identity) });
    }
    const content = { triggers: definitions, foreign_keys: foreignDefinitions };
    dependencies = { ...content, sha256: hash(JSON.stringify(content)) };
  } else if (triggers.length || foreign.length) throw Error(`Triggers/FKs require separate review: ${table}`);
  const [ddl] = await run(db, `SHOW CREATE TABLE ${qualified(database, table)}`);
  return { database, table, columns: columns.map(column => column.COLUMN_NAME), insert_columns: columns.filter(column => !/(?:VIRTUAL|STORED) GENERATED/i.test(column.EXTRA)).map(column => column.COLUMN_NAME), primary: primary[0], indexes, ddl: ddl['Create Table'], auto_increment: object.AUTO_INCREMENT == null ? null : String(object.AUTO_INCREMENT), bytes: Number(object.DATA_LENGTH || 0) + Number(object.INDEX_LENGTH || 0),
    ...(dependencies ? { readonly_dependencies: dependencies } : {}) };
}
function rowHash(meta, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `SHA2(CONCAT(${meta.columns.map(column => `IF(${prefix}${q(column)} IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(${prefix}${q(column)} AS BINARY)),':',HEX(CAST(${prefix}${q(column)} AS BINARY))))`).join(',')}),256)`;
}
export async function nativeDigest(db, meta, ids = null, currentSharedRead = false) {
  const result = createHash('sha256'); let last = null; let count = 0;
  const predicate = ids === null ? '1' : ids.length ? `${q(meta.primary)} IN (${ids.map(id).join(',')})` : '0';
  while (true) {
    const rows = await run(db, `SELECT ${q(meta.primary)} row_id,${rowHash(meta)} row_hash FROM ${qualified(meta.database, meta.table)} FORCE INDEX(PRIMARY)
      WHERE ${predicate}${last === null ? '' : ` AND ${q(meta.primary)} > ?`} ORDER BY ${q(meta.primary)} LIMIT 2000${currentSharedRead ? ' FOR SHARE' : ''}`, last === null ? [] : [last]);
    for (const row of rows) { result.update(`${row.row_id}:${row.row_hash}\n`); last = String(row.row_id); count++; }
    if (rows.length < 2000) break;
  }
  return { count, sha256: result.digest('hex') };
}
function key(meta, table = meta.table) {
  const spec = REPAIR_TABLES[table]; if (!spec) return;
  const indexes = meta.indexes.filter(index => index.INDEX_NAME === spec.index);
  if (indexes.map(index => index.COLUMN_NAME).join(',') !== spec.key.join(',') || indexes.some(index => index.SUB_PART != null)) throw Error(`Unexpected natural key: ${table}`);
  return indexes;
}
async function nonunique(db, meta, logicalTable = meta.table) {
  const indexes = key(meta, logicalTable);
  if (indexes.some(index => Number(index.NON_UNIQUE) === 0)) {
    const spec = REPAIR_TABLES[logicalTable];
    await run(db, `ALTER TABLE ${qualified(meta.database, meta.table)} DROP INDEX ${q(spec.index)},ADD KEY ${q(spec.index)} (${spec.key.map(q).join(',')}),ALGORITHM=INPLACE,LOCK=EXCLUSIVE`);
  }
}
async function unknownReferences(db, database) {
  const rows = await run(db, `SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=?
    AND COLUMN_NAME IN ('online_product_id','order_status_history_id','status_history_id','category_mapping_id','ozon_category_mapping_id')`, [database]);
  for (const row of rows) {
    if (row.COLUMN_NAME !== 'online_product_id' || (!REFERENCES.includes(row.TABLE_NAME) && !/^_uir_[a-f0-9]{12}_(?:before|after)_/.test(row.TABLE_NAME))) throw Error('Unknown typed local-ID reference requires separate review');
  }
}
async function freeSpace(db) {
  const [row] = await run(db, 'SELECT @@datadir datadir');
  const space = await statfs(row.datadir, { bigint: true });
  return space.bavail * space.bsize;
}
async function lock(db, database, action) {
  const name = `unique_repair:${hash(database).slice(0, 40)}`;
  const [row] = await run(db, 'SELECT GET_LOCK(?,0) acquired', [name]); if (Number(row.acquired) !== 1) throw Error('Another unique/combined repair owns the database lock');
  try { return await action(); } finally { await run(db, 'SELECT RELEASE_LOCK(?)', [name]); }
}
async function readSource(db, plan) {
  const metas = [];
  for (const table of COMBINED_SCOPE) {
    const meta = await metadata(db, plan.source_database, table), expected = plan.source_snapshots.find(entry => entry.table === table);
    if (meta.ddl !== expected.ddl || (expected.auto_increment != null && String(expected.auto_increment) !== meta.auto_increment)) throw Error(`Reviewed source schema changed: ${table}`);
    if (JSON.stringify(meta.readonly_dependencies) !== JSON.stringify(expected.readonly_dependencies)) throw Error(`Reviewed read-only dependencies changed: ${table}`);
    if (!same(await nativeDigest(db, meta), expected)) throw Error(`Reviewed native source rows changed: ${table}`);
    key(meta); metas.push(meta);
  }
  return metas;
}
async function verifyReadonlySource(db, plan, currentSharedRead = false) {
  for (const table of READONLY_PARENTS) {
    const meta = await metadata(db, plan.source_database, table), expected = plan.source_snapshots.find(entry => entry.table === table);
    if (meta.ddl !== expected.ddl || meta.auto_increment !== expected.auto_increment
      || JSON.stringify(meta.readonly_dependencies) !== JSON.stringify(expected.readonly_dependencies)
      || !same(await nativeDigest(db, meta, null, currentSharedRead), expected)) throw Error(`Fresh locked parent data changed (including dependencies): ${table}`);
  }
}
async function availableBytes(db, options) {
  if (options.freeSpace) {
    const [server] = await run(db, 'SELECT @@skip_networking disabled,DATABASE() db');
    if (Number(server.disabled) !== 1 || !/^(?:ozon_unique_test_[a-f0-9]{16}|tenant_restore_full_review_[a-f0-9]{8})$/.test(server.db || '')) throw Error('Capacity test override is restricted to isolated random test databases');
  }
  return BigInt(await (options.freeSpace || freeSpace)(db));
}
async function inspectScope(db, input, options) {
  const plan = validate(input); await selected(db, plan.source_database); await unknownReferences(db, plan.source_database);
  const metas = await readSource(db, plan);
  const required = [MIN_FREE, BigInt(Math.ceil(metas.reduce((sum, meta) => sum + meta.bytes, 0) * 3))].reduce((a, b) => a > b ? a : b);
  const available = await availableBytes(db, options);
  const preserved = await inspectUnchangedOutboundReference(db, plan.unique_plan);
  return { repair_id: plan.repair_id, mode: 'combined-shadow', changes_source: false, scope_tables: COMBINED_SCOPE, required_free_bytes: String(required), available_free_bytes: String(available), metas,
    ...(preserved ? { unchanged_outbound_reference: preserved } : {}) };
}
export async function inspectCombined(db, input, options = {}) {
  const report = await inspectScope(db, input, options);
  if (BigInt(report.available_free_bytes) < BigInt(report.required_free_bytes)) throw Error(`Insufficient maintenance capacity: require ${report.required_free_bytes} free bytes; ${report.available_free_bytes} available`);
  return report;
}
export async function captureCombinedSource(db, database) {
  identifier(database); await selected(db, database); await unknownReferences(db, database);
  const snapshots = [];
  for (const table of COMBINED_SCOPE) {
    const meta = await metadata(db, database, table);
    snapshots.push({ table, ddl: meta.ddl, columns: meta.columns, insert_columns: meta.insert_columns, generated_columns: meta.columns.filter(column => !meta.insert_columns.includes(column)), indexes: meta.indexes, auto_increment: meta.auto_increment,
      ...(meta.readonly_dependencies ? { readonly_dependencies: meta.readonly_dependencies } : {}), ...await nativeDigest(db, meta) });
  }
  return snapshots;
}
async function stageState(db, state) {
  await run(db, `UPDATE ${qualified(state.stage_database, STAGE_JOURNAL)} SET phase=?,state_json=? WHERE repair_id=?`, [state.phase, JSON.stringify(state), state.repair_id]);
}
async function verifyPreservedOutbound(db, state, lockCurrent = false) {
  const unique = state.prepared_unique_plan || state.plan.unique_plan;
  if (!unique.unchanged_outbound_reference) return null;
  await selected(db, state.database);
  const before = await inspectUnchangedOutboundReference(db, unique, { lock: lockCurrent });
  let after;
  await run(db, `USE ${q(state.stage_database)}`);
  try { after = await inspectUnchangedOutboundReference(db, unique, { lock: lockCurrent }); }
  finally { await run(db, `USE ${q(state.database)}`); }
  if (!same(before.native_digest, after.native_digest)) throw Error('Unchanged outbound source/stage native bytes disagree');
  return { ...before, before_digest: before.native_digest, after_digest: after.native_digest, byte_unchanged: true };
}
async function sourceState(db, state) {
  await run(db, `UPDATE ${qualified(state.database, JOURNAL)} SET phase=?,state_json=? WHERE repair_id=?`, [state.phase, JSON.stringify(state), state.repair_id]);
}
async function copyTable(db, meta, stage) {
  await run(db, `CREATE TABLE ${qualified(stage, meta.table)} LIKE ${qualified(meta.database, meta.table)}`);
  const stageMeta = await metadata(db, stage, meta.table);
  if (stageMeta.readonly_dependencies && (stageMeta.readonly_dependencies.triggers.length || stageMeta.readonly_dependencies.foreign_keys.length)) throw Error(`Staging must have no read-only parent triggers or foreign keys: ${meta.table}`);
  if (Object.hasOwn(REPAIR_TABLES, meta.table)) await nonunique(db, await metadata(db, stage, meta.table));
  let last = null;
  while (true) {
    const rows = await run(db, `SELECT ${q(meta.primary)} row_id FROM ${qualified(meta.database, meta.table)} FORCE INDEX(PRIMARY) ${last === null ? '' : `WHERE ${q(meta.primary)}> ?`} ORDER BY ${q(meta.primary)} LIMIT 2000`, last === null ? [] : [last]);
    if (!rows.length) break;
    const high = String(rows.at(-1).row_id), names = meta.insert_columns.map(q).join(',');
    await run(db, `INSERT INTO ${qualified(stage, meta.table)} (${names}) SELECT ${names} FROM ${qualified(meta.database, meta.table)} FORCE INDEX(PRIMARY)
      WHERE ${last === null ? '' : `${q(meta.primary)}> ? AND `}${q(meta.primary)}<= ? ORDER BY ${q(meta.primary)}`, last === null ? [high] : [last, high]);
    last = high;
  }
  if (meta.auto_increment != null) await run(db, `ALTER TABLE ${qualified(stage, meta.table)} AUTO_INCREMENT=${id(meta.auto_increment)}`);
  if (!same(await nativeDigest(db, meta), await nativeDigest(db, { ...meta, database: stage }))) throw Error(`Stage native copy differs: ${meta.table}`);
}
async function changedRows(db, source, final) {
  const rows = await run(db, `SELECT source.${q(source.primary)} row_id FROM ${qualified(source.database, source.table)} source FORCE INDEX(PRIMARY)
    LEFT JOIN ${qualified(final.database, final.table)} final FORCE INDEX(PRIMARY) ON final.${q(source.primary)}=source.${q(source.primary)}
    WHERE final.${q(source.primary)} IS NULL OR NOT (${rowHash(source, 'source')} <=> ${rowHash(final, 'final')}) ORDER BY source.${q(source.primary)}`);
  const [added] = await run(db, `SELECT COUNT(*) n FROM ${qualified(final.database, final.table)} final FORCE INDEX(PRIMARY)
    LEFT JOIN ${qualified(source.database, source.table)} source FORCE INDEX(PRIMARY) ON source.${q(source.primary)}=final.${q(source.primary)} WHERE source.${q(source.primary)} IS NULL`);
  if (Number(added.n) !== 0) throw Error('An unaudited new reference identity was created in staging');
  return rows.map(row => id(row.row_id));
}
async function changedColumns(db, source, final, ids) {
  const changed = new Set(); let deleted = 0;
  for (const batch of batches(ids)) {
    const rows = await run(db, `SELECT source.${q(source.primary)} row_id,final.${q(source.primary)} final_id,
      ${source.columns.map(column => `NOT (CAST(source.${q(column)} AS BINARY) <=> CAST(final.${q(column)} AS BINARY)) AS ${q(column)}`).join(',')}
      FROM ${qualified(source.database, source.table)} source FORCE INDEX(PRIMARY)
      LEFT JOIN ${qualified(final.database, final.table)} final FORCE INDEX(PRIMARY) ON final.${q(source.primary)}=source.${q(source.primary)}
      WHERE source.${q(source.primary)} IN (${batch.join(',')})`);
    for (const row of rows) {
      if (row.final_id == null) { deleted++; continue; }
      for (const column of source.columns) if (Number(row[column]) === 1) changed.add(column);
    }
  }
  const allowed = source.table === 'inventory_product_requests' ? ['payload_json'] : source.table === 'outbound_records' ? ['online_product_id', 'order_item_id'] : ['online_product_id'];
  if ((deleted && source.table !== 'product_barcode_label_cache') || (source.table === 'product_barcode_label_cache' && changed.size) || [...changed].some(column => !allowed.includes(column))) throw Error('Staging changed an unaudited reference column or row');
  return { changed_columns: [...changed].sort(), deleted_rows: deleted };
}
export async function prepareCombined(db, input, options = {}) {
  const plan = validate(input); await selected(db, plan.source_database);
  if (plan.source_kind === 'production_maintenance_snapshot' && plan.production_approved !== true) throw Error('Production preparation requires explicit boolean production_approved=true after independent fresh-plan review');
  if (plan.source_kind === 'production_maintenance_snapshot' && plan.unique_plan.expected_reference_digest === 'pending_actual_stage_inspection_after_link_correction') throw Error('Production preparation requires an independently reviewed actual reference digest, never a placeholder');
  return lock(db, plan.source_database, async () => {
    const report = await inspectCombined(db, plan, options);
    if ((await run(db, 'SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [plan.stage_database])).length) throw Error('Stage already exists; inspect its journal, do not reapply');
    await run(db, `CREATE DATABASE ${q(plan.stage_database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await run(db, `CREATE TABLE ${qualified(plan.stage_database, STAGE_JOURNAL)} (repair_id CHAR(12) PRIMARY KEY,phase VARCHAR(32) NOT NULL,state_json LONGTEXT NOT NULL) ENGINE=InnoDB`);
    const state = { version: 1, mode: 'combined-shadow', repair_id: plan.repair_id, database: plan.source_database, stage_database: plan.stage_database, phase: 'preparing_stage', plan,
      initial_required_free_bytes: report.required_free_bytes, targets: [], references: [] };
    await run(db, `INSERT INTO ${qualified(plan.stage_database, STAGE_JOURNAL)} VALUES(?,?,?)`, [state.repair_id, state.phase, JSON.stringify(state)]);
    for (const meta of report.metas) { await copyTable(db, meta, plan.stage_database); await options.checkpoint?.(`copied:${meta.table}`, state); }
    await readSource(db, plan);
    await run(db, `USE ${q(plan.stage_database)}`);
    try {
      await run(db, "SET time_zone='+00:00'");
      await applyLinks(db, plan.link_plan, plan.stage_database);
      const unique = structuredClone(plan.unique_plan);
      if (unique.expected_reference_digest === 'pending_actual_stage_inspection_after_link_correction') {
        unique.expected_reference_digest = (await inspectReviewedUniqueRepair(db, unique)).expected_reference_digest;
      }
      await applyReviewedUniqueRepair(db, unique, plan.stage_database);
      state.prepared_unique_plan = unique;
    } finally { await run(db, `USE ${q(plan.source_database)}`); await run(db, "SET time_zone='+00:00'"); }
    for (const table of TARGETS) {
      const meta = await metadata(db, plan.stage_database, table);
      if (key(meta).some(index => Number(index.NON_UNIQUE) !== 0)) throw Error('Stage target has not passed real UNIQUE reconstruction');
      state.targets.push({ table, before: plan.source_snapshots.find(entry => entry.table === table), after: await nativeDigest(db, meta), after_ddl: meta.ddl,
        archive: artifact(plan.repair_id, 'old', table), undone: artifact(plan.repair_id, 'undo', table) });
    }
    for (const table of REFERENCES) {
      const before = report.metas.find(meta => meta.table === table), after = await metadata(db, plan.stage_database, table);
      const ids = await changedRows(db, before, after); if (!ids.length) continue;
      state.references.push({ table, ids, primary: before.primary, columns: before.columns, ...await changedColumns(db, before, after, ids),
        before: artifact(plan.repair_id, 'before', table), after: artifact(plan.repair_id, 'after', table),
        full_before: await nativeDigest(db, before), full_after: await nativeDigest(db, after),
        before_digest: await nativeDigest(db, before, ids), after_digest: await nativeDigest(db, after, ids), after_ddl: after.ddl });
    }
    state.unchanged_outbound_reference = await verifyPreservedOutbound(db, state);
    await readSource(db, plan); state.phase = 'prepared'; await stageState(db, state);
    return { repair_id: state.repair_id, phase: state.phase, changes_source: false, actual_prepared_reference_digest: state.prepared_unique_plan.expected_reference_digest,
      targets: state.targets.map(target => ({ table: target.table, before_rows: target.before.count, after_rows: target.after.count })),
      references: state.references.map(ref => ({ table: ref.table, row_ids: ref.ids, changed_rows: ref.ids.length, changed_columns: ref.changed_columns, deleted_rows: ref.deleted_rows, before_digest: ref.before_digest, after_digest: ref.after_digest })),
      ...(state.unchanged_outbound_reference ? { unchanged_outbound_reference: state.unchanged_outbound_reference } : {}) };
  });
}
export async function inspectCombinedJournal(db, repairId, database, stage = false) {
  if (!/^[a-f0-9]{12}$/.test(repairId || '')) throw Error('Invalid repair ID'); identifier(database);
  const journal = stage ? STAGE_JOURNAL : JOURNAL;
  const [row] = await run(db, `SELECT state_json FROM ${qualified(database, journal)} WHERE repair_id=?`, [repairId]);
  if (!row) throw Error('Combined journal missing'); const state = JSON.parse(row.state_json);
  if (state.mode !== 'combined-shadow' || state.repair_id !== repairId || state.database !== state.plan.source_database || state.stage_database !== state.plan.stage_database) throw Error('Unexpected journal identity');
  validate(state.plan); return state;
}
async function verifyPrepared(db, state) {
  if (state.phase !== 'prepared') throw Error('A fully prepared stage journal is required');
  for (const table of REFERENCES) {
    const meta = await metadata(db, state.stage_database, table);
    if (state.references.some(ref => ref.table === table)) continue;
    const expected = state.plan.source_snapshots.find(entry => entry.table === table);
    if (meta.ddl !== expected.ddl || !same(await nativeDigest(db, meta), expected)) throw Error(`Prepared unchanged reference changed: ${table}`);
  }
  for (const table of READONLY_PARENTS) {
    const meta = await metadata(db, state.stage_database, table);
    if (meta.readonly_dependencies.triggers.length || meta.readonly_dependencies.foreign_keys.length
      || !same(await nativeDigest(db, meta), state.plan.source_snapshots.find(entry => entry.table === table))) throw Error(`Prepared read-only parent changed: ${table}`);
  }
  for (const target of state.targets) {
    const meta = await metadata(db, state.stage_database, target.table);
    if (meta.ddl !== target.after_ddl || !same(await nativeDigest(db, meta), target.after) || key(meta).some(index => Number(index.NON_UNIQUE) !== 0)) throw Error('Strict prepared target changed');
  }
  for (const ref of state.references) {
    const meta = await metadata(db, state.stage_database, ref.table);
    if (meta.ddl !== ref.after_ddl || !same(await nativeDigest(db, meta), ref.full_after)) throw Error('Prepared reference changed');
  }
  await verifyPreservedOutbound(db, state);
}
async function installCapacity(db, state, report, options) {
  // Only already materialized, verified objects belonging to this repair may
  // consume the staging part of the original budget. Nothing else is credited.
  let allocated = 0n; const countedSpaces = new Set(), uncredited = [];
  const allocatedTable = async table => {
    const rows = await run(db, 'SELECT SPACE,NAME,SPACE_TYPE,FILE_SIZE,ALLOCATED_SIZE FROM information_schema.INNODB_TABLESPACES WHERE NAME=?', [`${state.stage_database}/${table}`]);
    const entry = rows[0];
    if (rows.length !== 1 || entry.NAME !== `${state.stage_database}/${table}` || String(entry.SPACE_TYPE).toLowerCase() !== 'single'
      || !/^[0-9]+$/.test(String(entry.FILE_SIZE)) || !/^[0-9]+$/.test(String(entry.ALLOCATED_SIZE)) || countedSpaces.has(String(entry.SPACE))) {
      uncredited.push(table); return 0n;
    }
    countedSpaces.add(String(entry.SPACE));
    const file = BigInt(entry.FILE_SIZE), blocks = BigInt(entry.ALLOCATED_SIZE);
    return file < blocks ? file : blocks;
  };
  for (const table of COMBINED_SCOPE) allocated += await allocatedTable(table);
  let inner;
  await run(db, `USE ${q(state.stage_database)}`);
  try { inner = await inspectUniqueRepairJournal(db, state.prepared_unique_plan.repair_id); }
  finally { await run(db, `USE ${q(state.database)}`); }
  if (inner.phase !== 'applied' || inner.database !== state.stage_database || JSON.stringify(inner.plan) !== JSON.stringify(state.prepared_unique_plan)
    || inner.targets.length !== TARGETS.length || new Set(inner.targets.map(target => target.table)).size !== TARGETS.length) throw Error('Prepared strict journal cannot substantiate staging capacity credit');
  for (const table of TARGETS) {
    const target = inner.targets.find(entry => entry.table === table);
    if (!target || target.archive !== artifact(inner.repair_id, 'old', table)) throw Error('Unaudited staging archive cannot receive capacity credit');
    const meta = await metadata(db, state.stage_database, target.archive);
    if (meta.ddl.replace(/^CREATE TABLE `[^`]+`/, `CREATE TABLE ${q(table)}`) !== target.schema_before
      || !same(await nativeDigest(db, meta), target.before)) throw Error('Prepared staging archive changed; no capacity credit');
    allocated += await allocatedTable(target.archive);
  }
  const initial = [BigInt(report.required_free_bytes), BigInt(state.initial_required_free_bytes || report.required_free_bytes)].reduce((a, b) => a > b ? a : b);
  const credit = allocated < MAX_PREPARED_STAGE_CREDIT ? allocated : MAX_PREPARED_STAGE_CREDIT;
  const remaining = initial - credit > INSTALL_MIN_FREE ? initial - credit : INSTALL_MIN_FREE;
  // Refresh df after all native/DDL checks. Earlier free space is not a promise.
  const available = await availableBytes(db, options);
  const proof = { initial_required_free_bytes: String(initial), actual_prepared_stage_allocated_bytes: String(allocated), prepared_stage_credit_cap_bytes: String(MAX_PREPARED_STAGE_CREDIT),
    credited_prepared_stage_bytes: String(credit), required_remaining_free_bytes: String(remaining), available_free_bytes: String(available),
    allocation_source: 'Distinct repair-owned Single InnoDB tablespaces; min(ALLOCATED_SIZE,FILE_SIZE); no DATA_FREE or table statistics', uncredited_stage_tables: uncredited };
  if (available < remaining) throw Error(`Insufficient installation capacity: require ${remaining} remaining free bytes; ${available} available; verified staging credit ${credit}`);
  return proof;
}
async function insertRows(db, fromDatabase, fromTable, toDatabase, toTable, meta, ids) {
  const columns = meta.columns.map(q).join(',');
  for (const batch of batches(ids)) await run(db, `INSERT INTO ${qualified(toDatabase, toTable)} (${columns}) SELECT ${columns} FROM ${qualified(fromDatabase, fromTable)} FORCE INDEX(PRIMARY) WHERE ${q(meta.primary)} IN (${batch.join(',')})`);
}
async function deleteRows(db, database, table, primary, ids) {
  for (const batch of batches(ids)) await run(db, `DELETE FROM ${qualified(database, table)} WHERE ${q(primary)} IN (${batch.join(',')})`);
}
export async function installCombined(db, input, options = {}) {
  const plan = validate(input); await selected(db, plan.source_database);
  if (plan.source_kind === 'production_maintenance_snapshot' && plan.production_approved !== true) throw Error('Production installation requires explicit boolean production_approved=true after independent fresh-plan review');
  if (plan.source_kind === 'isolated_NONUNIQUE_backup') throw Error('An isolated backup rehearsal manifest cannot authorize production/source installation');
  if (plan.source_kind === 'production_maintenance_snapshot' && !/^[a-f0-9]{64}$/.test(plan.unique_plan.expected_reference_digest || '')) throw Error('Production installation requires the reviewed actual reference digest');
  if (['isolated_fixture', 'isolated_rehearsal'].includes(plan.source_kind)) {
    const [server] = await run(db, 'SELECT @@skip_networking disabled');
    const allowed = plan.source_kind === 'isolated_fixture' ? /^ozon_unique_test_[a-f0-9]{16}$/ : /^tenant_restore_full_review_[a-f0-9]{8}$/;
    if (Number(server.disabled) !== 1 || !allowed.test(plan.source_database)) throw Error('Fixture/rehearsal installation is restricted to the isolated random test database');
  }
  return lock(db, plan.source_database, async () => {
    const report = await inspectScope(db, plan, options);
    const state = await inspectCombinedJournal(db, plan.repair_id, plan.stage_database, true);
    if (JSON.stringify(state.plan) !== JSON.stringify(plan)) throw Error('Install manifest differs from reviewed prepared manifest');
    await verifyPrepared(db, state);
    const capacity = await installCapacity(db, state, report, options);
    await run(db, `CREATE TABLE IF NOT EXISTS ${qualified(state.database, JOURNAL)} (repair_id CHAR(12) PRIMARY KEY,phase VARCHAR(32) NOT NULL,state_json LONGTEXT NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
    if ((await run(db, `SELECT repair_id FROM ${qualified(state.database, JOURNAL)} WHERE repair_id=?`, [state.repair_id])).length) throw Error('Source repair journal exists; inspect/recover it, do not reapply');
    state.phase = 'preparing'; await run(db, `INSERT INTO ${qualified(state.database, JOURNAL)} (repair_id,phase,state_json) VALUES(?,?,?)`, [state.repair_id, state.phase, JSON.stringify(state)]);
    for (const ref of state.references) {
      for (const archive of [ref.before, ref.after]) await run(db, `CREATE TABLE ${qualified(state.database, archive)} LIKE ${qualified(state.database, ref.table)}`);
    }
    await options.checkpoint?.('before_reference_transaction', state);
    await db.beginTransaction();
    try {
      // A current locking read is required here: a repeatable-read snapshot
      // created before a concurrent parent change must not hide that change.
      // These shared locks last only through this reference transaction;
      // stopping every writer remains mandatory for the later DDL/swap.
      await verifyReadonlySource(db, state.plan, true);
      await verifyPreservedOutbound(db, state, true);
      for (const ref of state.references) {
        const meta = await metadata(db, state.database, ref.table);
        for (const batch of batches(ref.ids)) await run(db, `SELECT ${q(meta.primary)} FROM ${qualified(state.database, ref.table)} FORCE INDEX(PRIMARY) WHERE ${q(meta.primary)} IN (${batch.join(',')}) FOR UPDATE`);
        if (!same(await nativeDigest(db, meta, null, true), ref.full_before)) throw Error('Reference changed before installation transaction');
        await insertRows(db, state.database, ref.table, state.database, ref.before, meta, ref.ids);
        await insertRows(db, state.stage_database, ref.table, state.database, ref.after, meta, ref.ids);
        await deleteRows(db, state.database, ref.table, meta.primary, ref.ids);
        await insertRows(db, state.stage_database, ref.table, state.database, ref.table, meta, ref.ids);
        if (!same(await nativeDigest(db, meta), ref.full_after)) throw Error('Native reference transaction differs from prepared rows');
      }
      state.unchanged_outbound_reference = await verifyPreservedOutbound(db, state, true);
      state.phase = 'references_applied'; await sourceState(db, state); await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    await options.checkpoint?.('references_applied', state);
    for (const target of state.targets) {
      const meta = await metadata(db, state.database, target.table);
      if (!same(await nativeDigest(db, meta), target.before)) throw Error('Source target changed before its archival index operation');
      await nonunique(db, meta);
      if (!same(await nativeDigest(db, await metadata(db, state.database, target.table)), target.before)) throw Error('Original native rows changed during index operation');
      await options.checkpoint?.(`archive_index:${target.table}`, state);
    }
    state.phase = 'swap_pending'; await sourceState(db, state);
    await run(db, `RENAME TABLE ${state.targets.flatMap(target => [`${qualified(state.database, target.table)} TO ${qualified(state.database, target.archive)}`, `${qualified(state.stage_database, target.table)} TO ${qualified(state.database, target.table)}`]).join(',')}`);
    await options.checkpoint?.('forward_rename_before_journal', state);
    for (const target of state.targets) if (!same(await nativeDigest(db, await metadata(db, state.database, target.table)), target.after)
      || !same(await nativeDigest(db, await metadata(db, state.database, target.archive)), target.before)) throw Error('Installed target/archive native verification failed; keep maintenance');
    await verifyReadonlySource(db, state.plan);
    if (state.unchanged_outbound_reference) await inspectUnchangedOutboundReference(db, state.plan.unique_plan);
    state.phase = 'applied'; await sourceState(db, state);
    return { repair_id: state.repair_id, phase: state.phase, complete_original_target_archives: state.targets.map(target => target.archive), reference_beforeimages: state.references.map(ref => ({ table: ref.table, rows: ref.ids.length, before: ref.before, after: ref.after })), rollback_schema_exact: false, capacity,
      ...(state.unchanged_outbound_reference ? { unchanged_outbound_reference: state.unchanged_outbound_reference } : {}) };
  });
}
export async function rollbackCombined(db, repairId, database, maintenanceConfirmed, options = {}) {
  if (maintenanceConfirmed !== true) throw Error('Explicit maintenance confirmation required for NONUNIQUE data rollback');
  await selected(db, database);
  return lock(db, database, async () => {
    const state = await inspectCombinedJournal(db, repairId, database);
    if (state.phase === 'rolled_back') throw Error('Repair already rolled back');
    await verifyReadonlySource(db, state.plan);
    await inspectUnchangedOutboundReference(db, state.plan.unique_plan);
    const exists = async table => (await run(db, 'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [database, table])).length === 1;
    const swapped = await Promise.all(state.targets.map(target => exists(target.archive)));
    const reversed = await Promise.all(state.targets.map(target => exists(target.undone)));
    if (swapped.some(Boolean) && !swapped.every(Boolean) || reversed.some(Boolean) && !reversed.every(Boolean) || swapped.some(Boolean) && reversed.some(Boolean)) throw Error('Unexpected partial rename artifacts; refuse automatic recovery');
    for (const target of state.targets) {
      if (target.archive !== artifact(repairId, 'old', target.table) || target.undone !== artifact(repairId, 'undo', target.table) || !TARGETS.includes(target.table)) throw Error('Journal target artifact changed');
      if (!same(await nativeDigest(db, await metadata(db, database, target.table)), swapped[0] ? target.after : target.before)) throw Error('Canonical target changed; automatic rollback refused');
      if (swapped[0] && !same(await nativeDigest(db, await metadata(db, database, target.archive)), target.before)) throw Error('Complete original target archive changed');
      if (reversed[0] && !same(await nativeDigest(db, await metadata(db, database, target.undone)), target.after)) throw Error('Repaired target archive changed');
    }
    const refsApplied = ['references_applied', 'swap_pending', 'applied', 'rollback_swap_pending'].includes(state.phase);
    for (const ref of state.references) {
      if (!REFERENCES.includes(ref.table) || ref.before !== artifact(repairId, 'before', ref.table) || ref.after !== artifact(repairId, 'after', ref.table)) throw Error('Journal reference artifact changed');
      const meta = await metadata(db, database, ref.table);
      if (!same(await nativeDigest(db, meta), refsApplied ? ref.full_after : ref.full_before)) throw Error('Reference table changed; rollback refused');
      if (refsApplied && (!same(await nativeDigest(db, { ...meta, table: ref.before }), ref.before_digest) || !same(await nativeDigest(db, { ...meta, table: ref.after }), ref.after_digest))) throw Error('Native reference before/after image changed');
    }
    for (const target of state.targets) await nonunique(db, await metadata(db, database, swapped[0] ? target.archive : target.table), target.table);
    if (swapped[0]) {
      state.phase = 'rollback_swap_pending'; await sourceState(db, state);
      await run(db, `RENAME TABLE ${state.targets.flatMap(target => [`${qualified(database, target.table)} TO ${qualified(database, target.undone)}`, `${qualified(database, target.archive)} TO ${qualified(database, target.table)}`]).join(',')}`);
      await options.checkpoint?.('reverse_rename_before_restore', state);
    }
    if (refsApplied) {
      await db.beginTransaction();
      try {
        for (const ref of state.references) {
          const meta = await metadata(db, database, ref.table);
          await deleteRows(db, database, ref.table, meta.primary, ref.ids);
          await insertRows(db, database, ref.before, database, ref.table, meta, ref.ids);
          if (!same(await nativeDigest(db, meta), ref.full_before)) throw Error('Native reference rollback differs from original');
        }
        state.phase = 'rolled_back'; await sourceState(db, state); await db.commit();
      } catch (error) { await db.rollback(); throw error; }
    } else { state.phase = 'rolled_back'; await sourceState(db, state); }
    await verifyReadonlySource(db, state.plan);
    await inspectUnchangedOutboundReference(db, state.plan.unique_plan);
    return { repair_id: repairId, phase: state.phase, native_original_data_restored: true, schema_exact: false, warning: 'Original contradictory rows retained with NONUNIQUE keys; do not resume normal business writers' };
  });
}

export function parseCombinedArguments(values) {
  const booleans = new Set(['prepare', 'install', 'maintenance-confirmed', 'stage']);
  const strings = new Set(['database', 'mysql-admin-socket', 'plan', 'output', 'rollback', 'journal']);
  const args = {};
  for (const value of values) {
    if (!value.startsWith('--')) throw Error('Only explicit named options are accepted');
    const at = value.indexOf('='), name = value.slice(2, at < 0 ? undefined : at);
    if (Object.hasOwn(args, name)) throw Error(`Repeated option is refused: ${name}`);
    if (booleans.has(name)) { if (at >= 0) throw Error(`Boolean option must be bare --${name}; values such as false are refused`); args[name] = true; }
    else if (strings.has(name)) { if (at < 0 || value.slice(at + 1) === '') throw Error(`Explicit nonempty value required: ${name}`); args[name] = value.slice(at + 1); }
    else throw Error(`Unknown option is refused: ${name}`);
  }
  if (['prepare', 'install', 'rollback', 'journal'].filter(name => Object.hasOwn(args, name)).length > 1) throw Error('Maintenance actions are mutually exclusive');
  if (args.stage === true && !args.journal || args['maintenance-confirmed'] === true && !args.rollback) throw Error('Action-specific option used with the wrong action');
  if (!args.database || !args['mysql-admin-socket'] || (!args.rollback && !args.journal && !args.plan)) throw Error('Explicit database, administrator socket and plan/action are required');
  return args;
}
