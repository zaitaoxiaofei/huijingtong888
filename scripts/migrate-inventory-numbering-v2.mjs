import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildInventoryNumberingPlan } from '../src/services/inventory-numbering-plan.js';
import { inspectInventoryNumberingV2Schema, prepareInventoryNumberingV2Schema, installInventoryNumberingV2Triggers } from '../src/services/inventory-numbering-v2.js';

const triggerNames = ['products_inventory_number_insert', 'products_inventory_number_update', 'products_inventory_number_alias_update'];
const numberFields = new Set(['inventory_number', 'inventory_number_category', 'inventory_number_brand', 'inventory_number_sequence', 'inventory_number_version']);
const identityFields = new Set(['name','inventory_category','vehicle_brand','fitment_type','vehicle_model','vehicle_models_json']);
const query = async (db, sql, params = []) => (await db.query(sql, params))[0];
const refuse = message => Object.assign(new Error(message), { code: 'INVENTORY_NUMBERING_MIGRATION_REFUSED', safe: true });
const stable = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function readInventoryNumberingSource(db) {
  const [tenant] = await query(db, "SELECT id FROM tenants WHERE slug='default' AND status='active'");
  const defaultTenantId = Number(tenant?.id);
  if (!Number.isSafeInteger(defaultTenantId) || defaultTenantId <= 0) throw refuse('实际默认企业不存在，不能解释历史 NULL 归属');
  const columns = new Set((await query(db, 'SHOW COLUMNS FROM products')).map(row => row.Field));
  for (const field of ['inventory_number', 'inventory_number_category', 'inventory_number_sequence']) {
    if (!columns.has(field)) throw refuse(`旧库存编号结构缺少 ${field}，请先核对既有编号初始化`);
  }
  const owner = alias => `COALESCE(${alias}.tenant_id,${defaultTenantId})`;
  const products = await query(db, `SELECT p.id,p.tenant_id,p.code,p.selection_id,p.name,p.inventory_number,
    p.inventory_number_category,p.inventory_number_sequence,
    ${columns.has('inventory_number_brand') ? 'p.inventory_number_brand' : 'NULL AS inventory_number_brand'},
    ${columns.has('inventory_number_version') ? 'p.inventory_number_version' : '1 AS inventory_number_version'},
    p.inventory_category,p.vehicle_brand,p.fitment_type,p.vehicle_model,p.vehicle_models_json,
    p.active,p.product_type,p.selection_status,DATE_FORMAT(p.updated_at,'%Y-%m-%d %H:%i:%s.%f') AS updated_at,
    (COALESCE(p.product_type,'main')<>'selection' OR COALESCE(p.selection_status,'draft')='listed'
      OR EXISTS(SELECT 1 FROM sku_mappings sm WHERE sm.product_id=p.id AND sm.active=1 AND ${owner('sm')}=${owner('p')})
      OR EXISTS(SELECT 1 FROM inventory_movements im WHERE im.product_id=p.id AND ${owner('im')}=${owner('p')})) AS inventory_eligible
    FROM products p ORDER BY p.id`);
  const tenants = new Set((await query(db, 'SELECT id FROM tenants')).map(row => Number(row.id)));
  if (products.some(row => !tenants.has(row.tenant_id == null ? defaultTenantId : Number(row.tenant_id)))) throw refuse('产品包含不存在的企业归属，必须先核对，不能自动转入默认企业');
  return { products: stable(products), defaultTenantId };
}

function assertReviewedPlan(manifest, source) {
  if (!manifest || manifest.version !== 2 || !String(manifest.reviewed_by || '').trim() || !String(manifest.reason || '').trim()) throw refuse('需要版本2的完整审核方案、审核人和变更原因');
  const actual = buildInventoryNumberingPlan({ ...source, identityCorrections: manifest.identity_corrections || [] });
  // Reviewer metadata is deliberately separate from deterministic source/plan data.
  const reviewed = { ...manifest }; delete reviewed.reviewed_by; delete reviewed.reason;
  try { assert.deepEqual(reviewed, actual); }
  catch { throw refuse('库存方案前值或编号映射已变化，请重新导出、核对最新完整方案；未写入产品'); }
  return actual;
}

