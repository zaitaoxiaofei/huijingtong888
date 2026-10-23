import { createHash } from 'node:crypto';

// This is an administrator maintenance tool, not an application migration.
// DDL commits implicitly. A durable journal records the reference transaction
// separately from the atomic table swap; rollback deliberately restores the
// original DATA with a NONUNIQUE natural-key index, never an invalid UNIQUE.
export const REPAIR_TABLES = Object.freeze({
  online_products: { index: 'uk_online_products_shop_sku', key: ['shop_id', 'ozon_sku'] },
  order_status_history: { index: 'uk_order_status_history_hour_state', key: ['order_id', 'observed_hour', 'status', 'logistics_status', 'tracking_stage', 'sync_state'] },
  ozon_category_mappings: { index: 'uq_ozon_category_mapping', key: ['description_category_id', 'type_id'] }
});
const TYPED_REFS = ['online_product_actions', 'outbound_records', 'ozon_stock_snapshots', 'product_barcode_label_cache', 'sku_inventory_recipes', 'sku_mappings'];
const REQUESTS = 'inventory_product_requests';
const JOURNAL = '_reviewed_unique_index_repairs';
const q = value => `\`${String(value).replaceAll('`', '``')}\``;
const hash = value => createHash('sha256').update(value).digest('hex');
const sql = async (db, text, args = []) => (await db.query(text, args))[0];
function refuse(message) { const error = new Error(message); error.safe = true; throw error; }
function id(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) refuse('IDs outside safe JSON integer precision must be strings');
  const text = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > 18446744073709551615n) refuse('Invalid positive integer ID');
  return text;
}
function checkedPlan(plan, apply = false) {
  if (plan?.version !== 1 || !/^[a-f0-9]{12}$/.test(plan.repair_id || '')) refuse('Plan version=1 and a fresh 12-character hex repair_id are required');
  if (!Array.isArray(plan.tables) || !plan.tables.length || plan.tables.length > 3) refuse('An explicit table/group plan is required');
  const names = new Set();
  for (const entry of plan.tables) {
    if (!Object.hasOwn(REPAIR_TABLES, entry.table) || names.has(entry.table)) refuse('Only the three documented tables, once each, are allowed');
    names.add(entry.table);
    if (!Array.isArray(entry.groups) || !entry.groups.length) refuse('Explicit reviewed duplicate groups are required');
    const seen = new Set();
    for (const group of entry.groups) {
      if (!Array.isArray(group.row_ids) || group.row_ids.length < 2 || group.row_ids.length > 100) refuse('Each group requires 2–100 distinct row IDs');
      for (const value of group.row_ids) { const key = id(value); if (seen.has(key)) refuse('A row occurs more than once in the plan'); seen.add(key); }
      if (group.keeper_id != null && !group.row_ids.map(id).includes(id(group.keeper_id))) refuse('Keeper must belong to its explicit group');
      if (apply && (group.keeper_id == null || !group.expected_hashes || !Array.isArray(group.accepted_differing_columns))) refuse('Apply requires a keeper, inspected row hashes and reviewed differing columns');
    }
  }
  if (apply && (!String(plan.reviewed_by || '').trim() || !String(plan.reason || '').trim()
    || plan.maintenance_confirmed !== true || plan.rollback_restores_nonunique_schema !== true
    || !/^[a-f0-9]{64}$/.test(plan.expected_reference_digest || ''))) refuse('Apply requires reviewed_by, reason, maintenance and NONUNIQUE rollback acknowledgements, and inspected reference digest');
  if (apply && names.has('online_products') && (plan.invalidate_barcode_cache !== true || plan.preserve_historical_json !== true)) refuse('Online repair requires explicit archived-cache invalidation and historical JSON preservation acknowledgements');
  if (Object.hasOwn(plan, 'unchanged_outbound_references')) refuse('Only one exact unchanged outbound reference is supported, never an exception list');
  if (Object.hasOwn(plan, 'unchanged_outbound_reference')) {
    const exception = plan.unchanged_outbound_reference;
    const fields = ['table', 'row_id', 'shop_id', 'online_product_id', 'order_item_id', 'expected_parent_order_id', 'expected_parent_shop_id', 'expected_tenant_id', 'expected_full_row_sha256', 'user_confirmation_reference', 'reason'];
    if (!exception || Array.isArray(exception) || typeof exception !== 'object' || Object.keys(exception).length !== fields.length
      || Object.keys(exception).some(name => !fields.includes(name)) || exception.table !== 'outbound_records') refuse('An unchanged exception must name exactly one complete outbound_records identity');
    for (const field of ['row_id', 'shop_id', 'online_product_id', 'order_item_id', 'expected_parent_order_id', 'expected_parent_shop_id', 'expected_tenant_id']) {
      if (!['string', 'number'].includes(typeof exception[field])) refuse('Unchanged outbound identifiers must be explicit integer IDs');
      id(exception[field]);
    }
    if (!/^[a-f0-9]{64}$/.test(exception.expected_full_row_sha256 || '')
      || !['user_confirmation_reference', 'reason'].every(field => typeof exception[field] === 'string' && exception[field].trim())) refuse('Unchanged outbound preservation requires an exact native hash, explicit user confirmation and reason');
    const group = plan.tables.find(entry => entry.table === 'online_products')?.groups.find(value => value.keeper_id != null && id(value.keeper_id) === id(exception.online_product_id));
    if (!group) refuse('Unchanged outbound online identity must already be a reviewed group keeper; it cannot be remapped');
  }
  return plan;
}
async function metadata(db, table, optional = false) {
  const tables = await sql(db, 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table]);
  if (!tables.length && optional) return null;
  if (tables[0]?.ENGINE !== 'InnoDB') refuse(`Expected an existing InnoDB table: ${table}`);
  const columns = await sql(db, 'SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table]);
  if (columns.some(row => /(?:VIRTUAL|STORED) GENERATED|INVISIBLE/i.test(row.EXTRA))) refuse(`Generated/invisible columns require separate review: ${table}`);
  const indexes = await sql(db, 'SELECT INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX,NON_UNIQUE,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', [table]);
  const primary = indexes.filter(row => row.INDEX_NAME === 'PRIMARY').map(row => row.COLUMN_NAME);
  if (primary.length !== 1 || !['id', 'online_product_id'].includes(primary[0])) refuse(`Unsupported primary key: ${table}`);
  const triggers = await sql(db, 'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [table]);
  const foreign = await sql(db, `SELECT TABLE_SCHEMA,TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
    WHERE REFERENCED_TABLE_NAME IS NOT NULL AND ((TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?)
      OR (REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME=?))`, [table, table]);
  if (triggers.length || foreign.length) refuse(`Triggers or foreign keys require separate reviewed handling: ${table}`);
  const create = await sql(db, `SHOW CREATE TABLE ${q(table)}`);
  return { table, columns: columns.map(row => row.COLUMN_NAME), primary: primary[0], indexes, create_sql: create[0]['Create Table'] };
}
function rowHash(meta, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const values = meta.columns.map(name => `IF(${prefix}${q(name)} IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(${prefix}${q(name)} AS BINARY)),':',HEX(CAST(${prefix}${q(name)} AS BINARY))))`);
  return `SHA2(CONCAT(${values.join(',')}),256)`;
}
async function digest(db, meta, predicate = '1') {
  // Keyset pages avoid one long full-history SELECT, and never trust a damaged
  // secondary index for counts, rows, hashes or the shadow copy.
  const result = createHash('sha256'); let last = null; let count = 0;
  while (true) {
    const rows = await sql(db, `SELECT ${q(meta.primary)} AS row_id,${rowHash(meta)} AS row_hash FROM ${q(meta.table)} FORCE INDEX(PRIMARY)
      WHERE (${predicate}) ${last == null ? '' : `AND ${q(meta.primary)}> ?`} ORDER BY ${q(meta.primary)} LIMIT 2000`, last == null ? [] : [last]);
    for (const row of rows) { result.update(`${row.row_id}:${row.row_hash}\n`); count++; last = String(row.row_id); }
    if (rows.length < 2000) break;
  }
  return { count, sha256: result.digest('hex') };
}
const equalDigest = (left, right) => left?.count === right?.count && left?.sha256 === right?.sha256;
function refPredicate(table, allIds) {
  const values = allIds.join(',');
  return table === REQUESTS
    ? `IF(JSON_VALID(payload_json),JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.online_product_id')),NULL) IN (${allIds.map(value => `'${value}'`).join(',')})`
    : `online_product_id IN (${values})`;
}
async function defaultTenant(db, lock = false) {
  const rows = await sql(db, `SELECT id FROM tenants WHERE slug='default'${lock ? ' FOR SHARE' : ''}`);
  if (rows.length !== 1) refuse('Exactly one default tenant is required to interpret legacy NULL ownership');
  return id(rows[0].id);
}
function tenantOf(value, defaultId) { return value == null || value === 'admin' ? defaultId : id(value); }
async function shopTenant(db, shopId, defaultId, lock = false) {
  const rows = await sql(db, `SELECT id,tenant_id FROM shops WHERE id=?${lock ? ' FOR SHARE' : ''}`, [id(shopId)]);
  if (rows.length !== 1) refuse('A duplicate/reference has no valid owning shop');
  return tenantOf(rows[0].tenant_id, defaultId);
}
async function productTenant(db, productId, tenantId, defaultId, lock = false) {
  if (!productId || String(productId) === '0') return;
  const rows = await sql(db, `SELECT id,tenant_id FROM products WHERE id=?${lock ? ' FOR SHARE' : ''}`, [id(productId)]);
  if (rows.length !== 1 || tenantOf(rows[0].tenant_id, defaultId) !== tenantId) refuse('A product binding crosses or lacks enterprise ownership');
}
async function ownership(db, table, rows, defaultId) {
  if (table === 'ozon_category_mappings') return; // Shared official dictionary, not tenant-owned IDs.
  for (const row of rows) {
    const tenant = await shopTenant(db, row.shop_id, defaultId);
    if (Object.hasOwn(row, 'tenant_id') && tenantOf(row.tenant_id, defaultId) !== tenant) refuse('Duplicate row and shop ownership disagree');
    if (table === 'online_products') await productTenant(db, row.product_id, tenant, defaultId);
    if (table === 'order_status_history') {
      const parent = await sql(db, 'SELECT shop_id FROM orders WHERE id=?', [id(row.order_id)]);
      if (parent.length !== 1 || String(parent[0].shop_id) !== String(row.shop_id)) refuse('History row and order ownership disagree');
    }
  }
}
function recommendation(table, rows) {
  const rank = row => table === 'online_products'
    ? [row.status && row.status !== 'historical' ? 1 : 0, row.product_id ? 1 : 0]
    : table === 'ozon_category_mappings' ? [row.status === 'active' ? 1 : 0, Number(row.description_category_id)>0 && Number(row.type_id)>0 ? 1 : 0, row.name_ru && row.raw_json ? 1 : 0]
      : [];
  return [...rows].sort((a, b) => {
    const aa = rank(a), bb = rank(b);
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return bb[i] - aa[i];
    return BigInt(a.id) < BigInt(b.id) ? -1 : 1;
  })[0].id;
}
function identityKeepers(rows) {
  const values = ['product_id', 'ozon_product_id'].map(column => ({ column, values: [...new Set(rows.map(row => row[column]).filter(value => value != null && String(value) !== '' && String(value) !== '0').map(String))] }));
  return rows.filter(row => values.every(entry => entry.values.length === 0 || (entry.values.length === 1 && String(row[entry.column]) === entry.values[0])));
}

// This is a single reviewed preservation case, not permission to repair a
// guessed parent. Its only relaxation is a same-enterprise parent-shop
// mismatch. The entire outbound row, including its old parent, stays intact.
export async function inspectUnchangedOutboundReference(db, input, { lock = false } = {}) {
  const plan = checkedPlan(input), exception = plan.unchanged_outbound_reference;
  if (!exception) return null;
  const meta = await metadata(db, 'outbound_records');
  if (meta.primary !== 'id') refuse('Unchanged outbound preservation requires the exact row primary key');
  const rows = await sql(db, `SELECT *,${rowHash(meta)} AS repair_reference_hash FROM outbound_records FORCE INDEX(PRIMARY) WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [id(exception.row_id)]);
  const row = rows[0];
  if (rows.length !== 1 || ['shop_id', 'online_product_id', 'order_item_id'].some(field => row[field] == null || id(row[field]) !== id(exception[field]))
    || row.repair_reference_hash !== exception.expected_full_row_sha256) refuse('Unchanged outbound exact identity or native row hash changed');
  const online = await sql(db, `SELECT * FROM online_products FORCE INDEX(PRIMARY) WHERE id=?${lock ? ' FOR SHARE' : ''}`, [id(exception.online_product_id)]);
  if (online.length !== 1 || String(online[0].shop_id) !== id(exception.shop_id)) refuse('Unchanged outbound and keeper shop ownership disagree');
  const defaultId = await defaultTenant(db, lock), tenant = await shopTenant(db, row.shop_id, defaultId, lock);
  if (tenant !== id(exception.expected_tenant_id) || (meta.columns.includes('tenant_id') && tenantOf(row.tenant_id, defaultId) !== tenant)) refuse('Unchanged outbound preservation crosses enterprises');
  if (Object.hasOwn(online[0], 'tenant_id') && tenantOf(online[0].tenant_id, defaultId) !== tenant) refuse('Unchanged outbound keeper enterprise ownership disagrees');
  await productTenant(db, row.product_id, tenant, defaultId, lock);
  await productTenant(db, online[0].product_id, tenant, defaultId, lock);
  const parent = await sql(db, `SELECT oi.order_id,o.shop_id FROM order_items oi FORCE INDEX(PRIMARY) JOIN orders o FORCE INDEX(PRIMARY) ON o.id=oi.order_id WHERE oi.id=?${lock ? ' FOR SHARE' : ''}`, [id(exception.order_item_id)]);
  if (parent.length !== 1 || String(parent[0].order_id) !== id(exception.expected_parent_order_id)
    || String(parent[0].shop_id) !== id(exception.expected_parent_shop_id)) refuse('Unchanged outbound old parent is missing or changed');
  if (await shopTenant(db, parent[0].shop_id, defaultId, lock) !== tenant) refuse('Unchanged outbound old parent crosses enterprises');
  if (String(parent[0].shop_id) === String(row.shop_id)) refuse('Unchanged outbound exception is unnecessary; parent-shop ownership already agrees');
  return { table: 'outbound_records', row_id: id(exception.row_id), shop_id: id(exception.shop_id), online_product_id: id(exception.online_product_id), order_item_id: id(exception.order_item_id),
    parent_order_id: id(exception.expected_parent_order_id), parent_shop_id: id(exception.expected_parent_shop_id), tenant_id: tenant, full_row_sha256: row.repair_reference_hash, native_digest: await digest(db, meta, `id=${id(exception.row_id)}`),
    relationship_reconciled: false, warning: 'Original historical parent relationship remains unreconciled; retain every field unchanged pending business review',
    user_confirmation_reference: exception.user_confirmation_reference, reason: exception.reason };
}

export async function inspectReviewedUniqueRepair(db, input) {
  const plan = checkedPlan(input);
  const unchangedOutbound = await inspectUnchangedOutboundReference(db, plan);
  const unknownHistoryCategoryRefs = await sql(db, `SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND COLUMN_NAME IN ('order_status_history_id','status_history_id','category_mapping_id','ozon_category_mapping_id')`);
  if (unknownHistoryCategoryRefs.length) refuse('An unaudited history/category local-ID reference exists');
  const defaultId = plan.tables.some(entry => entry.table !== 'ozon_category_mappings') ? await defaultTenant(db) : null;
  const tables = []; const onlineRows = new Map(); const onlineGroups = [];
  for (const entry of plan.tables) {
    const spec = REPAIR_TABLES[entry.table], meta = await metadata(db, entry.table);
    const index = meta.indexes.filter(row => row.INDEX_NAME === spec.index);
    if (index.map(row => row.COLUMN_NAME).join(',') !== spec.key.join(',') || index.some(row => row.SUB_PART != null)) refuse(`Unexpected natural-key index definition: ${entry.table}`);
    const groups = [];
    for (const group of entry.groups) {
      const ids = group.row_ids.map(id);
      const rows = await sql(db, `SELECT *,${rowHash(meta)} AS repair_hash FROM ${q(entry.table)} FORCE INDEX(PRIMARY) WHERE id IN (${ids.join(',')}) ORDER BY id`);
      if (rows.length !== ids.length) refuse(`Missing reviewed rows in ${entry.table}`);
      await ownership(db, entry.table, rows, defaultId);
      const first = rows[0]; const differences = new Set();
      for (const other of rows.slice(1)) {
        const [check] = await sql(db, `SELECT (${spec.key.map(name => `a.${q(name)} <=> b.${q(name)}`).join(' AND ')}) AS same_key,
          ${meta.columns.filter(name => name !== 'id').map(name => `(CAST(a.${q(name)} AS BINARY) <=> CAST(b.${q(name)} AS BINARY)) AS ${q(name)}`).join(',')}
          FROM ${q(entry.table)} a FORCE INDEX(PRIMARY) JOIN ${q(entry.table)} b FORCE INDEX(PRIMARY) ON b.id=? WHERE a.id=?`, [other.id, first.id]);
        if (!Number(check.same_key) || spec.key.some(name => first[name] == null)) refuse('Reviewed IDs do not form one complete non-NULL natural key');
        for (const name of meta.columns) if (name !== 'id' && Number(check[name]) === 0) differences.add(name);
      }
      const expected_hashes = Object.fromEntries(rows.map(row => [String(row.id), row.repair_hash]));
      const eligible = entry.table === 'online_products' ? identityKeepers(rows) : rows;
      const result = { row_ids: ids, keeper_id: group.keeper_id == null ? null : id(group.keeper_id), recommended_keeper_id: eligible.length ? String(recommendation(entry.table, eligible)) : null, expected_hashes, differing_columns: [...differences].sort(), ...(entry.table === 'online_products' ? { identity_preserving_keeper_ids: eligible.map(row => String(row.id)) } : {}) };
      groups.push(result);
      if (entry.table === 'online_products') { for (const row of rows) onlineRows.set(String(row.id), row); onlineGroups.push(rows); }
    }
    tables.push({ table: entry.table, groups, index_is_unique: index.every(row => Number(row.NON_UNIQUE) === 0) });
  }
  const references = []; const conflicts = [];
  if (onlineRows.size) {
    const unknown = await sql(db, `SELECT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='online_product_id'
      AND TABLE_NAME NOT IN (${TYPED_REFS.map(() => '?').join(',')})`, TYPED_REFS);
    if (unknown.some(row => !/^_uir_[a-f0-9]{12}_(?:before|after)_/.test(row.TABLE_NAME))) refuse('An unaudited typed online_product_id reference exists');
    const allIds = [...onlineRows.keys()];
    for (const table of [...TYPED_REFS, REQUESTS]) {
      const meta = await metadata(db, table, true); if (!meta) continue;
      const predicate = refPredicate(table, allIds);
      const rows = await sql(db, `SELECT * FROM ${q(table)} FORCE INDEX(PRIMARY) WHERE ${predicate}`);
      for (const row of rows) {
        const payload = table === REQUESTS ? (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json) : null;
        const online = onlineRows.get(String(payload?.online_product_id ?? row.online_product_id));
        if (!online) refuse('Unexpected reference identity');
        const tenant = await shopTenant(db, online.shop_id, defaultId);
        if (table !== REQUESTS && String(row.shop_id) !== String(online.shop_id)) refuse('A typed reference crosses shops');
        if (meta.columns.includes('tenant_id') && tenantOf(row.tenant_id, defaultId) !== tenant) refuse('A reference crosses enterprises');
        await productTenant(db, row.product_id, tenant, defaultId);
        if (payload?.shop_id != null && String(payload.shop_id) !== String(online.shop_id)) refuse('Inventory request payload crosses shops');
        if (row.order_item_id) {
          const parent = await sql(db, 'SELECT o.shop_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=?', [id(row.order_item_id)]);
          if (parent.length !== 1 || (String(parent[0].shop_id) !== String(online.shop_id)
            && !(table === 'outbound_records' && unchangedOutbound?.row_id === String(row.id)))) refuse('Outbound reference and order-item ownership disagree');
        }
      }
      references.push({ table, row_ids: rows.map(row => String(row[meta.primary])), online_ids: rows.map(row => String(table === REQUESTS ? (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json).online_product_id : row.online_product_id)).sort(), digest: await digest(db, meta, predicate) });
    }
    for (const rows of onlineGroups) {
      const groupIds = rows.map(row => String(row.id));
      // Even historical outbound/product bindings can be meaningful. This tool
      // refuses ambiguous identity merges instead of choosing by recency.
      for (const column of ['product_id', 'ozon_product_id']) {
        const values = new Set(rows.map(row => row[column]).filter(value => value != null && String(value) !== '' && String(value) !== '0').map(String));
        if (values.size > 1) conflicts.push({ row_ids: groupIds, reason: `Duplicate group has conflicting ${column}; identity equivalence is not established` });
      }
    }
  }
  return { version: 1, repair_id: plan.repair_id, changes_database: false, tables, references, conflicts,
    expected_reference_digest: hash(JSON.stringify(references)), historical_json_policy: 'preserve original evidence; no generic JSON replacement',
    ...(unchangedOutbound ? { unchanged_outbound_reference: unchangedOutbound } : {}) };
}

function artifact(run, kind, table) { return `_uir_${run}_${kind}_${table}`; }
async function storeState(db, state) {
  await sql(db, `UPDATE ${q(JOURNAL)} SET phase=?,state_json=? WHERE repair_id=?`, [state.phase, JSON.stringify(state), state.repair_id]);
}
async function repairLock(db, database, operation) {
  const [selected] = await sql(db, 'SELECT DATABASE() AS db');
  if (!database || selected.db !== database) refuse('Explicit selected database mismatch');
  const name = `unique_repair:${hash(database).slice(0, 40)}`;
  const [lock] = await sql(db, 'SELECT GET_LOCK(?,0) AS acquired', [name]);
  if (Number(lock.acquired) !== 1) refuse('Another index repair holds the database lock');
  try { return await operation(); } finally { await sql(db, 'SELECT RELEASE_LOCK(?)', [name]); }
}
async function nonunique(db, table, target) {
  const spec = REPAIR_TABLES[target];
  const indexes = await sql(db, 'SELECT NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?', [table, spec.index]);
  if (!indexes.length) refuse('Expected archive natural-key index is missing');
  if (indexes.some(row => Number(row.NON_UNIQUE) === 0)) await sql(db, `ALTER TABLE ${q(table)} DROP INDEX ${q(spec.index)},ADD KEY ${q(spec.index)} (${spec.key.map(q).join(',')}),ALGORITHM=INPLACE,LOCK=EXCLUSIVE`);
}

export async function applyReviewedUniqueRepair(db, input, database) {
  const plan = checkedPlan(input, true);
  return repairLock(db, database, async () => {
    const [checks] = await sql(db, 'SELECT @@SESSION.unique_checks AS unique_checks');
    if (Number(checks.unique_checks) !== 1) refuse('Session unique_checks must be 1 for strict shadow reconstruction');
    const report = await inspectReviewedUniqueRepair(db, plan);
    if (report.conflicts.length) refuse('Ambiguous product/Ozon identity conflicts require separate business review');
    if (report.expected_reference_digest !== plan.expected_reference_digest) refuse('Reference rows changed since review');
    for (const entry of report.tables) for (const group of entry.groups) {
      const reviewed = plan.tables.find(value => value.table === entry.table).groups.find(value => id(value.keeper_id) === group.keeper_id);
      if (!reviewed || JSON.stringify(reviewed.expected_hashes) !== JSON.stringify(group.expected_hashes)
        || JSON.stringify([...reviewed.accepted_differing_columns].sort()) !== JSON.stringify(group.differing_columns)) refuse('Reviewed row fingerprint or accepted differences changed');
      if (entry.table === 'online_products' && !group.identity_preserving_keeper_ids.includes(group.keeper_id)) refuse('Reviewed keeper would discard a valid product/Ozon identity');
      if (entry.table === 'ozon_category_mappings') {
        const [keeper] = await sql(db, 'SELECT status,description_category_id,type_id FROM ozon_category_mappings FORCE INDEX(PRIMARY) WHERE id=?', [group.keeper_id]);
        if (keeper.status !== 'active' || BigInt(keeper.description_category_id) <= 0n || BigInt(keeper.type_id) <= 0n) refuse('Reviewed category keeper must be active with valid positive official IDs');
      }
    }
    await sql(db, `CREATE TABLE IF NOT EXISTS ${q(JOURNAL)} (repair_id CHAR(12) PRIMARY KEY,phase VARCHAR(32) NOT NULL,state_json LONGTEXT NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
    const prior = await sql(db, `SELECT repair_id FROM ${q(JOURNAL)} WHERE repair_id=?`, [plan.repair_id]);
    if (prior.length) refuse('Repair ID already exists; inspect/recover that journal instead of reapplying');
    const state = { version: 1, repair_id: plan.repair_id, phase: 'preparing', database, plan, targets: [], references: [] };
    // Journal before any artifact DDL so failures remain discoverable/recoverable.
    await sql(db, `INSERT INTO ${q(JOURNAL)} (repair_id,phase,state_json) VALUES (?,?,?)`, [state.repair_id, state.phase, JSON.stringify(state)]);
    for (const entry of plan.tables) {
      const meta = await metadata(db, entry.table);
      const target = { table: entry.table, archive: artifact(plan.repair_id, 'old', entry.table), shadow: artifact(plan.repair_id, 'new', entry.table), undone: artifact(plan.repair_id, 'undo', entry.table), schema_before: meta.create_sql, before: await digest(db, meta) };
      state.targets.push(target); await storeState(db, state);
      await sql(db, `CREATE TABLE ${q(target.shadow)} LIKE ${q(entry.table)}`);
      const spec = REPAIR_TABLES[entry.table];
      await sql(db, `ALTER TABLE ${q(target.shadow)} DROP INDEX ${q(spec.index)},ADD UNIQUE KEY ${q(spec.index)} (${spec.key.map(q).join(',')})`);
      const removed = entry.groups.flatMap(group => group.row_ids.map(id).filter(value => value !== id(group.keeper_id)));
      await sql(db, `INSERT INTO ${q(target.shadow)} SELECT * FROM ${q(entry.table)} FORCE INDEX(PRIMARY) WHERE id NOT IN (${removed.join(',')})`);
      const [status] = await sql(db, 'SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [entry.table]);
      if (status.AUTO_INCREMENT != null) await sql(db, `ALTER TABLE ${q(target.shadow)} AUTO_INCREMENT=${id(status.AUTO_INCREMENT)}`);
      const shadowMeta = { ...meta, table: target.shadow };
      target.after = await digest(db, shadowMeta);
      if (target.before.count !== target.after.count + removed.length || !equalDigest(await digest(db, meta, `id NOT IN (${removed.join(',')})`), target.after)) refuse('Shadow is not an exact retained-row copy');
      await storeState(db, state);
    }
    const onlineEntry = plan.tables.find(entry => entry.table === 'online_products');
    const allIds = onlineEntry?.groups.flatMap(group => group.row_ids.map(id)) || [];
    for (const ref of report.references) {
      const before = artifact(plan.repair_id, 'before', ref.table), after = artifact(plan.repair_id, 'after', ref.table);
      state.references.push({ table: ref.table, before, after, predicate: refPredicate(ref.table, allIds), before_digest: ref.digest });
      await storeState(db, state);
      await sql(db, `CREATE TABLE ${q(before)} LIKE ${q(ref.table)}`);
      await sql(db, `CREATE TABLE ${q(after)} LIKE ${q(ref.table)}`);
    }
    // No DDL inside this transaction. Archives include complete BLOB/JSON rows.
    await db.beginTransaction();
    try {
      for (const entry of plan.tables) await sql(db, `SELECT id FROM ${q(entry.table)} FORCE INDEX(PRIMARY) WHERE id IN (${entry.groups.flatMap(group => group.row_ids.map(id)).join(',')}) FOR UPDATE`);
      const fresh = await inspectReviewedUniqueRepair(db, plan);
      if (fresh.expected_reference_digest !== report.expected_reference_digest || JSON.stringify(fresh.tables) !== JSON.stringify(report.tables)) refuse('Rows changed during repair preparation');
      const preservedBefore = await inspectUnchangedOutboundReference(db, plan, { lock: true });
      for (const ref of state.references) {
        const meta = await metadata(db, ref.table);
        await sql(db, `SELECT ${q(meta.primary)} FROM ${q(ref.table)} FORCE INDEX(PRIMARY) WHERE ${ref.predicate} FOR UPDATE`);
        await sql(db, `INSERT INTO ${q(ref.before)} SELECT * FROM ${q(ref.table)} FORCE INDEX(PRIMARY) WHERE ${ref.predicate}`);
        const keepTimestamp = meta.columns.includes('updated_at') ? ',updated_at=updated_at' : '';
        if (ref.table === 'product_barcode_label_cache') await sql(db, `DELETE FROM ${q(ref.table)} WHERE ${ref.predicate}`);
        else for (const group of onlineEntry.groups) {
          const losers = group.row_ids.map(id).filter(value => value !== id(group.keeper_id));
          if (ref.table === REQUESTS) await sql(db, `UPDATE ${q(ref.table)} SET payload_json=JSON_SET(payload_json,'$.online_product_id',CAST(? AS UNSIGNED))${keepTimestamp} WHERE ${refPredicate(REQUESTS, losers)}`, [id(group.keeper_id)]);
          else await sql(db, `UPDATE ${q(ref.table)} SET online_product_id=?${keepTimestamp} WHERE online_product_id IN (${losers.join(',')})`, [id(group.keeper_id)]);
        }
        await sql(db, `INSERT INTO ${q(ref.after)} SELECT * FROM ${q(ref.table)} FORCE INDEX(PRIMARY) WHERE ${ref.predicate}`);
        ref.after_digest = await digest(db, meta, ref.predicate);
      }
      if (preservedBefore) {
        const preservedAfter = await inspectUnchangedOutboundReference(db, plan, { lock: true });
        if (!equalDigest(preservedBefore.native_digest, preservedAfter.native_digest)) refuse('Reviewed unchanged outbound bytes changed during reference repair');
        state.unchanged_outbound_reference = { ...preservedAfter, before_digest: preservedBefore.native_digest, after_digest: preservedAfter.native_digest, byte_unchanged: true };
      }
      state.phase = 'references_applied'; await storeState(db, state); await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    for (const target of state.targets) {
      if (!Object.hasOwn(REPAIR_TABLES, target.table) || !state.plan.tables.some(entry => entry.table === target.table)) refuse('Unaudited journal target');
      if (!equalDigest(await digest(db, await metadata(db, target.table)), target.before)) refuse('Original table changed before swap; keep maintenance mode and recover');
      // The archive must itself be dump/restorable. Keeping the corrupt UNIQUE
      // on an archive would merely move the original backup failure elsewhere.
      await nonunique(db, target.table, target.table);
      if (!equalDigest(await digest(db, await metadata(db, target.table)), target.before)) refuse('Index downgrade changed original rows; keep maintenance mode for manual recovery');
    }
    state.phase = 'swap_pending'; await storeState(db, state);
    await sql(db, `RENAME TABLE ${state.targets.flatMap(target => [`${q(target.table)} TO ${q(target.archive)}`, `${q(target.shadow)} TO ${q(target.table)}`]).join(',')}`);
    for (const target of state.targets) {
      if (!equalDigest(await digest(db, await metadata(db, target.table)), target.after)
        || !equalDigest(await digest(db, await metadata(db, target.archive)), target.before)) refuse('Post-swap verification failed; keep maintenance mode and recover from journal');
    }
    if (state.unchanged_outbound_reference) await inspectUnchangedOutboundReference(db, plan);
    state.phase = 'applied'; await storeState(db, state);
    return { repair_id: state.repair_id, phase: state.phase, rows_archived: state.targets.map(target => ({ table: target.table, archive: target.archive, original_rows: target.before.count, canonical_rows: target.after.count })), references_archived: state.references.map(ref => ({ table: ref.table, rows: ref.before_digest.count })), rollback_schema_exact: false,
      ...(state.unchanged_outbound_reference ? { unchanged_outbound_reference: state.unchanged_outbound_reference } : {}) };
  });
}

export async function inspectUniqueRepairJournal(db, repairId) {
  if (!/^[a-f0-9]{12}$/.test(repairId || '')) refuse('Invalid repair ID');
  const tables = await sql(db, 'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [JOURNAL]);
  if (!tables.length) refuse('Repair journal does not exist');
  const rows = await sql(db, `SELECT phase,state_json FROM ${q(JOURNAL)} WHERE repair_id=?`, [repairId]);
  if (rows.length !== 1) refuse('Repair journal not found');
  return JSON.parse(rows[0].state_json);
}

export async function rollbackReviewedUniqueRepair(db, repairId, database, maintenanceConfirmed = false) {
  if (!maintenanceConfirmed) refuse('Rollback requires confirmed maintenance; it restores original DATA with NONUNIQUE schema');
  return repairLock(db, database, async () => {
    const state = await inspectUniqueRepairJournal(db, repairId);
    if (state.mode === 'combined-shadow') refuse('Combined shadow repair requires its matching coordinator rollback; keep maintenance active');
    checkedPlan(state.plan, true);
    if (state.database !== database || state.repair_id !== repairId || state.phase === 'rolled_back') refuse('Journal database/phase mismatch');
    await inspectUnchangedOutboundReference(db, state.plan);
    const exists = async name => (await sql(db, 'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])).length === 1;
    const swapped = [];
    for (const target of state.targets) {
      if (!Object.hasOwn(REPAIR_TABLES, target.table) || !state.plan.tables.some(entry => entry.table === target.table)) refuse('Unaudited journal target');
      if (target.archive !== artifact(repairId, 'old', target.table) || target.shadow !== artifact(repairId, 'new', target.table) || target.undone !== artifact(repairId, 'undo', target.table)) refuse('Invalid journal artifact identity');
      const didSwap = await exists(target.archive); swapped.push(didSwap);
      if (!equalDigest(await digest(db, await metadata(db, target.table)), didSwap ? target.after : target.before)) refuse('Current table changed after repair; automatic rollback refused');
      if (didSwap && !equalDigest(await digest(db, await metadata(db, target.archive)), target.before)) refuse('Original archive changed; rollback refused');
    }
    if (swapped.some(Boolean) && !swapped.every(Boolean)) refuse('Partial multi-table swap needs manual recovery');
    const refsApplied = ['references_applied', 'swap_pending', 'applied', 'rollback_swap_pending'].includes(state.phase);
    if (refsApplied) for (const ref of state.references) {
      if (![...TYPED_REFS, REQUESTS].includes(ref.table) || ref.before !== artifact(repairId, 'before', ref.table) || ref.after !== artifact(repairId, 'after', ref.table)
        || ref.predicate !== refPredicate(ref.table, state.plan.tables.find(entry => entry.table === 'online_products').groups.flatMap(group => group.row_ids.map(id)))) refuse('Invalid journal reference identity');
      if (!equalDigest(await digest(db, await metadata(db, ref.table), ref.predicate), ref.after_digest)
        || !equalDigest(await digest(db, await metadata(db, ref.before)), ref.before_digest)
        || !equalDigest(await digest(db, await metadata(db, ref.after)), ref.after_digest)) refuse('Reference rows or archives changed; automatic rollback refused');
    }
    for (const target of state.targets) await nonunique(db, swapped[0] ? target.archive : target.table, target.table);
    if (swapped.every(Boolean) && swapped.length) {
      state.phase = 'rollback_swap_pending'; await storeState(db, state);
      await sql(db, `RENAME TABLE ${state.targets.flatMap(target => [`${q(target.table)} TO ${q(target.undone)}`, `${q(target.archive)} TO ${q(target.table)}`]).join(',')}`);
    }
    if (refsApplied) {
      await db.beginTransaction();
      try {
        for (const ref of state.references) {
          await sql(db, `DELETE FROM ${q(ref.table)} WHERE ${ref.predicate}`);
          await sql(db, `INSERT INTO ${q(ref.table)} SELECT * FROM ${q(ref.before)} FORCE INDEX(PRIMARY)`);
        }
        state.phase = 'rolled_back'; await storeState(db, state); await db.commit();
      } catch (error) { await db.rollback(); throw error; }
    } else { state.phase = 'rolled_back'; await storeState(db, state); }
    return { repair_id: repairId, phase: state.phase, original_data_restored: true, schema_exact: false, natural_key_indexes: 'NONUNIQUE; duplicate DATA retained; do not resume business writers' };
  });
}
