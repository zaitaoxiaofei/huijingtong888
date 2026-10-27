import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { apply as applyLinks } from '../scripts/lib/reviewed-legacy-link-corrections.mjs';
import { inspectReviewedUniqueRepair } from '../scripts/lib/reviewed-unique-index-repair.mjs';
import { HISTORY_SCOPE, captureHistorySource, inspectHistory, prepareHistory, installHistory, inspectHistoryJournal, rollbackHistory, parseHistoryArguments } from '../scripts/lib/reviewed-history-shadow-repair.mjs';

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const execute = promisify(execFile);
const options = { skip: !socketPath };
const q = value => '`' + String(value).replaceAll('`', '``') + '`';
const nonce = () => randomBytes(6).toString('hex');
const space = { freeSpace: async () => 1024n ** 4n };
const schema = await readFile(new URL('../scripts/init-mysql-schema.mjs', import.meta.url), 'utf8');
const historyDdl = schema.match(/CREATE TABLE IF NOT EXISTS order_status_history \([\s\S]*?\) ENGINE=InnoDB[^;]*;/)[0];
const rows = (query, table = 'order_status_history') => query(`SELECT * FROM ${q(table)} FORCE INDEX(PRIMARY) ORDER BY id`);
const sameNative = (a, b) => assert.deepEqual(a.source_snapshots.map(({ table, count, sha256 }) => ({ table, count, sha256 })), b.source_snapshots.map(({ table, count, sha256 }) => ({ table, count, sha256 })));
const capture = (db, database, sourceKind = 'isolated_fixture') => captureHistorySource(db, database, { sourceKind, maintenanceConfirmed: true });
async function rowHash(query, table, rowId) {
  const columns = (await query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])).map(row => row.COLUMN_NAME);
  const expression = `SHA2(CONCAT(${columns.map(column => `IF(${q(column)} IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(${q(column)} AS BINARY)),':',HEX(CAST(${q(column)} AS BINARY))))`).join(',')}),256)`;
  return (await query(`SELECT ${expression} sha256 FROM ${q(table)} FORCE INDEX(PRIMARY) WHERE id=?`, [rowId]))[0].sha256;
}
async function scenario(action, { generatedParent = false } = {}) {
  const db = await mysql.createConnection({ socketPath, user: 'root', multipleStatements: true, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true });
  const database = `ozon_history_test_${randomBytes(8).toString('hex')}`, repairId = nonce(), stage = `_uir_hist_stage_${repairId}`, review = `_hir_review_${repairId}`;
  const query = async (text, values = []) => (await db.query(text, values))[0];
  let created = false;
  try {
    const [server] = await query('SELECT @@skip_networking disabled,@@event_scheduler events,@@log_bin binlog');
    assert.equal(Number(server.disabled), 1); assert.equal(server.events, 'OFF'); assert.equal(Number(server.binlog), 0);
    await query(`CREATE DATABASE ${q(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); created = true;
    await db.changeUser({ database }); await query("SET time_zone='+00:00';SET SESSION unique_checks=1;SET SESSION max_execution_time=10000");
    await query("CREATE TABLE tenants(id BIGINT UNSIGNED PRIMARY KEY,slug VARCHAR(64) UNIQUE) ENGINE=InnoDB;INSERT INTO tenants VALUES(1,'default'),(2,'customer');CREATE TABLE shops(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED NULL,status VARCHAR(32)) ENGINE=InnoDB;INSERT INTO shops VALUES(10,NULL,'active'),(20,2,'active');CREATE TABLE orders(id BIGINT UNSIGNED PRIMARY KEY,shop_id BIGINT UNSIGNED NOT NULL,posting_number VARCHAR(128) NOT NULL) ENGINE=InnoDB;INSERT INTO orders VALUES(1000,10,'synthetic-A'),(1001,10,'synthetic-B'),(2000,20,'synthetic-other')");
    if (generatedParent) await query('ALTER TABLE orders ADD owned_shop BIGINT GENERATED ALWAYS AS (shop_id) STORED');
    await query(historyDdl);
    const base = { order_id:1000, shop_id:10, posting_number:'synthetic-A', order_number:'synthetic-order-A', status:'delivered', substatus:'signed', logistics_status:'delivered', tracking_stage:'posting_delivered', sync_state:'final', ordered_at:'2025-01-01 00:00:00', delivered_at:'2025-01-05 12:00:00', last_status_changed_at:'2025-01-05 11:00:00', customer_id:'synthetic-customer', customer_name:'synthetic-name', buyer_city:'synthetic-city', buyer_region:'synthetic-region', buyer_country:'synthetic-country', buyer_district:'synthetic-district', buyer_zip_code:'000000', buyer_address_tail:'synthetic-tail', delivery_type:'synthetic-delivery', delivery_city:'synthetic-city', delivery_region:'synthetic-region', delivery_date_begin:'2025-01-04 00:00:00', delivery_date_end:'2025-01-06 00:00:00', warehouse_name:'synthetic-warehouse', tpl_provider:'synthetic-provider', cluster_to:'synthetic-cluster', snapshot_source:'backfill', observed_at:'2025-01-05 12:00:01', observed_hour:'2025-01-05 12:00:00', raw_status_json:JSON.stringify({ synthetic:'evidence', payload:'x'.repeat(32768) }), created_at:'2025-01-05 12:00:01' };
    await query('INSERT INTO order_status_history SET ?', { id:31, ...base, order_id:1001 });
    await query('INSERT INTO order_status_history SET ?', { id:32, ...base, customer_name:'synthetic-latest-name', observed_at:'2025-01-05 12:00:02', created_at:'2025-01-05 12:00:02' });
    await query('INSERT INTO order_status_history SET ?', { id:51, ...base, order_id:1001, observed_hour:'2025-01-05 13:00:00', observed_at:'2025-01-05 13:00:01' });
    await query('INSERT INTO order_status_history SET ?', { id:52, ...base, observed_hour:'2025-01-05 13:00:00', observed_at:'2025-01-05 13:00:02', created_at:'2025-01-05 13:00:02' });
    await query('ALTER TABLE order_status_history AUTO_INCREMENT=999');
    const before = await capture(db, database);
    const plan = { ...before, version:1, repair_id:repairId, stage_database:stage, reviewed_by:'isolated test reviewer', reason:'Reviewed single history-table parent correction and strict reconstruction', maintenance_confirmed:true, rollback_restores_nonunique_schema:true,
      link_plan:{ version:1, repair_id:nonce(), reviewed_by:'isolated test reviewer', reason:'Exact original shop/posting parent corrections', maintenance_confirmed:true, changes:[] },
      unique_plan:{ version:1, repair_id:nonce(), reviewed_by:'isolated test reviewer', reason:'Explicit hourly state keepers', maintenance_confirmed:true, rollback_restores_nonunique_schema:true, tables:[{ table:'order_status_history', groups:[{ row_ids:[31,32], keeper_id:32 }, { row_ids:[51,52], keeper_id:52 }] }] },
      retention:{ material_group_row_ids:[[31,32]], user_confirmation_reference:'Fixture user: latest whole row online, older complete row archived for recovery and traceability', archive_originals:true, no_field_merging:true },
      capacity:{ measurement_reference:'Synthetic fixture capacity, not a production sizing estimate', measured_at:new Date().toISOString(), stage_bytes:'67108864', strict_bytes:'67108864', link_archive_bytes:'67108864', source_alter_bytes:'67108864', restore_bytes:'67108864', log_growth_bytes:'67108864', reserve_bytes:'67108864' }
    };
    for (const rowId of [31,51]) plan.link_plan.changes.push({ table:'order_status_history', id:rowId, original_shop_id:10, expected_tenant_id:1, expected_full_row_sha256:await rowHash(query,'order_status_history',rowId), fields:{ order_id:{ before:1001, after:1000 } } });
    await query(`CREATE DATABASE ${q(review)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    for (const table of HISTORY_SCOPE) {
      const columns = (await query('SELECT COLUMN_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[database,table])).filter(row => !/(?:STORED|VIRTUAL) GENERATED/i.test(row.EXTRA)).map(row => q(row.COLUMN_NAME)).join(',');
      await query(`CREATE TABLE ${q(review)}.${q(table)} LIKE ${q(database)}.${q(table)}`);
      if (table === 'order_status_history') await query(`ALTER TABLE ${q(review)}.${q(table)} DROP INDEX uk_order_status_history_hour_state,ADD KEY uk_order_status_history_hour_state(order_id,observed_hour,status,logistics_status,tracking_stage,sync_state)`);
      await query(`INSERT INTO ${q(review)}.${q(table)} (${columns}) SELECT ${columns} FROM ${q(database)}.${q(table)} FORCE INDEX(PRIMARY)`);
    }
    await query(`USE ${q(review)}`); await applyLinks(db,structuredClone(plan.link_plan),review);
    const audited = await inspectReviewedUniqueRepair(db,plan.unique_plan); assert.equal(audited.conflicts.length,0);
    plan.unique_plan.expected_reference_digest = audited.expected_reference_digest;
    for (const group of plan.unique_plan.tables[0].groups) { const found = audited.tables[0].groups.find(row => row.row_ids.includes(String(group.keeper_id))); group.expected_hashes=found.expected_hashes; group.accepted_differing_columns=found.differing_columns; }
    await query(`USE ${q(database)}`);
    await action({ db,database,query,plan,before,base });
  } finally {
    if (created) { await query(`USE ${q(database)}`); await query(`DROP DATABASE IF EXISTS ${q(stage)}`); await query(`DROP DATABASE IF EXISTS ${q(review)}`); await query(`DROP DATABASE ${q(database)}`); }
    await db.end();
  }
}

test('history CLI actions are explicit and mutually exclusive before any connection', () => {
  const base=['--database=explicit','--mysql-admin-socket=explicit','--plan=reviewed.json'];
  assert.equal(parseHistoryArguments(base).install,undefined);
  for (const extra of ['--install=false','--prepare=true','--unknown','--database=duplicate']) assert.throws(() => parseHistoryArguments([...base,extra]));
  assert.throws(() => parseHistoryArguments([...base,'--prepare','--install']),/mutually exclusive/);
  assert.throws(() => parseHistoryArguments(['--capture','--database=x','--mysql-admin-socket=y','--source-kind=isolated_fixture']),/Capture requires/);
  assert.throws(() => parseHistoryArguments([...base,'--stage']),/wrong action/);
});

test('four-table capture resets approval and read-only inspection leaves source and artifacts untouched',options,async()=>scenario(async({db,database,query,plan,before})=>{
  assert.equal(plan.production_approved,false); assert.deepEqual(before.source_snapshots.map(row=>row.table),HISTORY_SCOPE);
  const tables=await query('SHOW TABLES'); await db.query('START TRANSACTION READ ONLY');
  const report=await inspectHistory(db,plan,space); await db.rollback();
  assert.equal(report.changes_source,false); assert.deepEqual(report.scope_tables,HISTORY_SCOPE); assert.deepEqual(await query('SHOW TABLES'),tables);
  sameNative(before,await capture(db,database));
}));

test('history prepare changes only stage and installation keeps latest whole rows, complete originals and counter',options,async()=>scenario(async({db,database,query,plan,before})=>{
  const original=await rows(query), manifest=JSON.stringify(plan); const prepared=await prepareHistory(db,plan,space);
  assert.equal(JSON.stringify(plan),manifest,'prepare must not rewrite the reviewed manifest for a later CLI invocation');
  assert.equal(prepared.phase,'prepared'); assert.equal(prepared.changes_source,false); sameNative(before,await capture(db,database));
  const installed=await installHistory(db,JSON.parse(manifest),space); assert.equal(installed.phase,'applied'); assert.equal(installed.canonical_rows,2); assert.equal(installed.cleanup_performed,false);
  assert.deepEqual(await rows(query,installed.complete_original_archive),original);
  assert.deepEqual((await rows(query)).map(row=>String(row.id)),['32','52']);
  assert.equal((await query('SELECT customer_name FROM order_status_history WHERE id=32'))[0].customer_name,'synthetic-latest-name');
  assert.equal(String((await query("SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_status_history'"))[0].AUTO_INCREMENT),'999');
  assert.deepEqual((await query("SELECT DISTINCT NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_status_history' AND INDEX_NAME='uk_order_status_history_hour_state'")).map(row=>Number(row.NON_UNIQUE)),[0]);
  const undone=await rollbackHistory(db,plan.repair_id,database,true); assert.equal(undone.schema_exact,false); sameNative(before,await capture(db,database));
}));

for(const checkpoint of ['before_source_index','archive_index_prepared','forward_rename_before_journal']) test(`history interruption at ${checkpoint} is recoverable with full original rows`,options,async()=>scenario(async({db,database,plan,before})=>{
  await prepareHistory(db,plan,space);
  await assert.rejects(installHistory(db,plan,{...space,checkpoint:async phase=>{if(phase===checkpoint)throw Error('Synthetic interruption');}}),/Synthetic interruption/);
  const journal=await inspectHistoryJournal(db,plan.repair_id,database); assert.equal(journal.mode,'history-shadow');
  await rollbackHistory(db,plan.repair_id,database,true); sameNative(before,await capture(db,database));
}));

test('interrupted reverse rename resumes through stored original data instead of swapping twice',options,async()=>scenario(async({db,database,plan,before})=>{
  await prepareHistory(db,plan,space); await installHistory(db,plan,space);
  await assert.rejects(rollbackHistory(db,plan.repair_id,database,true,{checkpoint:async phase=>{if(phase==='reverse_rename_before_journal')throw Error('Reverse interruption');}}),/Reverse interruption/);
  await rollbackHistory(db,plan.repair_id,database,true); sameNative(before,await capture(db,database));
}));

test('capacity is checked before staging and again before source installation without credit for missing stages',options,async()=>scenario(async({db,database,query,plan,before})=>{
  await assert.rejects(prepareHistory(db,plan,{freeSpace:async()=>1n}),/Insufficient history maintenance capacity/);
  assert.equal((await query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[plan.stage_database])).length,0);
  await assert.rejects(installHistory(db,plan,space));
  await prepareHistory(db,plan,space); await assert.rejects(installHistory(db,plan,{freeSpace:async()=>1n}),/Insufficient history maintenance capacity/);
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_history_shadow_repairs'")).length,0); sameNative(before,await capture(db,database));
}));

test('production writing requires actual boolean fresh approval and production refuses fixture capacity overrides',options,async()=>scenario(async({db,database,query,plan})=>{
  Object.assign(plan,await capture(db,database,'production_maintenance_snapshot'));
  for(const approval of [undefined,false,'true']) { if(approval===undefined)delete plan.production_approved;else plan.production_approved=approval; await assert.rejects(prepareHistory(db,plan),/production_approved=true/); await assert.rejects(installHistory(db,plan),/production_approved=true/); }
  plan.production_approved=true; await assert.rejects(inspectHistory(db,plan,space),/Capacity override restricted/);
  assert.equal((await query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[plan.stage_database])).length,0);
}));

test('old isolated backup capture can prepare but cannot authorize source installation',options,async()=>scenario(async({db,database,plan})=>{
  Object.assign(plan,await capture(db,database,'isolated_NONUNIQUE_backup')); await prepareHistory(db,plan,space);
  await assert.rejects(installHistory(db,plan,space),/backup rehearsal cannot install/);
}));

test('exact source history changes and parent changes after preparation refuse installation',options,async()=>scenario(async({db,query,plan})=>{
  await prepareHistory(db,plan,space); await query("UPDATE order_status_history SET buyer_city='synthetic-new' WHERE id=31");
  await assert.rejects(installHistory(db,plan,space),/Reviewed native source/);
  await query("UPDATE order_status_history SET buyer_city='synthetic-city' WHERE id=31;UPDATE orders SET posting_number='synthetic-new' WHERE id=1000");
  await assert.rejects(installHistory(db,plan,space),/Reviewed native source/);
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_history_shadow_repairs'")).length,0);
}));

test('fresh current reads reject a parent change after installation inspection',options,async()=>scenario(async({db,database,query,plan})=>{
  await prepareHistory(db,plan,space);
  await assert.rejects(installHistory(db,plan,{...space,checkpoint:async phase=>{if(phase==='before_source_index')await query("UPDATE orders SET posting_number='synthetic-new' WHERE id=1000");}}),/Reviewed native source/);
  assert.equal((await rows(query)).length,4);
  assert.equal((await query('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[database,`_hir_${plan.repair_id}_old_order_status_history`])).length,0);
}));

test('changed staged parents or strict table block source installation before its journal exists',options,async()=>scenario(async({db,query,plan})=>{
  await prepareHistory(db,plan,space); await query(`UPDATE ${q(plan.stage_database)}.orders SET posting_number='synthetic-tampered' WHERE id=1000`);
  await assert.rejects(installHistory(db,plan,space),/staging parent changed/);
  await query(`UPDATE ${q(plan.stage_database)}.orders SET posting_number='synthetic-A' WHERE id=1000;UPDATE ${q(plan.stage_database)}.order_status_history SET buyer_city='synthetic-tampered' WHERE id=32`);
  await assert.rejects(installHistory(db,plan,space),/Prepared strict history table changed/);
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_history_shadow_repairs'")).length,0);
}));

test('tampered complete parent-correction beforeimage refuses install before the source journal',options,async()=>scenario(async({db,database,query,plan,before})=>{
  await prepareHistory(db,plan,space);
  await query(`UPDATE ${q(plan.stage_database)}.${q(`_uir_${plan.link_plan.repair_id}_before_order_status_history`)} SET customer_name='synthetic-tampered' WHERE id=31`);
  await assert.rejects(installHistory(db,plan,space),/native link before\/after evidence changed/);
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_history_shadow_repairs'")).length,0); sameNative(before,await capture(db,database));
}));

test('altered source schema and unknown typed history references fail before source writes',options,async()=>scenario(async({db,query,plan})=>{
  await query('ALTER TABLE order_status_history ADD synthetic_extra INT'); await assert.rejects(inspectHistory(db,plan,space),/Reviewed native source/);
  await query('ALTER TABLE order_status_history DROP COLUMN synthetic_extra;CREATE TABLE unknown_ref(id BIGINT PRIMARY KEY,status_history_id BIGINT) ENGINE=InnoDB');
  await assert.rejects(inspectHistory(db,plan,space),/Unknown typed history/);
}));

test('writable history triggers and cross-schema foreign keys are refused',options,async()=>scenario(async({db,database,query,plan})=>{
  await query('CREATE TRIGGER history_write BEFORE UPDATE ON order_status_history FOR EACH ROW SET NEW.status=NEW.status');
  await assert.rejects(inspectHistory(db,plan,space),/triggers or incoming\/outgoing foreign keys/); await query('DROP TRIGGER history_write');
  const external=`${database}_fk`;
  try { await query(`CREATE DATABASE ${q(external)};CREATE TABLE ${q(external)}.child(id BIGINT PRIMARY KEY,history_id BIGINT UNSIGNED,FOREIGN KEY(history_id) REFERENCES ${q(database)}.order_status_history(id)) ENGINE=InnoDB`); await assert.rejects(inspectHistory(db,plan,space),/triggers or incoming\/outgoing foreign keys/); }
  finally { await query(`DROP DATABASE IF EXISTS ${q(external)}`); }
}));

test('wrong reviewed row hash leaves the source unchanged',options,async()=>scenario(async({db,database,plan,before})=>{
  plan.link_plan.changes[0].expected_full_row_sha256='0'.repeat(64); await assert.rejects(prepareHistory(db,plan,space),/Reviewed full row changed/); sameNative(before,await capture(db,database));
}));

test('unaccepted business column differences refuse strict reconstruction before source installation',options,async()=>scenario(async({db,database,plan,before})=>{
  plan.unique_plan.tables[0].groups[0].accepted_differing_columns=[];
  await assert.rejects(prepareHistory(db,plan,space),/accepted differences/); sameNative(before,await capture(db,database));
}));

test('missing exact original shop/posting target refuses parent correction',options,async()=>scenario(async({db,database,query,plan})=>{
  await query("UPDATE orders SET posting_number='synthetic-no-match' WHERE id=1000"); Object.assign(plan,await capture(db,database));
  await assert.rejects(prepareHistory(db,plan,space),/missing or ambiguous/); assert.equal((await rows(query)).length,4);
}));

test('read-only parent triggers and foreign keys stay in source and are absent from staging',options,async()=>scenario(async({db,database,query,plan})=>{
  await query("CREATE TRIGGER parent_evidence BEFORE UPDATE ON orders FOR EACH ROW SET NEW.posting_number=NEW.posting_number;ALTER TABLE shops ADD CONSTRAINT tenant_owner FOREIGN KEY(tenant_id) REFERENCES tenants(id)");
  Object.assign(plan,await capture(db,database)); const baseline=structuredClone(plan);
  await prepareHistory(db,plan,space); await installHistory(db,plan,space);
  assert.equal((await query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?',[database])).length,1);
  assert.equal((await query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?',[plan.stage_database])).length,0);
  assert.equal((await query('SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=?',[plan.stage_database])).length,0);
  await rollbackHistory(db,plan.repair_id,database,true); sameNative(baseline,await capture(db,database));
}));

test('material conflicts require the exact reviewed group, latest observation and complete original archive policy',options,async()=>scenario(async({db,plan})=>{
  plan.retention.material_group_row_ids=[]; await assert.rejects(prepareHistory(db,plan,space),/Material conflict groups differ/);
}));

test('older material keeper is refused even when full hashes and differences have been reviewed',options,async()=>scenario(async({db,plan})=>{
  plan.unique_plan.tables[0].groups[0].keeper_id=31; await assert.rejects(prepareHistory(db,plan,space),/latest observed_at\/id whole row/);
}));

test('source scope, capture fingerprint and no-field-merging policy are mandatory',options,async()=>scenario(async({db,plan})=>{
  const modified=structuredClone(plan); modified.source_snapshots[0].table='online_products'; await assert.rejects(inspectHistory(db,modified,space),/Exactly four/);
  const stale=structuredClone(plan); stale.source_capture.scope_sha256='0'.repeat(64); await assert.rejects(inspectHistory(db,stale,space),/Fresh maintenance capture/);
  const spliced=structuredClone(plan); spliced.retention.no_field_merging=false; await assert.rejects(prepareHistory(db,spliced,space),/no-field-merging/);
  const wrongTarget=structuredClone(plan); wrongTarget.unique_plan.tables.push({table:'online_products',groups:[]}); await assert.rejects(prepareHistory(db,wrongTarget,space),/Only the reviewed history/);
}));

test('ambiguous original shop/posting parent candidates never reach source installation',options,async()=>scenario(async({db,database,query,plan})=>{
  await query("INSERT INTO orders(id,shop_id,posting_number) VALUES(1002,10,'synthetic-A')"); Object.assign(plan,await capture(db,database));
  await assert.rejects(prepareHistory(db,plan,space),/missing or ambiguous/); assert.equal((await rows(query)).length,4);
}));

test('generated parent columns are copied as evidence, writable generated history columns are refused',options,async()=>scenario(async({db,query,plan,before})=>{
  await prepareHistory(db,plan,space); assert.equal(String((await query(`SELECT owned_shop FROM ${q(plan.stage_database)}.orders WHERE id=1000`))[0].owned_shop),'10');
  sameNative(before,await capture(db,plan.source_database));
  await query('ALTER TABLE order_status_history ADD synthetic_generated BIGINT GENERATED ALWAYS AS (order_id) STORED'); await assert.rejects(inspectHistory(db,plan,space),/Generated or invisible writable/);
},{generatedParent:true}));

test('later canonical writes refuse rollback without overwriting the new business fact',options,async()=>scenario(async({db,database,query,plan})=>{
  await prepareHistory(db,plan,space); await installHistory(db,plan,space); await query("UPDATE order_status_history SET customer_name='synthetic-later-live' WHERE id=32");
  await assert.rejects(rollbackHistory(db,plan.repair_id,database,true),/Canonical history changed/); assert.equal((await query('SELECT customer_name FROM order_status_history WHERE id=32'))[0].customer_name,'synthetic-later-live');
}));

test('tampered complete original archive blocks rollback',options,async()=>scenario(async({db,database,query,plan})=>{
  await prepareHistory(db,plan,space); const installed=await installHistory(db,plan,space); await query(`UPDATE ${q(installed.complete_original_archive)} SET buyer_city='synthetic-tampered' WHERE id=31`);
  await assert.rejects(rollbackHistory(db,plan.repair_id,database,true),/Installed history or original archive changed/);
}));

for(const statement of ['ALTER TABLE order_status_history AUTO_INCREMENT=1000','ALTER TABLE order_status_history ADD KEY synthetic_later_index(customer_name)']) test(`later canonical schema change refuses rollback: ${statement}`,options,async()=>scenario(async({db,database,query,plan})=>{
  await prepareHistory(db,plan,space); await installHistory(db,plan,space); await query(statement);
  await assert.rejects(rollbackHistory(db,plan.repair_id,database,true),/changed/i); assert.equal((await rows(query)).length,2);
}));

test('separate CLI processes prepare, install and rollback the unchanged reviewed manifest and refuse existing output before writes',options,async()=>scenario(async({db,database,query,plan,before})=>{
  const prefix=`history-cli-${nonce()}`, files=['plan','prepared','installed','rollback'].map(kind=>fileURLToPath(new URL(`../.deploy-artifacts/${prefix}-${kind}.json`,import.meta.url)));
  const cli=fileURLToPath(new URL('../scripts/repair-reviewed-history-shadow.mjs',import.meta.url));
  const common=[cli,`--database=${database}`,`--mysql-admin-socket=${socketPath}`];
  const invoke=values=>execute(process.execPath,[...common,...values],{timeout:30000,windowsHide:true});
  try {
    await writeFile(files[0],JSON.stringify(plan),'utf8'); await writeFile(files[1],'existing output','utf8');
    await assert.rejects(invoke([`--plan=${files[0]}`,'--prepare',`--output=${files[1]}`]),error=>{assert.match(error.stderr,/Output already exists/);return true;});
    assert.equal((await query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[plan.stage_database])).length,0);
    await unlink(files[1]);
    assert.equal(JSON.parse((await invoke([`--plan=${files[0]}`,'--prepare',`--output=${files[1]}`])).stdout).phase,'prepared');
    assert.equal(JSON.parse((await invoke([`--plan=${files[0]}`,'--install',`--output=${files[2]}`])).stdout).phase,'applied');
    assert.equal(JSON.parse((await invoke([`--rollback=${plan.repair_id}`,'--maintenance-confirmed',`--output=${files[3]}`])).stdout).phase,'rolled_back');
    assert.equal(await readFile(files[0],'utf8'),JSON.stringify(plan)); sameNative(before,await capture(db,database));
  } finally { for(const file of files) await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
}));

test('tampered history journal cannot redirect source installation to another archive identity',options,async()=>scenario(async({db,query,plan})=>{
  await prepareHistory(db,plan,space); const state=await inspectHistoryJournal(db,plan.repair_id,plan.stage_database,true);
  state.archive='_hir_000000000000_old_order_status_history';
  await query(`UPDATE ${q(plan.stage_database)}._reviewed_history_shadow_repairs SET state_json=? WHERE repair_id=?`,[JSON.stringify(state),plan.repair_id]);
  await assert.rejects(installHistory(db,plan,space),/exact reviewed source\/stage\/artifact identities/);
  assert.equal((await query("SHOW TABLES LIKE '\\_reviewed_history_shadow_repairs'")).length,0);
}));