async function inspectReviewedNameAliases(db, plan) {
  const renamed = plan.products.filter(row => Object.hasOwn(row.identity_updates || {}, 'name') && row.identity_updates.name !== row.expected.name);
  if (!renamed.length) return;
  const [table] = await query(db, "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_name_aliases'");
  if (table?.ENGINE !== 'InnoDB') throw refuse('审核名称更正需要现有事务型历史名称表，不能丢失旧名称检索');
  for (const row of renamed) {
    const previous = await query(db, 'SELECT tenant_id,active FROM product_name_aliases WHERE product_id=? AND alias_name=?', [row.product_id,row.expected.name]);
    if (previous.some(alias => Number(alias.active) !== 1 || (alias.tenant_id == null ? plan.default_tenant_id : Number(alias.tenant_id)) !== row.tenant_id)) throw refuse(`产品 ${row.product_id} 的既有旧名称别名已停用或归属异常，请先明确核对，不能自动覆盖`);
  }
}

async function privateFile(filename, payload) {
  if (!filename || !path.isAbsolute(filename)) throw refuse('必须指定源码目录之外的私有绝对备份路径');
  const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const parent = await realpath(path.dirname(filename));
  const relative = path.relative(repository, parent);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw refuse('备份不能位于源码 checkout 或公开资源中');
  if (process.platform !== 'win32' && ((await stat(parent)).mode & 0o077)) throw refuse('备份父目录须为私有权限0700');
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  for (const [file, data] of [[filename, contents], [`${filename}.sha256`, `${createHash('sha256').update(contents).digest('hex')}\n`]]) {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  }
}

async function originalTriggers(db) {
  const records = [];
  for (const name of triggerNames) {
    const rows = await query(db, 'SELECT TRIGGER_NAME,DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?', [name]);
    if (!rows.length) continue;
    const [definition] = await query(db, `SHOW CREATE TRIGGER \`${name}\``);
    const sql = definition['SQL Original Statement'] || definition['Create Trigger'];
    if (!sql || !rows[0].DEFINER) throw refuse('无法备份原库存编号触发器，拒绝切换');
    records.push({ name, definer: rows[0].DEFINER, sql });
  }
  if (!records.some(row => row.name === triggerNames[0]) || !records.some(row => row.name === triggerNames[1])) throw refuse('原库存发号触发器不完整，请先核对现有发号流程');
  return records;
}

function triggerDefiner(db, account) {
  const at = account.lastIndexOf('@');
  if (at < 1) throw refuse('原触发器账户格式无效');
  return `${db.escape(account.slice(0, at))}@${db.escape(account.slice(at + 1))}`;
}

async function restoreTriggers(db, originals) {
  for (const name of triggerNames) await db.query(`DROP TRIGGER IF EXISTS \`${name}\``);
  for (const row of originals) await db.query(row.sql);
}

