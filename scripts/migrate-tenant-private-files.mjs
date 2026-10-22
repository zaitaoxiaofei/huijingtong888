import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { resolveUploadSubdirRoots } from "../src/runtime-uploads.js";
import { TENANT_PRIVATE_FILES_SCHEMA } from "../src/services/tenant-private-files.js";
import { TENANT_INVENTORY_SALES_REFRESH_SCHEMA } from "../src/services/mysql-inventory-alert-snapshots.js";

const apply = process.argv.includes("--apply");
const backfill = process.argv.includes("--backfill-legacy-default");
const socketPath = process.argv.find(arg => arg.startsWith("--mysql-admin-socket="))?.slice("--mysql-admin-socket=".length);
const explicitRoots = process.argv.filter(arg => arg.startsWith("--legacy-root=")).map(arg => arg.slice("--legacy-root=".length));
const roots = [...new Set((explicitRoots.length ? explicitRoots : resolveUploadSubdirRoots("team-attachments")).map(root => path.resolve(root)))];
const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8" };

async function inspect(query) {
  const [tenant] = await query("SELECT id FROM tenants WHERE slug='default' AND status='active' LIMIT 1");
  if (!tenant) throw new Error("Active default enterprise required for legacy attachment audit");
  const registryExists = (await query("SHOW TABLES LIKE 'tenant_private_files'")).length > 0;
  const vouchersExist = (await query("SHOW TABLES LIKE 'finance_vouchers'")).length > 0;
  const vouchers = vouchersExist ? await query("SELECT attachment_url, tenant_id FROM finance_vouchers WHERE attachment_url LIKE '%/uploads/team-attachments/%'") : [];
  const financeNames = new Set();
  for (const row of vouchers) {
    const name = path.posix.basename(row.attachment_url);
    if (registryExists && (await query("SELECT id FROM tenant_private_files WHERE storage_name=? LIMIT 1", [name])).length) continue;
    if (row.tenant_id != null && Number(row.tenant_id) !== 0 && Number(row.tenant_id) !== Number(tenant.id)) {
      throw new Error("Legacy attachments have non-default enterprise references; explicit ownership review required");
    }
    financeNames.add(name);
  }
  const files = new Map();
  for (const root of roots) {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.length > 255 || /[/\\\x00-\x1f?#%]/.test(entry.name)) throw new Error("Unexpected legacy attachment entry; manual review required");
      const stat = await fs.stat(path.join(root, entry.name));
      const prior = files.get(entry.name);
      if (prior && prior.size !== stat.size) throw new Error("Legacy attachment filename collision has different sizes");
      files.set(entry.name, { size: stat.size, purpose: financeNames.has(entry.name) ? "finance" : "team" });
    }
  }
  if (registryExists) for (const [name] of files) {
    const [existing] = await query("SELECT tenant_id, byte_size FROM tenant_private_files WHERE storage_name=?", [name]);
    if (existing) files.delete(name); // A registered file is never reassigned.
  }
  const syncExists = (await query("SHOW TABLES LIKE 'sync_logs'")).length > 0;
  const syncColumns = syncExists ? await query("SHOW COLUMNS FROM sync_logs LIKE 'tenant_id'") : [];
  const syncIndexes = syncExists ? await query("SHOW INDEX FROM sync_logs WHERE Key_name='idx_sync_logs_tenant_id'") : [];
  return { tenantId: Number(tenant.id), registryExists, files, syncExists, syncColumn: syncColumns.length > 0, syncIndex: syncIndexes.length > 0 };
}

async function run() {
  if (apply && !socketPath) throw new Error("Apply requires --mysql-admin-socket");
  const connection = socketPath ? await mysql.createConnection({ socketPath, user: "root", database: config.dbName }) : null;
  const query = connection ? async (sql, params = []) => (await connection.query(sql, params))[0] : mysqlQuery;
  const lockName = "tenant_private_files_v1";
  try {
    if (apply) {
      const [lock] = await query("SELECT GET_LOCK(?, 60) AS acquired", [lockName]);
      if (Number(lock.acquired) !== 1) throw new Error("Private file migration lock unavailable");
    }
    const before = await inspect(query);
    const summary = { legacy_files: before.files.size, legacy_finance_files: [...before.files.values()].filter(file => file.purpose === "finance").length, registry_exists: before.registryExists, sync_tenant_column: before.syncColumn };
    if (!apply) return console.log(JSON.stringify({ ok: true, mode: "dry-run", changes_database: false, ...summary }));
    if (before.files.size && !backfill) throw new Error("Legacy files require explicit --backfill-legacy-default; files were only accepted by the default enterprise before this release");
    await query(TENANT_PRIVATE_FILES_SCHEMA);
    await query(TENANT_INVENTORY_SALES_REFRESH_SCHEMA);
    if (before.syncExists && !before.syncColumn) await query("ALTER TABLE sync_logs ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id");
    if (before.syncExists && !before.syncIndex) await query("ALTER TABLE sync_logs ADD KEY idx_sync_logs_tenant_id (tenant_id, id)");
    await connection.beginTransaction();
    try {
      if (backfill) for (const [name, file] of before.files) await query(`INSERT INTO tenant_private_files
        (tenant_id, storage_name, original_name, purpose, content_type, byte_size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [before.tenantId, name, name, file.purpose, mime[path.extname(name).toLowerCase()] || "application/octet-stream", file.size]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    console.log(JSON.stringify({ ok: true, mode: "apply", ...summary, registered_default_files: backfill ? before.files.size : 0, memberships_changed: 0 }));
  } finally {
    if (connection) {
      if (apply) await query("SELECT RELEASE_LOCK(?)", [lockName]);
      await connection.end();
    }
  }
}
try { await run(); } finally { await closeMysqlPool(); }
