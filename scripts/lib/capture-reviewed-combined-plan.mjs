// Read-only capture of a closed, reviewed repair scope. Never chooses keepers,
// updates business hashes, or calls a repair writer.
import { createHash } from 'node:crypto';
import { captureCombinedSource } from './reviewed-combined-shadow-repair.mjs';
import { REPAIR_TABLES } from './reviewed-unique-index-repair.mjs';

const q = value => '`' + String(value).replaceAll('`', '``') + '`';
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('Unsafe numeric ID; use a decimal string');
  const text = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > 18446744073709551615n) throw Error('Invalid positive ID');
  return text;
};
const chunks = (values, n = 300) => Array.from({ length: Math.ceil(values.length / n) }, (_, i) => values.slice(i * n, i * n + n));
const sameValue = (a, b) => a == null ? b == null : String(a) === String(b);
const groupKey = values => values.map(id).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).join(',');
const native = value => `IF(${value} IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(${value} AS BINARY)),':',HEX(CAST(${value} AS BINARY))))`;
const run = async (db, sql, args = []) => (await db.query(sql, args))[0];
const REFS = ['online_product_actions', 'outbound_records', 'ozon_stock_snapshots', 'product_barcode_label_cache', 'sku_inventory_recipes', 'sku_mappings', 'inventory_product_requests'];
const FIELDS = { order_status_history: ['order_id'], online_products: ['ozon_product_id', 'product_id'], outbound_records: ['order_item_id'] };

function validate(plan) {
  if (plan?.version !== 1 || !Array.isArray(plan.link_plan?.changes) || !Array.isArray(plan.unique_plan?.tables)) throw Error('Reviewed combined v1 plan required');
  const seen = new Set();
  for (const change of plan.link_plan.changes) {
    const key = `${change.table}:${id(change.id)}`;
    if (seen.has(key) || !FIELDS[change.table] || !/^[a-f0-9]{64}$/.test(change.expected_full_row_sha256 || '') || !Object.keys(change.fields || {}).length) throw Error('Duplicate or unsupported reviewed correction');
    seen.add(key); id(change.original_shop_id); id(change.expected_tenant_id);
    for (const [field, values] of Object.entries(change.fields)) {
      if (!FIELDS[change.table].includes(field) || !Object.hasOwn(values, 'before')) throw Error('Unreviewed correction field');
      id(values.after);
    }
  }
  if (plan.unique_plan.tables.length !== 3 || new Set(plan.unique_plan.tables.map(t => t.table)).size !== 3) throw Error('Exactly three reviewed target scopes required');
  for (const entry of plan.unique_plan.tables) {
    if (!REPAIR_TABLES[entry.table] || !Array.isArray(entry.groups)) throw Error('Unsupported target scope');
    const rows = new Set();
    for (const group of entry.groups) {
      if (!Array.isArray(group.row_ids) || group.row_ids.length < 2 || group.row_ids.length > 100 || !group.row_ids.map(id).includes(id(group.keeper_id)) || !Array.isArray(group.accepted_differing_columns)) throw Error('Closed reviewed groups and keepers required');
      for (const row of group.row_ids) { const value = id(row); if (rows.has(value) || !/^[a-f0-9]{64}$/.test(group.expected_hashes?.[value] || '')) throw Error('Repeated group row or missing projected native hash'); rows.add(value); }
    }
  }
  const exception = plan.unique_plan.unchanged_outbound_reference;
  if (exception && (exception.table !== 'outbound_records' || !exception.reason || !exception.user_confirmation_reference || !/^[a-f0-9]{64}$/.test(exception.expected_full_row_sha256 || ''))) throw Error('Exact user-reviewed unchanged outbound exception required');
  if (exception) for (const field of ['row_id', 'shop_id', 'online_product_id', 'order_item_id', 'expected_parent_order_id', 'expected_parent_shop_id', 'expected_tenant_id']) id(exception[field]);
  if (exception && seen.has(`outbound_records:${id(exception.row_id)}`)) throw Error('Unchanged outbound exception cannot also be corrected');
  return plan;
}

export function reviewedCaptureScopeHash(input) {
  const plan = validate(input);
  return hash(JSON.stringify({ link_changes: plan.link_plan.changes, unique_tables: plan.unique_plan.tables, unchanged_outbound_reference: plan.unique_plan.unchanged_outbound_reference || null }));
}