export async function migrateInventoryNumberingV2(db, { apply = false, manifest = null, backupPath = null, writersStopped = false } = {}) {
  let schema = await inspectInventoryNumberingV2Schema(db);
  if (!manifest) {
    if (backupPath || writersStopped) throw refuse('私有前像备份和停写确认仅用于逐产品审核切换');
    const wouldChange = !schema.schema_ready;
    if (apply) schema = await prepareInventoryNumberingV2Schema(db);
    return { ok: true, mode: apply ? 'schema-applied' : 'dry-run', schema_ready: schema.schema_ready,
      numbering_version: schema.numbering_version, active: schema.active, changes_database: apply && wouldChange,
      schema_would_change: wouldChange, product_numbers_changed: 0 };
  }
  const source = await readInventoryNumberingSource(db);
  const plan = assertReviewedPlan(manifest, source);
  await inspectReviewedNameAliases(db, plan);
  if (!apply) return { ok: true, mode: 'dry-run', schema_ready: schema.schema_ready, numbering_version: schema.numbering_version,
    changes_database: false, reviewed_product_count: plan.products.length, categories: plan.categories.length, brands: plan.brands.length,
    pending_product_count: plan.products.filter(row => row.review_reasons.length).length, source_sha256: plan.source.sha256 };
  if (!writersStopped) throw refuse('编号切换需要明确 --writers-stopped，并先暂停原主服务及候选写入');
  if (!schema.schema_ready || schema.numbering_version !== 1) throw refuse('先完成兼容结构准备；仅允许从未切换的版本1显式迁移，禁止重复重排');
  const [[account]] = await db.query("SELECT SUBSTRING_INDEX(USER(),'@',1) AS username");
  if (account.username !== 'root') throw refuse('编号切换仅允许显式本机MySQL管理员连接');
  for (const table of ['inventory_number_core_categories_v2', 'inventory_number_brands_v2', 'inventory_number_sequences_v2', 'inventory_number_aliases']) {
    const rows = await query(db, `SELECT COUNT(*) AS n FROM ${table}${table === 'inventory_number_core_categories_v2' ? ' WHERE id<>0' : table === 'inventory_number_brands_v2' ? ' WHERE id NOT IN (0,1)' : ''}`);
    if (Number(rows[0].n)) throw refuse(`新编号注册表 ${table} 已包含业务数据，拒绝覆盖或重置`);
  }
  const originals = await originalTriggers(db);
  if (new Set(originals.map(row => row.definer)).size !== 1) throw refuse('原发号触发器账户不一致，拒绝擅自更换权限');
  const before = stable(await query(db, 'SELECT * FROM products ORDER BY id'));
  const registryBefore = stable(await query(db, 'SELECT * FROM inventory_number_categories ORDER BY id'));
  await privateFile(backupPath, { version: 2, purpose: 'inventory-numbering-v2-before-image', captured_at: new Date().toISOString(),
    manifest, products: before, legacy_registry: registryBefore, triggers: originals, source_sha256: plan.source.sha256 });
  let committed = false, changedTriggers = false;
  try {
    // No DDL is issued inside the data transaction. Inactive V2 triggers reject
    // other writers; only this root connection can pass through the reviewed DML.
    changedTriggers = true;
    await installInventoryNumberingV2Triggers(db, { triggerDefiner: triggerDefiner(db, originals[0].definer) });
    await db.beginTransaction();
    const lockedBefore = stable(await query(db, 'SELECT * FROM products ORDER BY id FOR UPDATE'));
    if (hash(lockedBefore) !== hash(before)) throw refuse('备份之后产品已变化，必须重新生成方案和前像备份');
    assertReviewedPlan(manifest, await readInventoryNumberingSource(db));
    await inspectReviewedNameAliases(db, plan);
    await db.query('SET @inventory_numbering_v2_migration=1');
    await db.execute('UPDATE inventory_number_core_categories_v2 SET initial_product_count=? WHERE id=0', [plan.categories.find(row => row.id === 0).initial_product_count]);
    for (const row of plan.brands.filter(row => row.id < 2)) await db.execute('UPDATE inventory_number_brands_v2 SET initial_product_count=? WHERE id=?', [row.initial_product_count, row.id]);
    for (const row of plan.categories) {
      if (row.id === 0) continue;
      await db.execute('INSERT INTO inventory_number_core_categories_v2(id,core_name,initial_product_count) VALUES(?,?,?)', [row.id, row.core_name, row.initial_product_count]);
    }
    for (const row of plan.brands) {
      if (row.id < 2) continue;
      await db.execute('INSERT INTO inventory_number_brands_v2(id,brand_key,initial_product_count) VALUES(?,?,?)', [row.id, row.brand_key, row.initial_product_count]);
    }
    for (const row of plan.counters) await db.execute('INSERT INTO inventory_number_sequences_v2(category_id,brand_id,last_sequence) VALUES(?,?,?)', [row.category_id, row.brand_id, row.last_sequence]);
    for (const row of plan.products) {
      if (row.expected.inventory_number) await db.execute('INSERT INTO inventory_number_aliases(alias_number,product_id,tenant_id) VALUES(?,?,?)', [row.expected.inventory_number, row.product_id, row.tenant_id]);
      const corrections = Object.entries(row.identity_updates || {});
      if (corrections.some(([key]) => !identityFields.has(key))) throw refuse('审核资料更正含非白名单字段，拒绝执行');
      if (Object.hasOwn(row.identity_updates || {}, 'name') && row.identity_updates.name !== row.expected.name) {
        await db.execute("INSERT IGNORE INTO product_name_aliases(tenant_id,product_id,alias_name,alias_type,active) VALUES(?,?,?,'previous_name',1)", [row.tenant_id,row.product_id,row.expected.name]);
        await inspectReviewedNameAliases(db, { ...plan, products: [row] });
      }
      const correctionSql = corrections.map(([key]) => `${key}=?`).join(',');
      const values = corrections.map(([key,value]) => key === 'vehicle_models_json' && value !== null ? JSON.stringify(value) : value);
      const [updated] = await db.execute(`UPDATE products SET inventory_number=?,inventory_number_category=?,inventory_number_brand=?,inventory_number_sequence=?,inventory_number_version=2,${correctionSql ? `${correctionSql},` : ''}updated_at=${corrections.length ? 'CURRENT_TIMESTAMP' : 'updated_at'} WHERE id=?`,
        [row.new_inventory_number, row.category_id, row.brand_id, row.sequence, ...values, row.product_id]);
      if (updated.affectedRows !== 1) throw refuse(`审核产品 ${row.product_id} 更新数量异常`);
    }
    await db.execute('UPDATE inventory_numbering_state SET version=2 WHERE id=1 AND version=1');
    const after = stable(await query(db, 'SELECT * FROM products ORDER BY id'));
    assert.equal(after.length, before.length, 'Product count changed');
    const planById = new Map(plan.products.map(row => [String(row.product_id), row]));
    for (let i = 0; i < before.length; i++) {
      const previous = before[i], current = after[i], target = planById.get(String(previous.id));
      const approvedIdentity = target?.identity_updates || {};
      const corrected = Object.keys(approvedIdentity).length > 0;
      const withoutNumbers = value => Object.fromEntries(Object.entries(value).filter(([key]) => !numberFields.has(key) && !(corrected && key === 'updated_at')));
      assert.deepEqual(withoutNumbers(current), withoutNumbers({ ...previous, ...approvedIdentity }), 'Unexpected changes beyond numbering fields and explicit reviewed identity corrections');
      if (target) {
        assert.equal(current.inventory_number, target.new_inventory_number);
        assert.equal(Number(current.inventory_number_category), target.category_id);
        assert.equal(Number(current.inventory_number_brand), target.brand_id);
        assert.equal(Number(current.inventory_number_sequence), target.sequence);
        assert.equal(Number(current.inventory_number_version), 2);
      } else assert.deepEqual(current, previous, 'Unreviewed product changed');
    }
    assert.deepEqual(stable(await query(db, 'SELECT * FROM inventory_number_categories ORDER BY id')), registryBefore, 'Legacy counters changed');
    const inspected = await inspectInventoryNumberingV2Schema(db);
    if (!inspected.active) throw refuse('V2注册表、活动状态和三支触发器未同时就绪，回滚产品编号');
    await db.commit();
    committed = true;
    await db.query('SET @inventory_numbering_v2_migration=NULL');
    return { ok: true, mode: 'reviewed-manifest-applied', changes_database: true, numbering_version: 2,
      reviewed_product_count: plan.products.length, old_aliases_preserved: plan.products.filter(row => row.expected.inventory_number).length,
      reviewed_identity_correction_count: plan.identity_corrections?.length || 0,
      unreviewed_non_number_product_fields_preserved: true, legacy_registry_preserved: true, backup_path: backupPath, source_sha256: plan.source.sha256 };
  } catch (error) {
    if (!committed) {
      await db.rollback();
      try { await db.query('SET @inventory_numbering_v2_migration=NULL'); }
      finally {
        // A COMMIT acknowledgement can be lost. Restore V1 only after reading
        // authoritative state 1; otherwise the release recovery opens a fresh
        // administrator connection and preserves whichever transaction committed.
        if (changedTriggers) {
          const [state] = await query(db, 'SELECT version FROM inventory_numbering_state WHERE id=1');
          if (Number(state?.version) === 1) await restoreTriggers(db, originals);
        }
      }
    }
    throw error;
  }
}

