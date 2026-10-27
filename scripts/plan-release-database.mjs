import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SCHEMA_MIGRATIONS, migrationNeedsApply } from "./lib/release-database-plan.mjs";
import { inspectReleaseProfitSchema } from "./lib/release-profit-schema.mjs";

const execute = promisify(execFile);

export async function inspectProfitSchema({ database, socketPath }) {
  const { default: mysql } = await import("mysql2/promise");
  const connection = await mysql.createConnection({ database, socketPath, user: "root", connectTimeout: 10000 });
  try {
    await connection.query("SET SESSION MAX_EXECUTION_TIME=15000");
    await connection.query("START TRANSACTION READ ONLY");
    return await inspectReleaseProfitSchema(async (sql, params = []) => (await connection.query(sql, params))[0]);
  } finally { await connection.end(); }
}

export async function planReleaseDatabase({ root, database, socketPath, run = execute, inspectProfit = inspectProfitSchema }) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database || "") || !path.isAbsolute(socketPath || "")) throw Error("Explicit database and absolute administrator socket are required");
  // CLI main guards compare real import URLs; resolve a current-release link once.
  root = await fs.realpath(root);
  const pending = [], checked = [];
  for (const filename of SCHEMA_MIGRATIONS) {
    const script = path.join(root, "scripts", filename);
    try { await fs.access(script); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    let report;
    try {
      if (filename === "migrate-order-profit-calculation-versions.mjs") {
        report = await inspectProfit({ database, socketPath });
      } else {
        const { stdout } = await run(process.execPath, [script, `--database=${database}`, `--mysql-admin-socket=${socketPath}`], {
          cwd: root, env: { ...process.env, DB_NAME: database }, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
        });
        report = JSON.parse(stdout);
      }
      if (migrationNeedsApply(filename, report)) pending.push(filename);
      checked.push(filename);
    } catch {
      // CLI output can contain database details; keep production logs bounded.
      throw Error(`Read-only database preflight refused: ${filename}`);
    }
  }
  return { database, checked_migrations: checked, pending_migrations: pending };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), values = new Map();
    for (const arg of args) {
      const match = /^--(database|mysql-admin-socket)=(.+)$/.exec(arg);
      if (arg === "--pending-only" && !values.has("pending-only")) values.set("pending-only", true);
      else if (match && !values.has(match[1])) values.set(match[1], match[2]);
      else throw Error("Unknown or duplicate release database plan argument");
    }
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const plan = await planReleaseDatabase({ root, database: values.get("database"), socketPath: values.get("mysql-admin-socket") });
    process.stdout.write(values.has("pending-only") ? plan.pending_migrations.join("\n") : JSON.stringify(plan) + "\n");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
