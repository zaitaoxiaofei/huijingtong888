import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fixture, socketPath } from './helpers/reviewed-unique-fixture.js';
import { captureCombinedSource } from '../scripts/lib/reviewed-combined-shadow-repair.mjs';
import { captureReviewedRowProof, captureReviewedCombinedPlan, parseCaptureArguments, reviewedCaptureScopeHash } from '../scripts/lib/capture-reviewed-combined-plan.mjs';
const q = value => '`' + value.replaceAll('`', '``') + '`';
async function scenario(action) {
  await fixture(async ({ db, database, query }) => {
    await query("ALTER TABLE shops ADD status VARCHAR(32) DEFAULT 'active'; ALTER TABLE products ADD active TINYINT DEFAULT 1; ALTER TABLE orders ADD posting_number VARCHAR(128); UPDATE orders SET posting_number=CONCAT('post-',id)");
    await query("ALTER TABLE order_status_history ADD posting_number VARCHAR(128); UPDATE order_status_history SET posting_number='post-1000'; UPDATE order_status_history SET order_id=2000 WHERE id=31");
    await query("ALTER TABLE order_items ADD ozon_sku VARCHAR(128),ADD quantity INT; UPDATE order_items SET ozon_sku='PRIVATE-SKU',quantity=2");
    const snapshots = await captureCombinedSource(db, database);
    const expression = (table, projected = false) => 'SHA2(CONCAT(' + snapshots.find(s => s.table === table).columns.map(column => { const v = projected && table === 'order_status_history' && column === 'order_id' ? 'IF(id=31,1000,order_id)' : q(column); return `IF(${v} IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(${v} AS BINARY)),':',HEX(CAST(${v} AS BINARY))))`; }).join(',') + '),256)';
    const plan = { version: 1, source_database: database, source_snapshots: snapshots, link_plan: { changes: [{ table: 'order_status_history', id: '31', original_shop_id: '10', expected_tenant_id: '1', expected_full_row_sha256: (await query(`SELECT ${expression('order_status_history')} value FROM order_status_history WHERE id=31`))[0].value, fields: { order_id: { before: '2000', after: '1000' } } }] },
      unique_plan: { tables: [{ table: 'online_products', groups: [{ row_ids: ['11', '12'], keeper_id: '12', accepted_differing_columns: [] }] }, { table: 'order_status_history', groups: [{ row_ids: ['31', '32'], keeper_id: '31', accepted_differing_columns: [] }] }, { table: 'ozon_category_mappings', groups: [{ row_ids: ['41', '42'], keeper_id: '42', accepted_differing_columns: [] }] }] } };
    for (const entry of plan.unique_plan.tables) for (const group of entry.groups) group.expected_hashes = Object.fromEntries((await query(`SELECT id,${expression(entry.table, true)} value FROM ${q(entry.table)} WHERE id IN (${group.row_ids.join(',')})`)).map(row => [String(row.id), row.value]));
    const baseline = await captureReviewedRowProof(db, plan);
    const options = { database, source_kind: 'isolated_NONUNIQUE_backup', maintenance_confirmed: true };
    await action({ db, query, database, plan, baseline, options, snapshots });
  });
}
test('capture produces a fresh actual reference digest without DDL/DML, changed hashes or keeper selection', { skip: !socketPath }, async () => scenario(async ({ db, database, plan, baseline, options, snapshots }) => {
  plan.production_approved = true; plan.production_approval = { stale: true }; plan.production_approved_by = 'Old reviewer';
  const statements = [];
  const readonly = { query(sql, args) { statements.push(sql); assert.match(sql.trim(), /^(SELECT|SHOW|SET TRANSACTION|START TRANSACTION)/i); return db.query(sql, args); }, escape: db.escape.bind(db), rollback: db.rollback.bind(db) };
  const { report, candidate } = await captureReviewedCombinedPlan(readonly, plan, baseline, options);
  assert.equal(report.ok, true); assert.equal(report.production_approved, false); assert.equal(candidate.capture.root_review_required, true);
  assert.equal(candidate.production_approved, false); assert.equal(candidate.production_approval, undefined); assert.equal(candidate.production_approved_by, undefined);
  assert.match(candidate.unique_plan.expected_reference_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(candidate.link_plan.changes, plan.link_plan.changes); assert.deepEqual(candidate.unique_plan.tables, plan.unique_plan.tables);
  assert.ok(statements.length > 20);
  const after = await captureCombinedSource(db, database); assert.deepEqual(after.map(s => [s.count, s.sha256]), snapshots.map(s => [s.count, s.sha256]));
}));
test('a timestamp/raw-text change reports only changed column names and refuses an updated business hash', { skip: !socketPath }, async () => scenario(async ({ db, query, plan, baseline, options }) => {
  await query("UPDATE online_products SET raw_json='private replacement',updated_at='2026-01-01' WHERE id=11");
  const result = await captureReviewedCombinedPlan(db, plan, baseline, options);
  assert.equal(result.candidate, null);
  const changed = result.report.issues.find(i => i.code === 'reviewed_row_changed'); assert.deepEqual(changed.differing_columns.sort(), ['raw_json', 'updated_at']);
  assert.ok(!JSON.stringify(result.report).includes('private replacement'));
}));
test('a newly duplicated key outside the reviewed list is refused', { skip: !socketPath }, async () => scenario(async ({ db, query, plan, baseline, options }) => {
  await query("INSERT INTO ozon_category_mappings VALUES(43,900,901,'x','x','active',0,'{}',20),(44,900,901,'x','x','active',0,'{}',20)");
  const result = await captureReviewedCombinedPlan(db, plan, baseline, options);
  assert.equal(result.candidate, null); assert.deepEqual(result.report.issues.find(i => i.code === 'closed_duplicate_scope_changed').new_groups, ['43,44']);
}));
test('a new equally matching original shop/posting parent is refused', { skip: !socketPath }, async () => scenario(async ({ db, query, plan, baseline, options }) => {
  await query("INSERT INTO orders VALUES(4000,10,'post-1000')");
  const result = await captureReviewedCombinedPlan(db, plan, baseline, options);
  assert.equal(result.candidate, null); assert.ok(result.report.issues.some(i => i.code === 'history_candidate_not_unique'));
}));
test('a shop enterprise change is not hidden by unchanged historical row bytes', { skip: !socketPath }, async () => scenario(async ({ db, query, plan, baseline, options }) => {
  await query('UPDATE shops SET tenant_id=3 WHERE id=10');
  const result = await captureReviewedCombinedPlan(db, plan, baseline, options);
  assert.equal(result.candidate, null); assert.ok(result.report.issues.some(i => i.code === 'reviewed_tenant_or_shop_changed'));
}));
test('a duplicate product ownership change outside link corrections refuses a fresh candidate', { skip: !socketPath }, async () => scenario(async ({ db, query, plan, baseline, options }) => {
  await query('UPDATE products SET tenant_id=3 WHERE id=100');
  const result = await captureReviewedCombinedPlan(db, plan, baseline, options); assert.equal(result.candidate, null);
  assert.ok(result.report.issues.some(i => i.code === 'duplicate_product_cross_tenant'));
}));
test('a matched typed reference cannot acquire another tenant product through a fresh digest', { skip: !socketPath }, async () => scenario(async ({ db, query, plan, baseline, options }) => {
  await query('UPDATE outbound_records SET product_id=200 WHERE id=2');
  const result = await captureReviewedCombinedPlan(db, plan, baseline, options); assert.equal(result.candidate, null);
  assert.ok(result.report.issues.some(i => i.code === 'typed_reference_ownership_changed' && i.row_id === '2'));
}));
test('the reviewed unchanged singleton retains its complete row and exact parent, while same-shop parent drift refuses capture', { skip: !socketPath }, async () => scenario(async ({ db, query, plan, options }) => {
  await query("INSERT INTO shops VALUES(15,NULL,'active'); INSERT INTO orders VALUES(1500,15,'other-post'),(1501,15,'same-shop-new-parent'); INSERT INTO order_items VALUES(15001,1500,'PRIVATE-SKU',2); UPDATE outbound_records SET online_product_id=12,order_item_id=15001 WHERE id=2");
  plan.unique_plan.unchanged_outbound_reference = { table: 'outbound_records', row_id: '2', shop_id: '10', online_product_id: '12', order_item_id: '15001', expected_parent_order_id: '1500', expected_parent_shop_id: '15', expected_tenant_id: '1', expected_full_row_sha256: 'a'.repeat(64), user_confirmation_reference: 'Fixture owner approved unchanged record pending reconciliation', reason: 'Preserve ambiguity without changing stock or historical fields' };
  let baseline = await captureReviewedRowProof(db, plan);
  plan.unique_plan.unchanged_outbound_reference.expected_full_row_sha256 = baseline.tables.find(t => t.table === 'outbound_records').rows[0].sha256;
  baseline = await captureReviewedRowProof(db, plan);
  const result = await captureReviewedCombinedPlan(db, plan, baseline, options); assert.equal(result.report.ok, true);
  assert.deepEqual(result.candidate.unique_plan.unchanged_outbound_reference, plan.unique_plan.unchanged_outbound_reference);
  await query('UPDATE order_items SET order_id=1501 WHERE id=15001');
  const drifted = await captureReviewedCombinedPlan(db, plan, baseline, options); assert.equal(drifted.candidate, null);
  assert.ok(drifted.report.issues.some(i => i.code === 'unchanged_outbound_exception_changed'));
}));
test('case-insensitive natural-key equality finds a new group even when raw spellings differ', { skip: !socketPath }, async () => scenario(async ({ db, query, plan, baseline, options }) => {
  await query("INSERT INTO online_products(id,shop_id,ozon_sku,ozon_product_id,product_id,status,raw_json) VALUES(80,20,'CaseKey','100',200,'ready','{}'),(81,20,'casekey','100',200,'ready','{}')");
  const result = await captureReviewedCombinedPlan(db, plan, baseline, options); assert.equal(result.candidate, null);
  assert.ok(result.report.issues.some(i => i.code === 'closed_duplicate_scope_changed' && i.new_groups.includes('80,81')));
}));
test('unresolved decisions and missing exact baseline scope refuse capture', { skip: !socketPath }, async () => scenario(async ({ db, plan, baseline, options }) => {
  await assert.rejects(captureReviewedCombinedPlan(db, plan, { ...baseline, scope_sha256: '0'.repeat(64) }, options), /Baseline/);
  plan.unresolved = ['Business choice not approved'];
  const result = await captureReviewedCombinedPlan(db, plan, baseline, options); assert.equal(result.candidate, null); assert.ok(result.report.issues.some(i => i.code === 'unresolved_business_decision'));
}));
test('capture argument and unsafe-ID guards reject false booleans, writer flags and missing frozen boundary', () => {
  const base = ['--mode=capture', '--database=fixture', '--mysql-admin-socket=explicit', '--plan=reviewed.json', '--baseline=columns.json', '--output=out.json', '--report=report.json', '--source-kind=production_maintenance_snapshot', '--maintenance-confirmed'];
  assert.equal(parseCaptureArguments(base).mode, 'capture');
  for (const flags of [['--apply'], ['--maintenance-confirmed=false'], ['--source-kind=isolated_fixture']]) assert.throws(() => parseCaptureArguments([...base, ...flags]));
  assert.throws(() => parseCaptureArguments(base.filter(v => v !== '--maintenance-confirmed')));
  assert.throws(() => reviewedCaptureScopeHash({ version: 1, link_plan: { changes: [{ table: 'order_status_history', id: 9007199254740992 }] }, unique_plan: { tables: [] } }), /Unsafe numeric ID/);
});
test('capture CLI refuses aliasing an input/output and stale existing output before opening a database', () => {
  const base = ['scripts/capture-reviewed-combined-plan.mjs', '--mode=baseline', '--database=fixture', '--mysql-admin-socket=unused'];
  const alias = spawnSync(process.execPath, [...base, '--plan=same.json', '--output=same.json'], { encoding: 'utf8' });
  assert.equal(alias.status, 1); assert.match(alias.stderr, /paths must be distinct/);
  const stale = spawnSync(process.execPath, [...base, '--plan=unused.json', '--output=package.json'], { encoding: 'utf8' });
  assert.equal(stale.status, 1); assert.match(stale.stderr, /already exists/);
});
