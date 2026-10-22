import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { AI_IMAGE_TASK_OWNERS_SCHEMA, TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA } from "../src/services/ai-tenant-schema.js";

import { AI_BACKGROUND_TENANT_TABLES } from '../src/services/ai-background-tenant-tables.js';
export { AI_BACKGROUND_TENANT_TABLES } from '../src/services/ai-background-tenant-tables.js';

export async function migrateTenantAiBackground(connection, { apply = false } = {}) {
  const report = [];
  let locked = false;
  try {
  if (apply) {
    const [[lock]] = await connection.query("SELECT GET_LOCK(CONCAT('ai_tenant_', LEFT(SHA2(DATABASE(), 256), 32)), 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("AI enterprise migration lock unavailable");
    locked = true;
    for (const schema of [AI_IMAGE_TASK_OWNERS_SCHEMA, TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA]) await connection.query(schema);
  }
  for (const [table, unique, key] of AI_BACKGROUND_TENANT_TABLES) {
    const [found] = await connection.execute("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [table]);
    if (!found.length) { report.push({ table, exists: false }); continue; }
    const [columns] = await connection.query(`SHOW COLUMNS FROM ${table}`);
    const hasTenant = columns.some(column => column.Field === "tenant_id");
    const [indexes] = await connection.query(`SHOW INDEX FROM ${table}`);
    const indexColumns = indexes.filter(index => index.Key_name === unique).sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name);
    const needsUnique = Boolean(unique && indexColumns.join(",") !== `tenant_id,${key}`);
    if (apply && !hasTenant) await connection.query(`ALTER TABLE ${table} ADD COLUMN tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin' AFTER id`);
    if (apply && needsUnique) await connection.query(`ALTER TABLE ${table} ${indexColumns.length ? `DROP INDEX ${unique}, ` : ""}ADD UNIQUE KEY ${unique} (tenant_id, ${key})`);
    if (apply) {
      const [verifiedColumns] = await connection.query(`SHOW COLUMNS FROM ${table}`);
      const tenantColumn = verifiedColumns.find(column => column.Field === "tenant_id");
      const [verifiedIndexes] = await connection.query(`SHOW INDEX FROM ${table}`);
      const scopedUnique = verifiedIndexes.filter(index => index.Key_name === unique && Number(index.Non_unique) === 0)
        .sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name);
      if (!tenantColumn || !/^varchar\((?:64|80)\)$/i.test(tenantColumn.Type) || tenantColumn.Null !== "NO"
        || tenantColumn.Default !== "admin" || (unique && scopedUnique.join(",") !== `tenant_id,${key}`)) {
        throw new Error(`AI enterprise migration verification failed: ${table}`);
      }
    }
    report.push({ table, exists: true, add_tenant_column: !hasTenant, replace_unique: needsUnique });
  }
  if (apply) {
    for (const table of ["ai_image_task_owners", "tenant_ai_limits", "tenant_ai_usage"]) {
      const [columns] = await connection.query(`SHOW COLUMNS FROM ${table}`);
      const [indexes] = await connection.query(`SHOW INDEX FROM ${table}`);
      const expectedKey = table === "ai_image_task_owners" ? "task_id" : table === "tenant_ai_usage" ? "tenant_id,period_key" : "tenant_id";
      const actualKey = indexes.filter(index => index.Key_name === "PRIMARY").sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name).join(",");
      if (!columns.some(column => column.Field === "tenant_id" && column.Null === "NO") || actualKey !== expectedKey) {
        throw new Error(`AI enterprise schema verification failed: ${table}`);
      }
    }
  }
  return { ok: true, mode: apply ? "apply" : "dry-run", legacy_scope: "admin/default only; no enterprise memberships are inferred", tables: report,
    create_tables: ["ai_image_task_owners", "tenant_ai_limits", "tenant_ai_usage"] };
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT('ai_tenant_', LEFT(SHA2(DATABASE(), 256), 32)))");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = flag => args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const socketPath = value("--mysql-admin-socket");
  const database = value("--database");
  if (!socketPath || !database) throw new Error("Explicit --mysql-admin-socket and --database are required; the script never loads business database defaults");
  const connection = await mysql.createConnection({ socketPath, database, user: "root" });
  try { console.log(JSON.stringify(await migrateTenantAiBackground(connection, { apply: args.includes("--apply") }), null, 2)); }
  finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