async function columns(db, table) {
  const result = await run(db, `SELECT c.COLUMN_NAME,c.DATA_TYPE,c.COLLATION_NAME,co.PAD_ATTRIBUTE
    FROM information_schema.COLUMNS c LEFT JOIN information_schema.COLLATIONS co ON co.COLLATION_NAME=c.COLLATION_NAME
    WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION`, [table]);
  if (!result.length) throw Error(`Missing source table: ${table}`);
  return result;
}

async function reviewedRows(db, plan) {
  const selected = new Map();
  const add = (table, value) => { if (!selected.has(table)) selected.set(table, new Set()); selected.get(table).add(id(value)); };
  for (const row of plan.link_plan.changes) add(row.table, row.id);
  for (const entry of plan.unique_plan.tables) for (const group of entry.groups) for (const row of group.row_ids) add(entry.table, row);
  const exception = plan.unique_plan.unchanged_outbound_reference;
  if (exception) add('outbound_records', exception.row_id);
  const result = new Map();
  for (const [table, ids] of selected) {
    const cols = await columns(db, table), changes = new Map(plan.link_plan.changes.filter(row => row.table === table).map(row => [id(row.id), row]));
    const found = new Map();
    for (const batch of chunks([...ids])) {
      const expression = name => {
        const relevant = batch.map(value => changes.get(value)).filter(change => change?.fields[name]);
        return relevant.length ? `CASE r.id ${relevant.map(change => `WHEN ${id(change.id)} THEN ${db.escape(change.fields[name].after)}`).join(' ')} ELSE r.${q(name)} END` : `r.${q(name)}`;
      };
      const full = `SHA2(CONCAT(${cols.map(col => native(`r.${q(col.COLUMN_NAME)}`)).join(',')}),256)`;
      const projected = `SHA2(CONCAT(${cols.map(col => native(expression(col.COLUMN_NAME))).join(',')}),256)`;
      const perColumn = cols.map((col, i) => `SHA2(${native(`r.${q(col.COLUMN_NAME)}`)},256) ${q(`column_${i}`)}`).join(',');
      const rows = await run(db, `SELECT r.*,${full} capture_full_hash,${projected} capture_projected_hash,${perColumn}
        FROM ${q(table)} r FORCE INDEX(PRIMARY) WHERE r.id IN (${batch.join(',')}) ORDER BY r.id`);
      for (const row of rows) found.set(id(row.id), { row, sha256: row.capture_full_hash, projected_sha256: row.capture_projected_hash, columns: Object.fromEntries(cols.map((col, i) => [col.COLUMN_NAME, row[`column_${i}`]])) });
    }
    result.set(table, found);
  }
  return result;
}

export async function captureReviewedRowProof(db, input) {
  const plan = validate(input), rows = await reviewedRows(db, plan);
  return { version: 1, scope_sha256: reviewedCaptureScopeHash(plan), native_encoding: 'MySQL CAST AS BINARY; explicit NULL and length/HEX framing; SHA256', tables: [...rows].map(([table, found]) => ({ table, rows: [...found].map(([row_id, value]) => ({ row_id, sha256: value.sha256, columns: value.columns })) })) };
}

// Server collation weights preserve MySQL equality semantics while correcting
// only the reviewed numeric parent in memory. This avoids a 5,000-branch CASE
// on every historical row and does not create a temporary table.
async function duplicateGroups(db, plan, table) {
  const spec = REPAIR_TABLES[table], cols = await columns(db, table);
  const changes = new Map(plan.link_plan.changes.filter(row => row.table === table).map(row => [id(row.id), row]));
  const expressions = spec.key.map((field, i) => {
    const column = cols.find(col => col.COLUMN_NAME === field);
    if (!column) throw Error('Reviewed natural-key metadata changed');
    const value = `r.${q(field)}`;
    const comparable = column.COLLATION_NAME ? `HEX(WEIGHT_STRING(${column.PAD_ATTRIBUTE === 'PAD SPACE' ? `RTRIM(${value})` : value}))` : `HEX(CAST(${value} AS BINARY))`;
    return `${comparable} ${q(`key_${i}`)}`;
  });
  const seen = new Map(); let last = null;
  while (true) {
    const rows = await run(db, `SELECT r.id,${expressions.join(',')} FROM ${q(table)} r FORCE INDEX(PRIMARY)
      ${last === null ? '' : 'WHERE r.id>?'} ORDER BY r.id LIMIT 10000`, last === null ? [] : [last]);
    for (const row of rows) {
      const parts = spec.key.map((field, i) => changes.get(id(row.id))?.fields[field] ? Buffer.from(String(changes.get(id(row.id)).fields[field].after)).toString('hex').toUpperCase() : row[`key_${i}`]);
      if (parts.every(value => value != null)) { const key = hash(JSON.stringify(parts)), old = seen.get(key); if (old === undefined) seen.set(key, id(row.id)); else if (Array.isArray(old)) old.push(id(row.id)); else seen.set(key, [old, id(row.id)]); }
      last = id(row.id);
    }
    if (rows.length < 10000) break;
  }
  return [...seen.values()].filter(Array.isArray).map(groupKey).sort();
}

