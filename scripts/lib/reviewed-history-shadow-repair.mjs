// Administrator-only history repair. Production writers must remain stopped.
// Only the history table is installed; parent tables are read-only evidence.
import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { REPAIR_TABLES, applyReviewedUniqueRepair, inspectReviewedUniqueRepair, inspectUniqueRepairJournal } from './reviewed-unique-index-repair.mjs';
import { apply as applyLinks } from './reviewed-legacy-link-corrections.mjs';

export const HISTORY_SCOPE = Object.freeze(['tenants', 'shops', 'orders', 'order_status_history']);
const HISTORY = 'order_status_history';
const PARENTS = HISTORY_SCOPE.slice(0, 3);
const JOURNAL = '_reviewed_history_shadow_repairs';
const SPEC = REPAIR_TABLES[HISTORY];
const KINDS = ['production_maintenance_snapshot', 'isolated_NONUNIQUE_backup', 'isolated_fixture', 'isolated_rehearsal'];
const BUDGET = ['stage_bytes', 'strict_bytes', 'link_archive_bytes', 'source_alter_bytes', 'restore_bytes', 'log_growth_bytes', 'reserve_bytes'];
const q = name => '`' + String(name).replaceAll('`', '``') + '`';
const qualified = (database, table) => `${q(database)}.${q(table)}`;
const run = async (db, sql, args = []) => (await db.query(sql, args))[0];
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => a?.count === b?.count && a?.sha256 === b?.sha256;
const identifier = value => { if (!/^[a-zA-Z0-9_]{1,64}$/.test(value || '')) throw Error('Explicit valid database identifier required'); return value; };
const id = value => { const text = String(value); if (typeof value === 'number' && !Number.isSafeInteger(value) || !/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > 18446744073709551615n) throw Error('Explicit precision-safe positive row ID required'); return text; };
const artifact = (repair, kind) => `_hir_${repair}_${kind}_${HISTORY}`;
const stageName = repair => `_uir_hist_stage_${repair}`;
const snapshotHash = snapshots => hash(JSON.stringify(snapshots));
const normalizedDdl = (ddl, table) => ddl.replace(/^CREATE TABLE `[^`]+`/, `CREATE TABLE ${q(table)}`);
function nonuniqueDdl(ddl) {
  // DROP/ADD places this one index last in SHOW CREATE TABLE. Preserve every
  // other byte; this is the exact rendering of our sole permitted DDL change.
  const lines = ddl.split('\n'), at = lines.findIndex(line => line.startsWith(`  UNIQUE KEY ${q(SPEC.index)} (`));
  if (at < 0) return ddl;
  const [original] = lines.splice(at, 1), end = lines.findIndex(line => line.startsWith(')'));
  if (end < 1) throw Error('Unexpected history DDL rendering');
  lines[end - 1] = lines[end - 1].replace(/,$/, '') + ',';
  lines.splice(end, 0, original.replace(`UNIQUE KEY ${q(SPEC.index)}`, `KEY ${q(SPEC.index)}`).replace(/,$/, ''));
  return lines.join('\n');
}
const bytes = value => { if (!/^[0-9]+$/.test(String(value))) throw Error('Measured nonnegative byte budget required'); return BigInt(value); };

function validate(plan) {
  if (plan?.version !== 1 || !/^[a-f0-9]{12}$/.test(plan.repair_id || '') || !String(plan.reviewed_by || '').trim() || !String(plan.reason || '').trim()
    || plan.maintenance_confirmed !== true || plan.rollback_restores_nonunique_schema !== true) throw Error('Reviewed history maintenance manifest and NONUNIQUE rollback acknowledgement required');
  identifier(plan.source_database); identifier(plan.stage_database);
  if (!KINDS.includes(plan.source_kind) || plan.stage_database !== stageName(plan.repair_id) || plan.stage_database === plan.source_database) throw Error('Explicit source kind and repair-owned history stage required');
  if (!Array.isArray(plan.source_snapshots) || plan.source_snapshots.length !== 4 || new Set(plan.source_snapshots.map(row => row.table)).size !== 4
    || plan.source_snapshots.some(row => !HISTORY_SCOPE.includes(row.table) || !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !Number.isSafeInteger(row.count) || row.count < 0 || !row.ddl)) throw Error('Exactly four complete native source snapshots required');
  const capture = plan.source_capture;
  if (capture?.version !== 1 || capture.source_database !== plan.source_database || capture.source_kind !== plan.source_kind || capture.maintenance_confirmed !== true
    || !Number.isFinite(Date.parse(capture.captured_at)) || Date.parse(capture.captured_at) > Date.now() + 60000
    || !String(capture.server_uuid || '').trim() || capture.scope_sha256 !== snapshotHash(plan.source_snapshots)) throw Error('Fresh maintenance capture bound to the exact source snapshots required');
  for (const table of PARENTS) {
    const row = plan.source_snapshots.find(entry => entry.table === table);
    if (!Array.isArray(row.readonly_dependencies?.triggers) || !Array.isArray(row.readonly_dependencies?.foreign_keys)
      || row.readonly_dependencies.sha256 !== hash(JSON.stringify({ triggers: row.readonly_dependencies.triggers, foreign_keys: row.readonly_dependencies.foreign_keys }))) throw Error('Complete read-only parent dependencies required');
  }
  for (const nested of [plan.link_plan, plan.unique_plan]) if (!nested || !/^[a-f0-9]{12}$/.test(nested.repair_id || '') || nested.maintenance_confirmed !== true) throw Error('Reviewed link and unique plans required');
  if (new Set([plan.repair_id, plan.link_plan.repair_id, plan.unique_plan.repair_id]).size !== 3) throw Error('Outer, link and unique repair IDs must differ');
  if (!Array.isArray(plan.link_plan.changes) || !plan.link_plan.changes.length || plan.link_plan.changes.some(change => change.table !== HISTORY || Object.keys(change.fields || {}).join(',') !== 'order_id')) throw Error('Only explicit history order_id corrections allowed');
  if (!Array.isArray(plan.unique_plan.tables) || plan.unique_plan.tables.length !== 1 || plan.unique_plan.tables[0].table !== HISTORY
    || plan.unique_plan.unchanged_outbound_reference || !/^[a-f0-9]{64}$/.test(plan.unique_plan.expected_reference_digest || '')) throw Error('Only the reviewed history unique plan and actual reference digest allowed');
  const retention = plan.retention;
  if (!retention || !Array.isArray(retention.material_group_row_ids) || !String(retention.user_confirmation_reference || '').trim() || retention.archive_originals !== true || retention.no_field_merging !== true) throw Error('Explicit complete older-row archive and no-field-merging retention decision required');
  for (const group of retention.material_group_row_ids) if (!Array.isArray(group) || group.length < 2 || new Set(group.map(id)).size !== group.length) throw Error('Explicit distinct material conflict row IDs required');
  if (!plan.capacity || !String(plan.capacity.measurement_reference || '').trim() || !Number.isFinite(Date.parse(plan.capacity.measured_at))) throw Error('Measured isolated rehearsal capacity evidence required');
  for (const field of BUDGET) bytes(plan.capacity[field]);
  if (bytes(plan.capacity.reserve_bytes) === 0n || bytes(plan.capacity.restore_bytes) === 0n) throw Error('Independent restore and operating reserves must be positive');
  return plan;
}

async function selected(db, database) {
  // Cached information_schema counters can remain NULL after an empty CREATE
  // and would make the reused strict-copy helper lose AUTO_INCREMENT.
  await run(db, 'SET SESSION information_schema_stats_expiry=0');
  const [server] = await run(db, 'SELECT DATABASE() db,@@SESSION.unique_checks unique_checks,@@event_scheduler scheduler,@@server_uuid server_uuid,@@skip_networking skip_networking');
  if (server.db !== database || Number(server.unique_checks) !== 1 || String(server.scheduler).toUpperCase() === 'ON') throw Error('Explicit database, unique_checks=1 and disabled event scheduler required');
  return server;
}
async function metadata(db, database, table) {
  const [object] = await run(db, 'SELECT ENGINE,AUTO_INCREMENT,DATA_LENGTH,INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [database, table]);
  if (object?.ENGINE !== 'InnoDB') throw Error(`Expected InnoDB table: ${table}`);
  const columns = await run(db, 'SELECT COLUMN_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [database, table]);
  const writable = table === HISTORY || /^(?:_hir_|_uir_).*order_status_history$/.test(table);
  if (writable && columns.some(column => /(?:VIRTUAL|STORED) GENERATED|INVISIBLE/i.test(column.EXTRA))) throw Error('Generated or invisible writable history columns require separate review');
  const indexes = await run(db, 'SELECT INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX,NON_UNIQUE,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', [database, table]);
  const primary = indexes.filter(index => index.INDEX_NAME === 'PRIMARY').map(index => index.COLUMN_NAME);
  if (primary.length !== 1 || primary[0] !== 'id') throw Error('Expected exact single id primary key');
  const triggers = await run(db, 'SELECT * FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? AND EVENT_OBJECT_TABLE=? ORDER BY TRIGGER_SCHEMA,TRIGGER_NAME', [database, table]);
  const foreign = await run(db, `SELECT * FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL
    AND ((TABLE_SCHEMA=? AND TABLE_NAME=?) OR (REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=?))
    ORDER BY TABLE_SCHEMA,TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME`, [database, table, database, table]);
  if (!PARENTS.includes(table) && (triggers.length || foreign.length)) throw Error('History triggers or incoming/outgoing foreign keys require separate review');
  let dependencies;
  if (PARENTS.includes(table)) {
    const definitions = [];
    for (const trigger of triggers) {
      const [definition] = await run(db, `SHOW CREATE TRIGGER ${qualified(trigger.TRIGGER_SCHEMA, trigger.TRIGGER_NAME)}`);
      const stored = { ...trigger }, ddl = { ...definition }; delete stored.CREATED; delete ddl.Created;
      definitions.push({ metadata: stored, definition: ddl });
    }
    const rules = new Map(), foreignDefinitions = [];
    for (const column of foreign) {
      const key = JSON.stringify([column.CONSTRAINT_SCHEMA, column.TABLE_NAME, column.CONSTRAINT_NAME]);
      if (!rules.has(key)) {
        const rows = await run(db, 'SELECT * FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME=? AND CONSTRAINT_NAME=?', [column.CONSTRAINT_SCHEMA, column.TABLE_NAME, column.CONSTRAINT_NAME]);
        if (rows.length !== 1) throw Error('Read-only dependency changed during capture'); rules.set(key, rows[0]);
      }
      foreignDefinitions.push({ ...column, referential_constraint: rules.get(key) });
    }
    const content = { triggers: definitions, foreign_keys: foreignDefinitions }; dependencies = { ...content, sha256: hash(JSON.stringify(content)) };
  }
  const [ddl] = await run(db, `SHOW CREATE TABLE ${qualified(database, table)}`);
  return { database, table, columns: columns.map(column => column.COLUMN_NAME), insert_columns: columns.filter(column => !/(?:VIRTUAL|STORED) GENERATED/i.test(column.EXTRA)).map(column => column.COLUMN_NAME), indexes, ddl: ddl['Create Table'], auto_increment: object.AUTO_INCREMENT == null ? null : String(object.AUTO_INCREMENT), reported_bytes: String(Number(object.DATA_LENGTH || 0) + Number(object.INDEX_LENGTH || 0)), ...(dependencies ? { readonly_dependencies: dependencies } : {}) };
}
function rowHash(meta) {
  return `SHA2(CONCAT(${meta.columns.map(column => `IF(${q(column)} IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(${q(column)} AS BINARY)),':',HEX(CAST(${q(column)} AS BINARY))))`).join(',')}),256)`;
}
async function digest(db, meta, current = false) {
  const result = createHash('sha256'); let last = null, count = 0;
  while (true) {
    const rows = await run(db, `SELECT id,${rowHash(meta)} row_hash FROM ${qualified(meta.database, meta.table)} FORCE INDEX(PRIMARY) ${last == null ? '' : 'WHERE id>?'} ORDER BY id LIMIT 2000${current ? ' FOR SHARE' : ''}`, last == null ? [] : [last]);
    for (const row of rows) { result.update(`${row.id}:${row.row_hash}\n`); last = String(row.id); count++; }
    if (rows.length < 2000) break;
  }
  return { count, sha256: result.digest('hex') };
}
function key(meta) {
  const indexes = meta.indexes.filter(index => index.INDEX_NAME === SPEC.index);
  if (indexes.map(index => index.COLUMN_NAME).join(',') !== SPEC.key.join(',') || indexes.some(index => index.SUB_PART != null)) throw Error('Unexpected history natural key');
  return indexes;
}
async function nonunique(db, meta) {
  if (key(meta).some(index => Number(index.NON_UNIQUE) === 0)) await run(db, `ALTER TABLE ${qualified(meta.database, meta.table)} DROP INDEX ${q(SPEC.index)},ADD KEY ${q(SPEC.index)} (${SPEC.key.map(q).join(',')}),ALGORITHM=INPLACE,LOCK=EXCLUSIVE`);
}
async function unknownReferences(db, database) {
  const rows = await run(db, "SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND COLUMN_NAME IN ('order_status_history_id','status_history_id')", [database]);
  if (rows.length) throw Error('Unknown typed history local-ID reference requires separate review');
}
async function lock(db, database, action) {
  const name = `unique_repair:${hash(database).slice(0, 40)}`;
  const [row] = await run(db, 'SELECT GET_LOCK(?,0) acquired', [name]); if (Number(row.acquired) !== 1) throw Error('Another history/unique repair owns the database lock');
  try { return await action(); } finally { await run(db, 'SELECT RELEASE_LOCK(?)', [name]); }
}
async function verifySource(db, plan, { parentsOnly = false, current = false } = {}) {
  const server = await selected(db, plan.source_database);
  if (server.server_uuid !== plan.source_capture.server_uuid) throw Error('Captured source server identity differs');
  await unknownReferences(db, plan.source_database);
  const metas = [];
  for (const table of parentsOnly ? PARENTS : HISTORY_SCOPE) {
    const meta = await metadata(db, plan.source_database, table), expected = plan.source_snapshots.find(row => row.table === table);
    if (meta.ddl !== expected.ddl || meta.auto_increment !== expected.auto_increment || JSON.stringify(meta.readonly_dependencies) !== JSON.stringify(expected.readonly_dependencies)
      || !same(await digest(db, meta, current), expected)) throw Error(`Reviewed native source rows/schema/dependencies changed: ${table}`);
    if (table === HISTORY) key(meta); metas.push(meta);
  }
  return metas;
}
async function isolated(db, plan) {
  if (plan.source_kind === 'production_maintenance_snapshot') return;
  const [server] = await run(db, 'SELECT @@skip_networking disabled');
  if (Number(server.disabled) !== 1 || plan.source_kind !== 'isolated_NONUNIQUE_backup' && !/^ozon_history_test_[a-f0-9]{16}$/.test(plan.source_database)) throw Error('Rehearsals require disabled TCP and an isolated explicit database');
}
async function available(db, plan, options) {
  if (options.freeSpace) {
    const [server] = await run(db, 'SELECT @@skip_networking disabled');
    if (plan.source_kind === 'production_maintenance_snapshot' || Number(server.disabled) !== 1 || !/^ozon_history_test_[a-f0-9]{16}$/.test(plan.source_database)) throw Error('Capacity override restricted to isolated random fixtures');
    return bytes(await options.freeSpace(db));
  }
  const [server] = await run(db, 'SELECT @@datadir datadir'); const value = await statfs(server.datadir, { bigint: true }); return value.bavail * value.bsize;
}
async function capacity(db, plan, options, prepared = false) {
  const required = (prepared ? ['source_alter_bytes', 'restore_bytes', 'log_growth_bytes', 'reserve_bytes'] : BUDGET).reduce((sum, field) => sum + bytes(plan.capacity[field]), 0n);
  const free = await available(db, plan, options);
  if (free < required) throw Error(`Insufficient history maintenance capacity: require ${required} free bytes; ${free} available`);
  return { required_free_bytes: String(required), available_free_bytes: String(free), measured_budget: plan.capacity, prepared_stage_credit: prepared ? 'Only verified already-materialized staging allocations; future ALTER/restore/log/reserve remain fully reserved' : 'none' };
}
async function allocated(db, meta) {
  const rows = await run(db, 'SELECT SPACE_TYPE,FILE_SIZE,ALLOCATED_SIZE FROM information_schema.INNODB_TABLESPACES WHERE NAME=?', [`${meta.database}/${meta.table}`]);
  const entry = rows[0];
  return rows.length === 1 && String(entry.SPACE_TYPE).toLowerCase() === 'single'
    ? [bytes(entry.FILE_SIZE), bytes(entry.ALLOCATED_SIZE)].reduce((a, b) => a < b ? a : b) : bytes(meta.reported_bytes);
}
async function verifyCapacityFloor(db, plan, metas) {
  // Source allocations are intentionally conservative. A stale small rehearsal
  // may not authorize a larger source; reclaim estimates are not capacity.
  let total = 0n, history = 0n;
  for (const meta of metas) {
    const physical = await allocated(db, meta);
    const floor = [physical, bytes(meta.reported_bytes)].reduce((a, b) => a > b ? a : b);
    total += floor; if (meta.table === HISTORY) history = floor;
  }
  if (bytes(plan.capacity.stage_bytes) < total || bytes(plan.capacity.strict_bytes) < history || bytes(plan.capacity.restore_bytes) < history) throw Error('Measured stage/strict/restore budgets are below the conservative current source allocation floor');
  return { source_scope_floor_bytes: String(total), history_floor_bytes: String(history) };
}
export async function captureHistorySource(db, database, { sourceKind, maintenanceConfirmed = false } = {}) {
  identifier(database);
  if (!KINDS.includes(sourceKind) || maintenanceConfirmed !== true) throw Error('Explicit source kind and stopped-writer maintenance acknowledgement required for full capture');
  const server = await selected(db, database); await unknownReferences(db, database);
  await run(db, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  try {
    const snapshots = [];
    for (const table of HISTORY_SCOPE) {
      const meta = await metadata(db, database, table); if (table === HISTORY) key(meta);
      snapshots.push({ table, ...await digest(db, meta), ddl: meta.ddl, auto_increment: meta.auto_increment, ...(meta.readonly_dependencies ? { readonly_dependencies: meta.readonly_dependencies } : {}) });
    }
    return { source_database: database, source_kind: sourceKind, source_snapshots: snapshots, source_capture: { version: 1, source_database: database, source_kind: sourceKind, captured_at: new Date().toISOString(), maintenance_confirmed: true, server_uuid: server.server_uuid, scope_sha256: snapshotHash(snapshots) }, production_approved: false };
  } finally { await db.rollback(); }
}
export async function inspectHistory(db, input, options = {}) {
  const plan = validate(input); await isolated(db, plan);
  const metas = await verifySource(db, plan);
  const floor = await verifyCapacityFloor(db, plan, metas), report = await capacity(db, plan, options);
  return { repair_id: plan.repair_id, mode: 'history-shadow', changes_source: false, scope_tables: HISTORY_SCOPE, ...report, ...floor, source_rows: metas.map(meta => ({ table: meta.table, reported_bytes: meta.reported_bytes })) };
}
function approval(plan) {
  if (plan.source_kind === 'production_maintenance_snapshot' && plan.production_approved !== true) throw Error('Production preparation/installation requires fresh explicit boolean production_approved=true');
}
async function store(db, database, state) { await run(db, `UPDATE ${qualified(database, JOURNAL)} SET phase=?,state_json=? WHERE repair_id=?`, [state.phase, JSON.stringify(state), state.repair_id]); }
async function createJournal(db, database) { await run(db, `CREATE TABLE IF NOT EXISTS ${qualified(database, JOURNAL)} (repair_id CHAR(12) PRIMARY KEY,phase VARCHAR(32) NOT NULL,state_json LONGTEXT NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`); }
export async function inspectHistoryJournal(db, repairId, database, stage = false) {
  if (!/^[a-f0-9]{12}$/.test(repairId || '')) throw Error('Explicit valid repair ID required'); identifier(database);
  const [row] = await run(db, `SELECT state_json FROM ${qualified(database, JOURNAL)} WHERE repair_id=?`, [repairId]);
  if (!row) throw Error('History repair journal not found');
  const state = JSON.parse(row.state_json);
  if (state.mode !== 'history-shadow' || state.repair_id !== repairId || (stage ? state.stage_database : state.database) !== database) throw Error('History journal identity mismatch');
  validate(state.plan);
  if (state.database !== state.plan.source_database || state.stage_database !== state.plan.stage_database || state.stage_database !== stageName(repairId)
    || state.archive !== artifact(repairId, 'old') || state.undone !== artifact(repairId, 'undo')) throw Error('Stored history journal escapes its exact reviewed source/stage/artifact identities');
  return state;
}
async function copy(db, meta, stage) {
  await run(db, `CREATE TABLE ${qualified(stage, meta.table)} LIKE ${qualified(meta.database, meta.table)}`);
  if (meta.table === HISTORY) await nonunique(db, await metadata(db, stage, HISTORY));
  const names = meta.insert_columns.map(q).join(','); let last = null;
  while (true) {
    const rows = await run(db, `SELECT id FROM ${qualified(meta.database, meta.table)} FORCE INDEX(PRIMARY) ${last == null ? '' : 'WHERE id>?'} ORDER BY id LIMIT 2000`, last == null ? [] : [last]);
    if (!rows.length) break;
    const end = String(rows.at(-1).id);
    await run(db, `INSERT INTO ${qualified(stage, meta.table)} (${names}) SELECT ${names} FROM ${qualified(meta.database, meta.table)} FORCE INDEX(PRIMARY) WHERE id<=?${last == null ? '' : ' AND id>?'}`, last == null ? [end] : [end, last]); last = end;
  }
  if (meta.auto_increment != null) await run(db, `ALTER TABLE ${qualified(stage, meta.table)} AUTO_INCREMENT=${id(meta.auto_increment)}`);
  if (!same(await digest(db, await metadata(db, stage, meta.table)), await digest(db, meta))) throw Error('Staging copy is not native-data exact');
}
function materialKey(values) { return values.map(id).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).join(','); }
async function retentionCheck(db, plan, report) {
  const actual = report.tables[0].groups.filter(group => group.differing_columns.some(column => !['observed_at', 'created_at'].includes(column)));
  const expected = plan.retention.material_group_row_ids.map(materialKey).sort();
  if (JSON.stringify(actual.map(group => materialKey(group.row_ids)).sort()) !== JSON.stringify(expected)) throw Error('Material conflict groups differ from reviewed retention decision');
  for (const group of actual) {
    const [latest] = await run(db, `SELECT id FROM ${q(HISTORY)} FORCE INDEX(PRIMARY) WHERE id IN (${group.row_ids.map(id).join(',')}) ORDER BY observed_at DESC,id DESC LIMIT 1`);
    if (String(latest.id) !== String(group.keeper_id)) throw Error('Material conflicts must keep the latest observed_at/id whole row');
  }
}
export async function prepareHistory(db, input, options = {}) {
  const plan = validate(input); approval(plan); await isolated(db, plan);
  return lock(db, plan.source_database, async () => {
    const preflight = await inspectHistory(db, plan, options), metas = await verifySource(db, plan);
    if ((await run(db, 'SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [plan.stage_database])).length) throw Error('History stage exists; inspect rather than reapply');
    await run(db, `CREATE DATABASE ${q(plan.stage_database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); await createJournal(db, plan.stage_database);
    const state = { version: 1, mode: 'history-shadow', repair_id: plan.repair_id, database: plan.source_database, stage_database: plan.stage_database, phase: 'preparing_stage', plan, initial_capacity: preflight, archive: artifact(plan.repair_id, 'old'), undone: artifact(plan.repair_id, 'undo') };
    await run(db, `INSERT INTO ${qualified(plan.stage_database, JOURNAL)} (repair_id,phase,state_json) VALUES(?,?,?)`, [state.repair_id, state.phase, JSON.stringify(state)]);
    for (const meta of metas) await copy(db, meta, plan.stage_database);
    state.stage_parents = [];
    for (const table of PARENTS) { const meta = await metadata(db, plan.stage_database, table); state.stage_parents.push({ table, ddl: meta.ddl, auto_increment: meta.auto_increment, ...await digest(db, meta) }); }
    await store(db, plan.stage_database, state);
    await verifySource(db, plan); await options.checkpoint?.('stage_copied', state);
    await run(db, `USE ${q(plan.stage_database)}`);
    try {
      await applyLinks(db, structuredClone(plan.link_plan), plan.stage_database); await options.checkpoint?.('stage_links_applied', state);
      const report = await inspectReviewedUniqueRepair(db, plan.unique_plan); await retentionCheck(db, plan, report);
      await applyReviewedUniqueRepair(db, plan.unique_plan, plan.stage_database); await options.checkpoint?.('stage_strict_applied', state);
      const inner = await inspectUniqueRepairJournal(db, plan.unique_plan.repair_id);
      state.inner = { archive: inner.targets[0].archive, before: inner.targets[0].before, after: inner.targets[0].after, schema_before: inner.targets[0].schema_before };
      const strict = await metadata(db, plan.stage_database, HISTORY), strictBytes = await allocated(db, strict);
      if (bytes(plan.capacity.strict_bytes) < strictBytes * 2n) throw Error('Strict budget must cover the materialized strict table plus its full compaction copy');
      const remaining = ['source_alter_bytes', 'restore_bytes', 'log_growth_bytes', 'reserve_bytes'].reduce((sum, field) => sum + bytes(plan.capacity[field]), strictBytes);
      if (await available(db, plan, options) < remaining) throw Error('Insufficient free space for stage compaction and reserved installation/restore budget');
      await run(db, `ALTER TABLE ${qualified(plan.stage_database, HISTORY)} FORCE`);
      const compact = await metadata(db, plan.stage_database, HISTORY);
      if (compact.ddl !== strict.ddl || compact.auto_increment !== strict.auto_increment || !same(await digest(db, compact), inner.targets[0].after)) throw Error('Stage compaction changed strict schema, counter or native retained rows');
      state.compaction = { before_allocated_bytes: String(strictBytes), after_allocated_bytes: String(await allocated(db, compact)), native_rows_unchanged: true };
      await options.checkpoint?.('stage_compacted', state);
    } finally { await run(db, `USE ${q(plan.source_database)}`); }
    const final = await metadata(db, plan.stage_database, HISTORY);
    state.after = await digest(db, final); state.after_ddl = final.ddl; state.after_auto_increment = final.auto_increment;
    await verifySource(db, plan); state.phase = 'prepared'; await verifyPrepared(db, state); await store(db, plan.stage_database, state);
    return { repair_id: state.repair_id, phase: state.phase, changes_source: false, before_rows: plan.source_snapshots.find(row => row.table === HISTORY).count, after_rows: state.after.count, complete_corrected_stage_archive: state.inner.archive, retained_material_groups: plan.retention.material_group_row_ids.length, compaction: state.compaction };
  });
}
async function verifyPrepared(db, state) {
  if (state.phase !== 'prepared') throw Error('Fully prepared history stage required');
  if (!Array.isArray(state.stage_parents) || state.stage_parents.length !== PARENTS.length || new Set(state.stage_parents.map(row => row.table)).size !== PARENTS.length
    || state.stage_parents.some(row => !PARENTS.includes(row.table)) || state.inner?.archive !== `_uir_${state.plan.unique_plan.repair_id}_old_${HISTORY}`) throw Error('Exact prepared parent set and strict history archive identity required');
  for (const expected of state.stage_parents) {
    const meta = await metadata(db, state.stage_database, expected.table);
    if (meta.ddl !== expected.ddl || meta.auto_increment !== expected.auto_increment || meta.readonly_dependencies.triggers.length || meta.readonly_dependencies.foreign_keys.length || !same(await digest(db, meta), expected)
      || !same(expected, state.plan.source_snapshots.find(row => row.table === expected.table))) throw Error('Read-only staging parent changed');
  }
  const final = await metadata(db, state.stage_database, HISTORY);
  if (final.ddl !== state.after_ddl || final.auto_increment !== state.after_auto_increment || !same(await digest(db, final), state.after) || key(final).some(index => Number(index.NON_UNIQUE) !== 0)) throw Error('Prepared strict history table changed');
  await run(db, `USE ${q(state.stage_database)}`);
  try {
    const inner = await inspectUniqueRepairJournal(db, state.plan.unique_plan.repair_id);
    if (inner.phase !== 'applied' || inner.targets.length !== 1 || inner.targets[0].table !== HISTORY || JSON.stringify(inner.plan) !== JSON.stringify(state.plan.unique_plan)
      || inner.targets[0].archive !== state.inner.archive || !same(inner.targets[0].before, state.inner.before) || !same(inner.targets[0].after, state.after)) throw Error('Prepared strict history journal changed');
  } finally { await run(db, `USE ${q(state.database)}`); }
  const archived = await metadata(db, state.stage_database, state.inner.archive);
  if (normalizedDdl(archived.ddl, HISTORY) !== state.inner.schema_before || !same(await digest(db, archived), state.inner.before)) throw Error('Complete corrected original staging archive changed');
  await verifyLinkArchives(db, state);
}
async function verifyLinkArchives(db, state) {
  const [journal] = await run(db, `SELECT phase,state_json FROM ${qualified(state.stage_database, '_reviewed_legacy_link_repairs')} WHERE repair_id=?`, [state.plan.link_plan.repair_id]);
  if (!journal || journal.phase !== 'applied') throw Error('Applied complete history link journal required');
  const links = JSON.parse(journal.state_json), expectedPlan = structuredClone(state.plan.link_plan);
  for (const change of expectedPlan.changes) { change.id = id(change.id); change.fields.order_id.after = id(change.fields.order_id.after); }
  if (links.phase !== 'applied' || links.database !== state.stage_database || links.repair_id !== expectedPlan.repair_id || JSON.stringify(links.plan) !== JSON.stringify(expectedPlan)
    || !Array.isArray(links.tables) || links.tables.length !== 1 || links.tables[0].table !== HISTORY) throw Error('Prepared history link journal differs from reviewed plan');
  const entry = links.tables[0], changes = expectedPlan.changes, ids = changes.map(change => change.id), sorted = values => values.map(id).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  if (entry.before !== `_uir_${expectedPlan.repair_id}_before_${HISTORY}` || entry.after !== `_uir_${expectedPlan.repair_id}_after_${HISTORY}`
    || JSON.stringify(sorted(entry.ids || [])) !== JSON.stringify(sorted(ids)) || Object.keys(entry.before_hashes || {}).length !== ids.length || Object.keys(entry.after_hashes || {}).length !== ids.length) throw Error('Complete link image identity or ID set changed');
  const before = await metadata(db, state.stage_database, entry.before), after = await metadata(db, state.stage_database, entry.after), corrected = await metadata(db, state.stage_database, state.inner.archive);
  if (JSON.stringify(before.columns) !== JSON.stringify(corrected.columns) || JSON.stringify(after.columns) !== JSON.stringify(corrected.columns)
    || (await digest(db, before)).count !== ids.length || (await digest(db, after)).count !== ids.length) throw Error('Complete link image schema/count changed');
  for (let offset = 0; offset < ids.length; offset += 300) {
    const batch = ids.slice(offset, offset + 300), args = batch.map(id).join(',');
    const nativeRows = async meta => run(db, `SELECT id,${rowHash(meta)} row_hash FROM ${qualified(meta.database, meta.table)} FORCE INDEX(PRIMARY) WHERE id IN (${args})`);
    const beforeRows = new Map((await nativeRows(before)).map(row => [String(row.id), row.row_hash]));
    const afterRows = new Map((await nativeRows(after)).map(row => [String(row.id), row.row_hash]));
    const correctedRows = new Map((await nativeRows(corrected)).map(row => [String(row.id), row.row_hash]));
    for (const rowId of batch) {
      const change = changes.find(row => row.id === rowId);
      if (beforeRows.get(rowId) !== change.expected_full_row_sha256 || beforeRows.get(rowId) !== entry.before_hashes[rowId]
        || !afterRows.get(rowId) || afterRows.get(rowId) !== entry.after_hashes[rowId] || afterRows.get(rowId) !== correctedRows.get(rowId)) throw Error('Complete native link before/after evidence changed');
    }
    const expectedOrder = alias => `CASE ${alias}.id ${batch.map(rowId => `WHEN ${rowId} THEN ${id(changes.find(row => row.id === rowId).fields.order_id[alias === 'a' ? 'before' : 'after'])}`).join(' ')} END`;
    const columnsEqual = corrected.columns.filter(column => column !== 'order_id').map(column => `(CAST(a.${q(column)} AS BINARY)<=>CAST(b.${q(column)} AS BINARY))`).join(' AND ');
    const [check] = await run(db, `SELECT COUNT(*) count FROM ${qualified(before.database, before.table)} a FORCE INDEX(PRIMARY)
      JOIN ${qualified(after.database, after.table)} b FORCE INDEX(PRIMARY) ON b.id=a.id WHERE a.id IN (${args})
      AND ${columnsEqual} AND a.order_id=${expectedOrder('a')} AND b.order_id=${expectedOrder('b')}`);
    if (Number(check.count) !== batch.length) throw Error('Link image projection changed a field other than the reviewed order_id');
  }
}
export async function installHistory(db, input, options = {}) {
  const plan = validate(input); approval(plan); await isolated(db, plan);
  if (plan.source_kind === 'isolated_NONUNIQUE_backup') throw Error('A backup rehearsal cannot install against its source');
  return lock(db, plan.source_database, async () => {
    const sourceMetas = await verifySource(db, plan); await verifyCapacityFloor(db, plan, sourceMetas);
    const state = await inspectHistoryJournal(db, plan.repair_id, plan.stage_database, true);
    if (JSON.stringify(state.plan) !== JSON.stringify(plan)) throw Error('Install manifest differs from exact reviewed preparation');
    await verifyPrepared(db, state); const proof = await capacity(db, plan, options, true);
    await createJournal(db, state.database);
    if ((await run(db, `SELECT repair_id FROM ${qualified(state.database, JOURNAL)} WHERE repair_id=?`, [state.repair_id])).length) throw Error('Source journal exists; inspect/recover instead of reapplying');
    state.phase = 'preparing'; await run(db, `INSERT INTO ${qualified(state.database, JOURNAL)} (repair_id,phase,state_json) VALUES(?,?,?)`, [state.repair_id, state.phase, JSON.stringify(state)]);
    await options.checkpoint?.('before_source_index', state);
    await db.beginTransaction();
    try { await verifySource(db, plan, { current: true }); await db.commit(); } catch (error) { await db.rollback(); throw error; }
    const original = await metadata(db, state.database, HISTORY); await nonunique(db, original);
    state.before_nonunique_ddl = (await metadata(db, state.database, HISTORY)).ddl;
    if (state.before_nonunique_ddl !== nonuniqueDdl(plan.source_snapshots.find(row => row.table === HISTORY).ddl)) throw Error('Archive index conversion changed unexpected source schema');
    await store(db, state.database, state);
    if (!same(await digest(db, await metadata(db, state.database, HISTORY)), plan.source_snapshots.find(row => row.table === HISTORY))) throw Error('Original native history changed during archive index conversion');
    await options.checkpoint?.('archive_index_prepared', state);
    await verifySource(db, plan, { parentsOnly: true });
    const beforeSwap = await metadata(db, state.database, HISTORY);
    if (beforeSwap.ddl !== nonuniqueDdl(plan.source_snapshots.find(row => row.table === HISTORY).ddl)
      || !same(await digest(db, beforeSwap), plan.source_snapshots.find(row => row.table === HISTORY))) throw Error('Original history changed before atomic installation');
    await verifyPrepared(db, { ...state, phase: 'prepared' });
    state.phase = 'swap_pending'; await store(db, state.database, state);
    await run(db, `RENAME TABLE ${qualified(state.database, HISTORY)} TO ${qualified(state.database, state.archive)},${qualified(state.stage_database, HISTORY)} TO ${qualified(state.database, HISTORY)}`);
    await options.checkpoint?.('forward_rename_before_journal', state);
    await verifyInstalled(db, state); state.phase = 'applied'; await store(db, state.database, state);
    return { repair_id: state.repair_id, phase: state.phase, changes_source: true, complete_original_archive: state.archive, complete_corrected_stage_archive: state.inner.archive, original_rows: plan.source_snapshots.find(row => row.table === HISTORY).count, canonical_rows: state.after.count, rollback_schema_exact: false, capacity: proof, cleanup_performed: false };
  });
}
async function verifyInstalled(db, state) {
  const current = await metadata(db, state.database, HISTORY), archive = await metadata(db, state.database, state.archive);
  if (current.ddl !== state.after_ddl || current.auto_increment !== state.after_auto_increment || key(current).some(index => Number(index.NON_UNIQUE) !== 0) || !same(await digest(db, current), state.after)
    || normalizedDdl(archive.ddl, HISTORY) !== state.before_nonunique_ddl || !same(await digest(db, archive), state.plan.source_snapshots.find(row => row.table === HISTORY))) throw Error('Installed history or original archive changed; keep maintenance');
  await verifySource(db, state.plan, { parentsOnly: true });
}
export async function rollbackHistory(db, repairId, database, maintenanceConfirmed, options = {}) {
  if (maintenanceConfirmed !== true) throw Error('Explicit maintenance required for original-data NONUNIQUE rollback'); await selected(db, database);
  return lock(db, database, async () => {
    const state = await inspectHistoryJournal(db, repairId, database);
    if (state.phase === 'rolled_back' || state.archive !== artifact(repairId, 'old') || state.undone !== artifact(repairId, 'undo')) throw Error('Invalid rollback phase or artifact identity');
    await verifySource(db, state.plan, { parentsOnly: true });
    const exists = async table => (await run(db, 'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [database, table])).length === 1;
    const swapped = await exists(state.archive), reversed = await exists(state.undone);
    if (swapped && reversed) throw Error('Unexpected simultaneous forward/reverse archive artifacts');
    const before = state.plan.source_snapshots.find(row => row.table === HISTORY), current = await metadata(db, database, HISTORY);
    if (!same(await digest(db, current), swapped ? state.after : before)) throw Error('Canonical history changed; automatic rollback refused');
    if (current.ddl !== (swapped ? state.after_ddl : before.ddl) && current.ddl !== nonuniqueDdl(before.ddl)) throw Error('Canonical history schema changed; automatic rollback refused');
    if (swapped) {
      await verifyInstalled(db, state);
      state.phase = 'rollback_swap_pending'; await store(db, database, state);
      await run(db, `RENAME TABLE ${qualified(database, HISTORY)} TO ${qualified(database, state.undone)},${qualified(database, state.archive)} TO ${qualified(database, HISTORY)}`);
      await options.checkpoint?.('reverse_rename_before_journal', state);
    } else {
      if (reversed) {
        const undone = await metadata(db, database, state.undone);
        if (normalizedDdl(undone.ddl, HISTORY) !== state.after_ddl || !same(await digest(db, undone), state.after)) throw Error('Repaired undo archive changed');
      }
      await nonunique(db, current);
    }
    const restored = await metadata(db, database, HISTORY);
    if (!same(await digest(db, restored), before) || key(restored).some(index => Number(index.NON_UNIQUE) === 0)) throw Error('Original history data restoration failed');
    await verifySource(db, state.plan, { parentsOnly: true }); state.phase = 'rolled_back'; await store(db, database, state);
    return { repair_id: repairId, phase: state.phase, native_original_data_restored: true, schema_exact: false, warning: 'Original data restored with NONUNIQUE keys; keep normal business writers stopped' };
  });
}

export function parseHistoryArguments(values) {
  const booleans = new Set(['capture', 'prepare', 'install', 'maintenance-confirmed', 'stage']);
  const strings = new Set(['database', 'mysql-admin-socket', 'plan', 'output', 'source-kind', 'rollback', 'journal']); const args = {};
  for (const value of values) {
    if (!value.startsWith('--')) throw Error('Only explicit named options accepted'); const at = value.indexOf('='), name = value.slice(2, at < 0 ? undefined : at);
    if (Object.hasOwn(args, name)) throw Error(`Repeated option: ${name}`);
    if (booleans.has(name)) { if (at >= 0) throw Error(`Boolean option must be bare --${name}`); args[name] = true; }
    else if (strings.has(name)) { if (at < 0 || !value.slice(at + 1)) throw Error(`Explicit nonempty value required: ${name}`); args[name] = value.slice(at + 1); }
    else throw Error(`Unknown option: ${name}`);
  }
  if (['capture', 'prepare', 'install', 'rollback', 'journal'].filter(name => Object.hasOwn(args, name)).length > 1) throw Error('Maintenance actions are mutually exclusive');
  if (!args.database || !args['mysql-admin-socket'] || !args.capture && !args.rollback && !args.journal && !args.plan) throw Error('Explicit database/socket and plan/action required');
  if (args.stage && !args.journal || args['source-kind'] && !args.capture || args['maintenance-confirmed'] && !args.capture && !args.rollback) throw Error('Action-specific option used with wrong action');
  if (args.capture && (!KINDS.includes(args['source-kind']) || !args.output || !args['maintenance-confirmed'])) throw Error('Capture requires explicit source-kind, new output and maintenance confirmation');
  if ((args.rollback || args.journal) && args.plan) throw Error('Journal/rollback uses its stored manifest, not a new plan');
  return args;
}
