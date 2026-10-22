import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";

export const TEAM_TENANT_TABLES = [
  ["team_tasks", "uk_team_tasks_automation_key", ["tenant_id", "automation_key"]],
  ["team_operational_owners", "PRIMARY", ["tenant_id", "work_type"]],
  ["product_development_projects"], ["product_development_candidates"], ["product_development_ideas"],
  ["product_development_idea_products", "PRIMARY", ["tenant_id", "idea_id", "product_id"]],
  ["product_development_idea_drafts", "PRIMARY", ["tenant_id", "idea_id", "draft_id"]],
  ["product_development_task_links", "PRIMARY", ["tenant_id", "task_id"]],
  ["product_development_heatmap_orders", "PRIMARY", ["tenant_id", "period_key", "dimension", "coordinate_hash"]]
];

export async function migrateTenantTeamTasks(connection, { apply = false } = {}) {
  let locked = false;
  const report = [];
  try {
    if (apply) {
      const [[lock]] = await connection.query("SELECT GET_LOCK(CONCAT('team_tenant_', LEFT(SHA2(DATABASE(),256),32)),60) AS acquired");
      if (Number(lock.acquired) !== 1) throw new Error("Team enterprise migration lock unavailable");
      locked = true;
    }
    for (const [table, keyName, expectedColumns] of TEAM_TENANT_TABLES) {
      const [found] = await connection.execute("SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?", [table]);
      if (!found.length) { report.push({ table, exists: false }); continue; }
      const [columns] = await connection.query(`SHOW COLUMNS FROM ${table}`);
      const hasTenant = columns.some(column => column.Field === "tenant_id");
      const [indexes] = await connection.query(`SHOW INDEX FROM ${table}`);
      const current = indexes.filter(index => index.Key_name === keyName).sort((a,b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name);
      const replaceKey = Boolean(keyName && current.join(",") !== expectedColumns.join(","));
      if (apply && !hasTenant) await connection.query(`ALTER TABLE ${table} ADD COLUMN tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin' FIRST`);
      if (apply && replaceKey) {
        const drop = current.length ? keyName === "PRIMARY" ? "DROP PRIMARY KEY, " : `DROP INDEX ${keyName}, ` : "";
        await connection.query(`ALTER TABLE ${table} ${drop}ADD ${keyName === "PRIMARY" ? "PRIMARY KEY" : `UNIQUE KEY ${keyName}`} (${expectedColumns.join(",")})`);
      }
      if (apply) {
        const [verifiedColumns] = await connection.query(`SHOW COLUMNS FROM ${table}`);
        const tenant = verifiedColumns.find(column => column.Field === "tenant_id");
        const [verifiedIndexes] = await connection.query(`SHOW INDEX FROM ${table}`);
        const verifiedKey = verifiedIndexes.filter(index => index.Key_name === keyName && Number(index.Non_unique) === 0)
          .sort((a,b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name);
        if (!tenant || tenant.Type !== "varchar(64)" || tenant.Null !== "NO" || tenant.Default !== "admin"
          || (keyName && verifiedKey.join(",") !== expectedColumns.join(","))) throw new Error(`Team enterprise migration verification failed: ${table}`);
      }
      report.push({ table, exists: true, add_tenant_column: !hasTenant, replace_key: replaceKey });
    }
    return { ok: true, mode: apply ? "apply" : "dry-run", legacy_scope: "admin/default only; no memberships inferred", tables: report };
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT('team_tenant_', LEFT(SHA2(DATABASE(),256),32)))");
  }
}

async function main() {
  const args = process.argv.slice(2), value = flag => args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const socketPath = value("--mysql-admin-socket"), database = value("--database");
  if (!socketPath || !database) throw new Error("Explicit --mysql-admin-socket and --database are required; business database defaults are never loaded");
  const connection = await mysql.createConnection({ socketPath, database, user: "root" });
  try { console.log(JSON.stringify(await migrateTenantTeamTasks(connection, { apply: args.includes("--apply") }), null, 2)); }
  finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