// A release interrupted between trigger DDL and COMMIT must restore the matching
// trigger generation before any previous application process is restarted.
export async function recoverInventoryNumberingCutover(db, backupPath) {
  if (!path.isAbsolute(backupPath || '')) throw refuse('恢复需要明确的私有前像备份绝对路径');
  const contents = await readFile(backupPath, 'utf8');
  const digest = (await readFile(`${backupPath}.sha256`, 'utf8')).trim();
  if (createHash('sha256').update(contents).digest('hex') !== digest) throw refuse('编号前像备份摘要不一致，拒绝恢复触发器');
  const saved = JSON.parse(contents);
  if (saved.version !== 2 || saved.purpose !== 'inventory-numbering-v2-before-image' || !Array.isArray(saved.triggers)
    || saved.triggers.some(row => !triggerNames.includes(row.name) || typeof row.sql !== 'string' || !row.definer)
    || saved.triggers.length < 2 || new Set(saved.triggers.map(row => row.definer)).size !== 1) throw refuse('编号恢复点格式或原触发器身份无效');
  const [[account]] = await db.query("SELECT SUBSTRING_INDEX(USER(),'@',1) AS username");
  if (account.username !== 'root') throw refuse('编号恢复仅允许本机MySQL管理员');
  const schema = await inspectInventoryNumberingV2Schema(db);
  if (schema.numbering_version === 1) {
    const current = await query(db, 'SELECT id,inventory_number,inventory_number_category,inventory_number_brand,inventory_number_sequence,inventory_number_version FROM products ORDER BY id');
    const fields = ['id', ...numberFields];
    const numbers = rows => rows.map(row => Object.fromEntries(fields.map(key => [key, row[key]])));
    assert.deepEqual(stable(numbers(current)), numbers(saved.products), 'Version 1 product numbers differ from the saved rollback point');
    await restoreTriggers(db, saved.triggers);
    return { ok: true, mode: 'cutover-recovered', numbering_version: 1, product_numbers_changed: 0, restored_legacy_triggers: true };
  }
  if (schema.numbering_version !== 2 || !schema.schema_ready) throw refuse('恢复点对应的编号结构状态不兼容，保持停写并人工核对');
  if (!schema.triggers_ready) await installInventoryNumberingV2Triggers(db, { triggerDefiner: triggerDefiner(db, saved.triggers[0].definer) });
  if (!(await inspectInventoryNumberingV2Schema(db)).active) throw refuse('V2发号触发器尚未恢复，不能启动旧服务');
  return { ok: true, mode: 'cutover-recovered', numbering_version: 2, product_numbers_changed: 0, preserved_committed_v2: true };
}

