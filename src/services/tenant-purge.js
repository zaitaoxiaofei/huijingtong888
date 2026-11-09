import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mysqlQuery, mysqlExecute, withMysqlTransaction } from '../mysql-pool.js';
import { ensureTenantSchemaMysql } from './tenants.js';
import { getPlatformGrantMysql } from './platform-grants.js';
import { tenantLifecycle } from './tenant-lifecycle.js';
import { buildTenantPurgeScopes, purgeIdentifier } from './tenant-purge-scope.js';
import { resolveUploadSubdirRoots } from '../runtime-uploads.js';

import { TENANT_PURGE_SCHEMA } from "./tenant-lifecycle-schema.js";
export { TENANT_PURGE_SCHEMA };

const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const activeJobTables = ['ai_generation_tasks', 'asset_variant_jobs', 'ai_material_optimization_batches', 'ai_variant_lab_batch_jobs', 'listing_publish_tasks', 'product_workflow_jobs', 'ai_credit_tasks', 'seller_analytics_collect_runs', 'listing_ozon_copy_jobs', 'listing_ozon_seller_media_upload_jobs', 'ai_image_optimizer_jobs', 'ai_variant_draft_save_batches'];


export function createTenantPurgeService(overrides = {}) {
  const deps = { query: mysqlQuery, execute: mysqlExecute, transaction: withMysqlTransaction,
    prepare: ensureTenantSchemaMysql, grant: getPlatformGrantMysql, now: Date.now, ...overrides };
  let schemaReady;
  async function prepare() {
    await deps.prepare();
    if (!schemaReady) schemaReady = (async () => { for (const sql of TENANT_PURGE_SCHEMA) await deps.execute(sql); })().catch(error => { schemaReady = null; throw error; });
    await schemaReady;
  }
  async function platform(session) {
    if (session?.platform_role !== 'super_admin' || !(await deps.grant(session.personId))) fail('仅平台超级管理员可以永久删除客户企业', 403);
  }
  async function inspect(connection, tenantId, lock = false, automatic = false) {
    const id = Number(tenantId);
    if (!Number.isSafeInteger(id) || id <= 0) fail('请选择有效客户企业', 400);
    const [rows] = await connection.execute(`SELECT * FROM tenants WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
    const tenant = rows[0];
    if (!tenant) fail('企业已不存在，请刷新客户空间列表', 404);
    if (tenant.slug === 'default') fail('汇进通企业是受保护的内部企业，不能永久删除', 403);
    if (automatic && !tenantLifecycle(tenant, deps.now()).retention_due) return { skipped: true };
    if (!automatic && !tenantLifecycle(tenant, deps.now()).can_permanently_delete) fail('请先归档或暂停客户空间；有效客户不能直接永久删除');
    const [columns] = await connection.execute("SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION");
    const [foreignKeys] = await connection.execute('SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL');
    const scopes = buildTenantPurgeScopes(columns, foreignKeys);
    const [engines] = await connection.execute("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
    const engineByTable = new Map(engines.map(row => [row.TABLE_NAME, row.ENGINE]));
    if ([...scopes.order, "tenants", "tenant_purge_audit", "tenant_purge_files"].some(table => engineByTable.get(table) !== "InnoDB")) fail("企业清理涉及非事务数据表，需先完成存储引擎检查，未执行删除", 503);
    const counts = {};
    for (const table of scopes.order) {
      const own = scopes.predicate(table, id);
      const [rows] = await connection.execute(`SELECT COUNT(*) AS n FROM ${purgeIdentifier(table)} r WHERE ${own.sql}`, own.params);
      if (Number(rows[0].n)) counts[table] = Number(rows[0].n);
    }
    for (const table of activeJobTables) {
      if (!scopes.tables.get(table)?.has('status')) continue;
      const own = scopes.predicate(table, id);
      const [running] = await connection.execute(`SELECT COUNT(*) AS n FROM ${purgeIdentifier(table)} r WHERE ${own.sql} AND r.status IN ('running','processing','generating','dispatching','submitted')`, own.params);
      if (Number(running[0].n)) fail(`该企业仍有 ${running[0].n} 个执行中的后台任务（${table}），请先取消或等待结束后再删除`);
    }
    const review = { tenant_id: id, name: tenant.name, slug: tenant.slug, status: tenant.status,
      subscription_status: tenant.subscription_status, expires_at: tenant.subscription_expires_at,
      updated_at: tenant.updated_at, counts, policy: 'tenant-purge-v1' };
    return { tenant, columns, scopes, preview: { ...review, total_rows: Object.values(counts).reduce((sum, n) => sum + n, 0), fingerprint: fingerprint(review) } };
  }
  async function purge(tenantId, { session, expectedFingerprint, confirmationName, automatic = false } = {}) {
    if (!automatic) await platform(session);
    await prepare();
    const result = await deps.transaction(async connection => {
      const inspected = await inspect(connection, tenantId, true, automatic);
      if (inspected.skipped) return { skipped: true, reason: 'renewed_or_not_due' };
      const { tenant, scopes, preview } = inspected;
      // The tenant lock is shared with redemption/renewal paths. Recheck at the
      // destructive boundary so a renewed enterprise can never be swept by an old plan.
      if (automatic && !tenantLifecycle(tenant, deps.now()).retention_due) return { skipped: true, reason: 'renewed_or_not_due' };
      if (!automatic && (confirmationName !== tenant.name || expectedFingerprint !== preview.fingerprint)) fail('企业状态或数据量已变化，请重新查看删除清单并输入完整企业名称确认');
      const id = Number(tenant.id);
      if (scopes.tables.has('tenant_private_files')) {
        const [files] = await connection.execute('SELECT storage_name FROM tenant_private_files WHERE tenant_id = ?', [id]);
        for (const file of files) await connection.execute("INSERT IGNORE INTO tenant_purge_files (tenant_id,kind,storage_name) VALUES (?,'private_attachment',?)", [id, file.storage_name]);
      }
      await connection.execute("INSERT IGNORE INTO tenant_purge_files (tenant_id,kind,storage_name) VALUES (?,'ai_results',?)", [id, String(id)]);
      for (const table of scopes.order) {
        const own = scopes.predicate(table, id);
        await connection.execute(`DELETE r FROM ${purgeIdentifier(table)} r WHERE ${own.sql}`, own.params);
      }
      // Global login identities and grants are separate from enterprise data.
      // Keep them intact; only sessions whose active enterprise is this target
      // are removed by the scoped deletion above.
      await connection.execute('DELETE FROM tenants WHERE id = ? AND slug <> ?', [id, 'default']);
      await connection.execute('INSERT INTO tenant_purge_audit (tenant_id,reason,actor_person_id,row_counts_json) VALUES (?,?,?,?)',
        [id, automatic ? 'expired_30_days' : 'platform_reviewed', automatic ? null : Number(session.personId), JSON.stringify(preview.counts)]);
      return { ok: true, tenant_id: id, deleted_rows: preview.total_rows, files_cleanup: 'queued' };
    });
    return result;
  }
  return {
    prepare,
    async preview(tenantId, session) { await platform(session); await prepare(); return deps.transaction(async connection => (await inspect(connection, tenantId)).preview); },
    remove: (body, session) => purge(body.tenant_id, { session, expectedFingerprint: body.fingerprint, confirmationName: body.confirmation_name }),
    async sweep() {
      await prepare();
      const candidates = await deps.query(`SELECT id FROM tenants WHERE slug <> 'default' AND subscription_expires_at IS NOT NULL
        AND subscription_expires_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) ORDER BY subscription_expires_at,id LIMIT 5`);
      const results = [], errors = [];
      for (const row of candidates) {
        try { results.push(await purge(row.id, { automatic: true })); }
        catch (error) { errors.push({ tenant_id: Number(row.id), error: error.message }); }
      }
      return { results, errors };
    }
  };
}

// File work is durable and retried separately from the database transaction.
// Shared public/OSS media follows the existing platform reference-aware GC;
// never delete a shared content-addressed object just because one tenant left.
export async function cleanupTenantPurgeFiles({ query = mysqlQuery, execute = mysqlExecute,
  attachmentRoots = [...new Set([...resolveUploadSubdirRoots('team-attachments'), path.resolve('public', 'uploads', 'team-attachments')])], aiRoot = process.env.AI_CREDIT_RESULT_ROOT || path.resolve('data/ai-credit-results') } = {}) {
  const jobs = await query("SELECT id,tenant_id,kind,storage_name FROM tenant_purge_files WHERE status = 'pending' ORDER BY COALESCE(last_attempt_at, '1970-01-01'),id LIMIT 100");
  let completed = 0;
  for (const job of jobs) {
    try {
      if (!Number.isSafeInteger(Number(job.tenant_id)) || Number(job.tenant_id) <= 0) throw new Error('Invalid purge tenant');
      if (job.kind === 'private_attachment') {
        if (!/^[^/\\\x00-\x1f?#%]{1,255}$/.test(job.storage_name) || ['.', '..'].includes(job.storage_name)) throw new Error('Invalid attachment basename');
        const references = await query('SELECT 1 FROM tenant_private_files WHERE storage_name = ? LIMIT 1', [job.storage_name]);
        if (references.length) throw new Error('附件仍被引用，保留并等待人工检查');
        for (const root of new Set(attachmentRoots)) {
          const realRoot = await fs.realpath(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (realRoot) await fs.unlink(path.join(realRoot, job.storage_name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      } else if (job.kind === 'ai_results') {
        if (job.storage_name !== String(job.tenant_id)) throw new Error('AI result tenant mismatch');
        const realRoot = await fs.realpath(aiRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (realRoot) {
          if (realRoot === path.parse(realRoot).root) throw new Error("AI result root cannot be a filesystem root");
          const target = path.join(realRoot, String(job.tenant_id));
          const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (stat?.isSymbolicLink()) throw new Error('Refusing symlink result directory');
          if (stat) await fs.rm(target, { recursive: true });
        }
      } else throw new Error('Unknown purge file kind');
      await execute("UPDATE tenant_purge_files SET status = 'done', last_error = NULL, last_attempt_at = UTC_TIMESTAMP() WHERE id = ?", [job.id]); completed++;
    } catch (error) {
      await execute('UPDATE tenant_purge_files SET last_error = ?, last_attempt_at = UTC_TIMESTAMP() WHERE id = ?', [String(error.message).slice(0, 500), job.id]);
    }
  }
  return { completed, pending: jobs.length - completed };
}
export const tenantPurge = createTenantPurgeService();