async function runtimeIdentity(db, plan, rows, issues) {
  const defaults = await run(db, "SELECT id FROM tenants WHERE slug='default'");
  if (defaults.length !== 1) { issues.push({ code: 'default_tenant_ambiguous' }); return; }
  const effective = value => value == null || value === 'admin' ? id(defaults[0].id) : id(value);
  const shops = new Map((await run(db, 'SELECT id,tenant_id,status FROM shops FORCE INDEX(PRIMARY)')).map(row => [id(row.id), row]));
  const products = new Map((await run(db, 'SELECT id,tenant_id,active FROM products FORCE INDEX(PRIMARY)')).map(row => [id(row.id), row]));
  const orders = await run(db, 'SELECT id,shop_id,posting_number FROM orders FORCE INDEX(PRIMARY)'), byOrder = new Map(orders.map(row => [id(row.id), row])), byPosting = new Map();
  const items = await run(db, 'SELECT id,order_id,ozon_sku,quantity FROM order_items FORCE INDEX(PRIMARY)'), byItem = new Map(items.map(row => [id(row.id), row]));
  for (const row of orders) { const key = JSON.stringify([id(row.shop_id), row.posting_number]); if (!byPosting.has(key)) byPosting.set(key, []); byPosting.get(key).push(row); }
  for (const change of plan.link_plan.changes) {
    const row = rows.get(change.table)?.get(id(change.id))?.row;
    if (!row) continue;
    const shop = shops.get(id(row.shop_id));
    if (!shop || shop.status === 'deleted' || id(row.shop_id) !== id(change.original_shop_id) || effective(shop.tenant_id) !== id(change.expected_tenant_id)) issues.push({ code: 'reviewed_tenant_or_shop_changed', table: change.table, row_id: id(change.id) });
    if (Object.entries(change.fields).some(([field, value]) => !sameValue(row[field], value.before))) issues.push({ code: 'reviewed_before_value_changed', table: change.table, row_id: id(change.id) });
    if (change.table === 'order_status_history') { const candidates = byPosting.get(JSON.stringify([id(row.shop_id), row.posting_number])) || []; if (candidates.length !== 1 || id(candidates[0].id) !== id(change.fields.order_id.after)) issues.push({ code: 'history_candidate_not_unique', row_id: id(change.id) }); }
    if (change.table === 'outbound_records') { const parents = byPosting.get(JSON.stringify([id(row.shop_id), row.order_ref])) || [], candidates = items.filter(item => parents.some(parent => id(parent.id) === id(item.order_id)) && sameValue(item.ozon_sku, row.ozon_sku) && sameValue(item.quantity, row.quantity)); if (candidates.length !== 1 || id(candidates[0].id) !== id(change.fields.order_item_id.after)) issues.push({ code: 'outbound_candidate_not_unique', row_id: id(change.id) }); }
    if (change.table === 'online_products' && change.fields.product_id) { const product = products.get(id(change.fields.product_id.after)); if (!product || Number(product.active) !== 1 || !shop || effective(product.tenant_id) !== effective(shop.tenant_id)) issues.push({ code: 'target_product_inactive_or_cross_tenant', row_id: id(change.id) }); }
  }
  const corrected = (table, original) => {
    const result = { ...original }, change = plan.link_plan.changes.find(c => c.table === table && id(c.id) === id(original.id));
    for (const [field, value] of Object.entries(change?.fields || {})) result[field] = value.after;
    return result;
  };
  const ownsProduct = (productId, tenantId) => productId == null || String(productId) === '0' || products.has(id(productId)) && effective(products.get(id(productId)).tenant_id) === tenantId;
  const onlineRows = new Map();
  for (const entry of plan.unique_plan.tables) {
    if (entry.table === 'ozon_category_mappings') continue;
    for (const group of entry.groups) {
      const projected = group.row_ids.map(value => rows.get(entry.table)?.get(id(value))?.row).filter(Boolean).map(row => corrected(entry.table, row));
      for (const row of projected) {
        const shop = shops.get(id(row.shop_id));
        if (!shop || shop.status === 'deleted' || Object.hasOwn(row, 'tenant_id') && effective(row.tenant_id) !== effective(shop.tenant_id)) { issues.push({ code: 'duplicate_ownership_changed', table: entry.table, row_id: id(row.id) }); continue; }
        if (entry.table === 'online_products') { onlineRows.set(id(row.id), row); if (!ownsProduct(row.product_id, effective(shop.tenant_id))) issues.push({ code: 'duplicate_product_cross_tenant', row_id: id(row.id) }); }
        if (entry.table === 'order_status_history') { const parent = byOrder.get(id(row.order_id)); if (!parent || id(parent.shop_id) !== id(row.shop_id) || parent.posting_number !== row.posting_number) issues.push({ code: 'duplicate_history_parent_changed', row_id: id(row.id) }); }
      }
      if (entry.table === 'online_products') for (const field of ['product_id', 'ozon_product_id']) {
        const meaningful = [...new Set(projected.map(row => row[field]).filter(value => value != null && !['', '0'].includes(String(value))).map(String))];
        const keeper = projected.find(row => id(row.id) === id(group.keeper_id));
        if (meaningful.length > 1 || meaningful.length === 1 && String(keeper?.[field]) !== meaningful[0]) issues.push({ code: 'projected_identity_conflict', row_ids: group.row_ids.map(id), field });
      }
    }
  }
  const onlineIds = [...onlineRows.keys()], exceptionId = plan.unique_plan.unchanged_outbound_reference?.row_id;
  if (onlineIds.length) for (const table of REFS) {
    const onlineExpression = table === 'inventory_product_requests' ? "IF(JSON_VALID(r.payload_json),JSON_UNQUOTE(JSON_EXTRACT(r.payload_json,'$.online_product_id')),NULL)" : 'r.online_product_id';
    const references = await run(db, `SELECT r.* FROM ${q(table)} r FORCE INDEX(PRIMARY) WHERE ${onlineExpression} IN (${onlineIds.map(value => db.escape(value)).join(',')})`);
    for (const original of references) {
      const row = corrected(table, original), payload = table === 'inventory_product_requests' ? (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json) : null;
      const online = onlineRows.get(id(payload?.online_product_id ?? row.online_product_id)), shop = shops.get(id(online.shop_id)), tenantId = effective(shop.tenant_id), rowId = id(row.id ?? row.online_product_id);
      if (table !== 'inventory_product_requests' && id(row.shop_id) !== id(online.shop_id) || Object.hasOwn(row, 'tenant_id') && effective(row.tenant_id) !== tenantId || !ownsProduct(row.product_id, tenantId) || payload?.shop_id != null && id(payload.shop_id) !== id(online.shop_id)) issues.push({ code: 'typed_reference_ownership_changed', table, row_id: rowId });
      if (row.order_item_id) { const item = byItem.get(id(row.order_item_id)), parent = item ? byOrder.get(id(item.order_id)) : null; if ((!parent || id(parent.shop_id) !== id(online.shop_id)) && !(table === 'outbound_records' && rowId === String(exceptionId))) issues.push({ code: 'typed_reference_parent_changed', table, row_id: rowId }); }
    }
  }
  const exception = plan.unique_plan.unchanged_outbound_reference;
  if (exception) {
    const row = rows.get('outbound_records')?.get(id(exception.row_id))?.row;
    const parents = await run(db, 'SELECT id,order_id FROM order_items FORCE INDEX(PRIMARY) WHERE id=?', [id(exception.order_item_id)]), parent = parents.length === 1 ? byOrder.get(id(parents[0].order_id)) : null;
    const ownShop = shops.get(id(exception.shop_id)), parentShop = parent ? shops.get(id(parent.shop_id)) : null;
    const keeper = plan.unique_plan.tables.find(t => t.table === 'online_products').groups.some(g => id(g.keeper_id) === id(exception.online_product_id));
    if (!row || !keeper || !sameValue(row.shop_id, exception.shop_id) || !sameValue(row.online_product_id, exception.online_product_id) || !sameValue(row.order_item_id, exception.order_item_id) || !parent || id(parent.id) !== id(exception.expected_parent_order_id) || id(parent.shop_id) !== id(exception.expected_parent_shop_id) || !ownShop || !parentShop || effective(ownShop.tenant_id) !== id(exception.expected_tenant_id) || effective(parentShop.tenant_id) !== id(exception.expected_tenant_id)) issues.push({ code: 'unchanged_outbound_exception_changed', row_id: id(exception.row_id) });
  }
}