export async function runInventoryNumberingMigrationCli(args) {
  const options = new Map();
  for (const arg of args) {
    const match = /^--(database|mysql-admin-socket|manifest|backup|export-plan|recover|apply|writers-stopped)(?:=(.*))?$/.exec(arg);
    if (!match || options.has(match[1]) || (['apply','writers-stopped'].includes(match[1]) ? match[2] !== undefined : !match[2])) throw refuse('未知或重复的编号迁移参数');
    options.set(match[1], match[2] ?? true);
  }
  const database = options.get('database'), socketPath = options.get('mysql-admin-socket');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database || '') || typeof socketPath !== 'string' || !(socketPath.startsWith('/') || socketPath.startsWith('\\\\.\\pipe\\'))) throw refuse('必须显式指定数据库及本机管理员socket或named pipe；不读取应用配置，不接受TCP');
  if (options.has('export-plan') && (options.has('apply') || options.has('manifest') || options.has('backup') || options.has('writers-stopped'))) throw refuse('导出方案仅允许只读模式，不能与apply/manifest/backup/停写参数混用');
  if (options.has('recover') && (!options.has('apply') || !options.has('writers-stopped') || options.has('manifest') || options.has('backup') || options.has('export-plan'))) throw refuse('恢复仅接受 --apply --writers-stopped --recover=私有前像路径，不可混用其他操作');
  const manifest = options.has('manifest') ? JSON.parse(await readFile(options.get('manifest'), 'utf8')) : null;
  if (options.has('apply') && manifest && !options.has('backup')) throw refuse('审核编号切换必须提供私有前像备份路径');
  const { default: mysql } = await import('mysql2/promise');
  const db = await mysql.createConnection({ database, socketPath, user: 'root', timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  let locked = false;
  try {
    await db.query('SET SESSION lock_wait_timeout=5');
    await db.query('SET SESSION innodb_lock_wait_timeout=5');
    await db.query('SET SESSION max_execution_time=15000');
    await db.query("SET SESSION time_zone='+00:00'");
    if (options.has('apply')) {
      const [[lock]] = await db.query("SELECT GET_LOCK('inventory_numbering_schema_v1',5) AS acquired");
      if (Number(lock.acquired) !== 1) throw refuse('库存编号维护锁不可用，现有编号未切换');
      locked = true;
    } else await db.query('START TRANSACTION READ ONLY');
    if (options.has('recover')) return await recoverInventoryNumberingCutover(db, options.get('recover'));
    if (options.has('export-plan')) {
      const plan = buildInventoryNumberingPlan(await readInventoryNumberingSource(db));
      await privateFile(options.get('export-plan'), plan);
      return { ok: true, mode: 'plan-exported', changes_database: false, source_rows: plan.source.row_count, reviewed_product_count: plan.products.length, source_sha256: plan.source.sha256 };
    }
    return await migrateInventoryNumberingV2(db, { apply: options.has('apply'), manifest, backupPath: options.get('backup'), writersStopped: options.has('writers-stopped') });
  } finally {
    try { if (locked) await db.query("SELECT RELEASE_LOCK('inventory_numbering_schema_v1')"); else await db.rollback(); }
    finally { await db.end(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInventoryNumberingMigrationCli(process.argv.slice(2)).then(report => console.log(JSON.stringify(report,null,2))).catch(error => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'INVENTORY_NUMBERING_MIGRATION_REFUSED', error: error.safe ? error.message : '编号迁移拒绝执行；原始数据库和产品数据不输出到发布日志' }));
    process.exitCode = 1;
  });
}