export async function projectReviewedReferenceDigest(db, input) {
  const plan = validate(input), ids = plan.unique_plan.tables.find(t => t.table === 'online_products').groups.flatMap(g => g.row_ids.map(id)), references = [];
  for (const table of REFS) {
    const cols = await columns(db, table);
    const keys = await run(db, "SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [table]);
    if (keys.length !== 1) throw Error('Unsupported reference primary key');
    const primary = keys[0].COLUMN_NAME, changes = plan.link_plan.changes.filter(row => row.table === table);
    const expression = field => { const relevant = changes.filter(row => row.fields[field]); return relevant.length ? `CASE r.${q(primary)} ${relevant.map(row => `WHEN ${id(row.id)} THEN ${db.escape(row.fields[field].after)}`).join(' ')} ELSE r.${q(field)} END` : `r.${q(field)}`; };
    const online = table === 'inventory_product_requests' ? "IF(JSON_VALID(r.payload_json),JSON_UNQUOTE(JSON_EXTRACT(r.payload_json,'$.online_product_id')),NULL)" : 'r.online_product_id';
    const rowHash = `SHA2(CONCAT(${cols.map(col => native(expression(col.COLUMN_NAME))).join(',')}),256)`;
    const rows = await run(db, `SELECT r.${q(primary)} row_id,${online} online_id,${rowHash} row_hash FROM ${q(table)} r FORCE INDEX(PRIMARY)
      WHERE ${online} IN (${ids.map(value => db.escape(value)).join(',')}) ORDER BY r.${q(primary)}`);
    const digest = createHash('sha256'); for (const row of rows) digest.update(`${row.row_id}:${row.row_hash}\n`);
    references.push({ table, row_ids: rows.map(row => id(row.row_id)), online_ids: rows.map(row => id(row.online_id)).sort(), digest: { count: rows.length, sha256: digest.digest('hex') } });
  }
  return { references, expected_reference_digest: hash(JSON.stringify(references)) };
}

export async function captureReviewedCombinedPlan(db, input, baseline, options = {}) {
  const plan = structuredClone(validate(input)), scope = reviewedCaptureScopeHash(plan), issues = [];
  if (baseline?.version !== 1 || baseline.scope_sha256 !== scope) throw Error('Baseline per-column proof does not match the reviewed closed scope');
  if (!['production_maintenance_snapshot', 'isolated_NONUNIQUE_backup'].includes(options.source_kind) || options.maintenance_confirmed !== true) throw Error('Explicit capture source kind and frozen maintenance acknowledgement required');
  const [[selected]] = await db.query('SELECT DATABASE() db,@@skip_networking disabled,@@event_scheduler scheduler,@@SESSION.unique_checks unique_checks');
  if (selected.db !== options.database || Number(selected.unique_checks) !== 1 || selected.scheduler !== 'OFF') throw Error('Selected database/strict checks/maintenance scheduler mismatch');
  if (options.source_kind === 'isolated_NONUNIQUE_backup' && Number(selected.disabled) !== 1) throw Error('Isolated capture requires TCP disabled');
  await run(db, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await run(db, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  try {
    const rows = await reviewedRows(db, plan), previous = new Map(baseline.tables.map(t => [t.table, new Map(t.rows.map(row => [id(row.row_id), row]))]));
    for (const [table, old] of previous) for (const [row_id, expected] of old) {
      const actual = rows.get(table)?.get(row_id);
      if (!actual) issues.push({ code: 'reviewed_row_missing', table, row_id });
      else if (actual.sha256 !== expected.sha256) issues.push({ code: 'reviewed_row_changed', table, row_id, differing_columns: [...new Set([...Object.keys(expected.columns), ...Object.keys(actual.columns)])].filter(col => expected.columns[col] !== actual.columns[col]), before_sha256: expected.sha256, fresh_sha256: actual.sha256 });
    }
    for (const change of plan.link_plan.changes) if (rows.get(change.table)?.get(id(change.id))?.sha256 !== change.expected_full_row_sha256) issues.push({ code: 'reviewed_link_native_hash_changed', table: change.table, row_id: id(change.id) });
    for (const entry of plan.unique_plan.tables) {
      for (const group of entry.groups) for (const row_id of group.row_ids.map(id)) if (rows.get(entry.table)?.get(row_id)?.projected_sha256 !== group.expected_hashes[row_id]) issues.push({ code: 'reviewed_projected_hash_changed', table: entry.table, row_id });
      const actual = await duplicateGroups(db, plan, entry.table), expected = entry.groups.map(g => groupKey(g.row_ids)).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push({ code: 'closed_duplicate_scope_changed', table: entry.table, missing_groups: expected.filter(g => !actual.includes(g)), new_groups: actual.filter(g => !expected.includes(g)) });
    }
    await runtimeIdentity(db, plan, rows, issues);
    const exception = plan.unique_plan.unchanged_outbound_reference;
    if (exception && rows.get('outbound_records')?.get(id(exception.row_id))?.sha256 !== exception.expected_full_row_sha256) issues.push({ code: 'unchanged_outbound_full_hash_changed', row_id: id(exception.row_id) });
    if (Array.isArray(plan.unresolved) && plan.unresolved.length) issues.push({ code: 'unresolved_business_decision', count: plan.unresolved.length });
    const snapshots = await captureCombinedSource(db, options.database), projected = await projectReviewedReferenceDigest(db, plan);
    const snapshot_changes = snapshots.map(fresh => { const old = plan.source_snapshots.find(s => s.table === fresh.table); return { table: fresh.table, before_count: old?.count, fresh_count: fresh.count, native_changed: old?.sha256 !== fresh.sha256, ddl_changed: old?.ddl !== fresh.ddl, dependencies_changed: JSON.stringify(old?.readonly_dependencies || null) !== JSON.stringify(fresh.readonly_dependencies || null), fresh_sha256: fresh.sha256 }; });
    plan.source_database = options.database; plan.source_kind = options.source_kind; plan.source_snapshots = snapshots; plan.unique_plan.expected_reference_digest = projected.expected_reference_digest;
    plan.production_approved = false;
    for (const field of ['production_approval', 'production_approved_by', 'production_approved_at', 'approved_plan_sha256']) delete plan[field];
    plan.capture = { at: new Date().toISOString(), scope_sha256: scope, changes_source: false, original_reviewed_hashes_preserved: true, production_approved: false, root_review_required: true };
    const report = { version: 1, ok: issues.length === 0, changes_source: false, production_approved: false, root_review_required: true, issues, snapshot_changes, projected_reference_digest: projected.expected_reference_digest, references: projected.references };
    return { report, candidate: issues.length ? null : plan };
  } finally { await db.rollback(); }
}

export function parseCaptureArguments(values) {
  const strings = new Set(['mode', 'mysql-admin-socket', 'database', 'plan', 'baseline', 'output', 'report', 'source-kind']);
  const result = {};
  for (let i = 0; i < values.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(values[i]); if (!match) throw Error('Use explicit --named arguments');
    const key = match[1]; if (Object.hasOwn(result, key)) throw Error('Duplicate argument');
    if (key === 'maintenance-confirmed') { if (match[2] !== undefined) throw Error('Boolean flags do not accept values'); result[key] = true; }
    else { if (!strings.has(key)) throw Error('Unknown capture argument'); const value = match[2] ?? values[++i]; if (!value || value.startsWith('--')) throw Error('Missing argument value'); result[key] = value; }
  }
  if (!['baseline', 'capture'].includes(result.mode) || !result['mysql-admin-socket'] || !/^[a-zA-Z0-9_]{1,64}$/.test(result.database || '') || !result.plan || !result.output) throw Error('Explicit mode, socket, database, reviewed plan and output required');
  if (result.mode === 'capture' && (!result.baseline || !result.report || result['maintenance-confirmed'] !== true || !['production_maintenance_snapshot', 'isolated_NONUNIQUE_backup'].includes(result['source-kind']))) throw Error('Capture requires baseline, report, source kind and frozen maintenance acknowledgement');
  return result;
}
