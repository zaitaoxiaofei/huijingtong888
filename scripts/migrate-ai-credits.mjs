import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { AI_CREDIT_SCHEMAS, AI_CREDIT_TABLES } from "../src/services/ai-credit-schema.js";

const uniqueKeys = {
  ai_credit_accounts: { PRIMARY: "tenant_id", uq_ai_credit_account_key: "account_key" },
  ai_credit_prices: { PRIMARY: "id", uq_ai_credit_price_version: "price_key,version" },
  ai_credit_tasks: { PRIMARY: "id", uq_ai_credit_task_key: "tenant_id,idempotency_key" },
  ai_credit_attempts: { PRIMARY: "id", uq_ai_credit_attempt_key: "task_id,attempt_key", uq_ai_credit_attempt_number: "task_id,attempt_number" },
  ai_credit_entries: { PRIMARY: "id", uq_ai_credit_entry_key: "tenant_id,entry_key" }
};
const typeOf = value => String(value).toLowerCase().replace(/^(bigint|int|tinyint)\(\d+\)/, "$1");
const expressionOf = value => String(value || "").toLowerCase().replace(/[`\s()]/g, "");

// Read the checked-in one-column-per-line schema, rather than maintaining a
// second list of money fields that can drift when the ledger adds a column.
function expectedColumns(sql) {
  const columns = new Map();
  for (const line of sql.split("\n").slice(1)) {
    const match = line.match(/^\s+([a-z_][a-z0-9_]*)\s+((?:BIGINT|INT|TINYINT)(?: UNSIGNED)?|(?:CHAR|VARCHAR|DATETIME)\(\d+\))(.*?)(?:,)?$/i);
    if (!match) {
      if (/^\s+[a-z_][a-z0-9_]*\s/i.test(line) && !/^\s+(?:UNIQUE|PRIMARY|KEY|CHECK|CONSTRAINT)\b/i.test(line)) throw new Error("Unsupported canonical AI credit column definition");
      continue;
    }
    const [, name, type, suffix] = match;
    const declaredDefault = suffix.match(/\bDEFAULT\s+('([^']*)'|-?\d+|CURRENT_TIMESTAMP\(\d+\))/i);
    columns.set(name, { type: typeOf(type), nullable: !/\bNOT NULL\b|\bPRIMARY KEY\b/i.test(suffix),
      charset: suffix.match(/\bCHARACTER SET\s+(\w+)/i)?.[1].toLowerCase(),
      collation: suffix.match(/\bCOLLATE\s+(\w+)/i)?.[1].toLowerCase(),
      defaultValue: declaredDefault ? declaredDefault[2] ?? declaredDefault[1].toLowerCase() : null,
      autoIncrement: /\bAUTO_INCREMENT\b/i.test(suffix), onUpdate: /\bON UPDATE\b/i.test(suffix) });
  }
  return columns;
}

export async function inspectAiCreditSchema(connection) {
  const existing = [], incompatible = [];
  for (const table of AI_CREDIT_TABLES) {
    const [found] = await connection.execute("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [table]);
    if (!found.length) continue;
    existing.push(table);
    const reasons = [];
    if (found[0].ENGINE !== "InnoDB") reasons.push("engine must be InnoDB");
    const [actualColumns] = await connection.execute(`SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
      CHARACTER_SET_NAME, COLLATION_NAME, EXTRA FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [table]);
    const sql = AI_CREDIT_SCHEMAS[AI_CREDIT_TABLES.indexOf(table)];
    for (const [name, expected] of expectedColumns(sql)) {
      const actual = actualColumns.find(column => column.COLUMN_NAME === name);
      if (!actual) { reasons.push(`${name}: missing column`); continue; }
      if (typeOf(actual.COLUMN_TYPE) !== expected.type) reasons.push(`${name}: incompatible type`);
      if ((actual.IS_NULLABLE === "YES") !== expected.nullable) reasons.push(`${name}: incompatible nullability`);
      if (expected.charset && actual.CHARACTER_SET_NAME !== expected.charset) reasons.push(`${name}: incompatible character set`);
      if (expected.collation && actual.COLLATION_NAME !== expected.collation) reasons.push(`${name}: incompatible collation`);
      const defaultValue = actual.COLUMN_DEFAULT === null ? null : /^CURRENT_TIMESTAMP\(/i.test(actual.COLUMN_DEFAULT)
        ? String(actual.COLUMN_DEFAULT).toLowerCase() : String(actual.COLUMN_DEFAULT);
      if (defaultValue !== expected.defaultValue) reasons.push(`${name}: incompatible default`);
      if (/auto_increment/i.test(actual.EXTRA) !== expected.autoIncrement || /on update/i.test(actual.EXTRA) !== expected.onUpdate
        || /(?:virtual|stored) generated/i.test(actual.EXTRA)) reasons.push(`${name}: incompatible generated/automatic behavior`);
    }
    const [indexes] = await connection.query(`SHOW INDEX FROM ${table}`);
    for (const [name, columns] of Object.entries(uniqueKeys[table])) {
      const parts = indexes.filter(index => index.Key_name === name).sort((a, b) => a.Seq_in_index - b.Seq_in_index);
      if (parts.map(index => index.Column_name).join(",") !== columns
        || parts.some(index => Number(index.Non_unique) !== 0 || index.Sub_part !== null || index.Expression)) reasons.push(`${name}: incompatible unique key`);
    }
    for (const index of indexes) if (Number(index.Non_unique) === 0 && !Object.hasOwn(uniqueKeys[table], index.Key_name)) reasons.push(`${index.Key_name}: unexpected unique key`);
    const checks = [...sql.matchAll(/CHECK\s*\(([^\n]+)\)/g)].map(match => expressionOf(match[1]));
    if (checks.length) {
      const [actualChecks] = await connection.execute(`SELECT cc.CHECK_CLAUSE, tc.ENFORCED FROM information_schema.TABLE_CONSTRAINTS tc
        JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
        WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME=? AND tc.CONSTRAINT_TYPE='CHECK'`, [table]);
      for (const check of checks) if (!actualChecks.some(actual => actual.ENFORCED === "YES" && expressionOf(actual.CHECK_CLAUSE) === check)) reasons.push("missing enforced money check constraint");
    }
    if (reasons.length) incompatible.push({ table, reasons: [...new Set(reasons)] });
  }
  return { ok: incompatible.length === 0, create_tables: AI_CREDIT_TABLES.filter(table => !existing.includes(table)), existing_tables: existing, incompatible_tables: incompatible };
}

export async function migrateAiCredits(connection, { apply = false } = {}) {
  // New empty tables only: never infer an account, price, balance or grant.
  // Inspect every existing table before the first CREATE; never ALTER money.
  let locked = false;
  try {
    if (apply) {
      const [[lock]] = await connection.query("SELECT GET_LOCK(CONCAT('ai_credit_schema_',LEFT(SHA2(DATABASE(),256),32)),10) acquired");
      if (Number(lock.acquired) !== 1) throw new Error("AI credit schema migration is already running");
      locked = true;
    }
    const plan = await inspectAiCreditSchema(connection);
    if (apply && !plan.ok) throw Object.assign(new Error("AI credit schema is incompatible; no tables or existing balances were changed"), { code: "AI_CREDIT_SCHEMA_INCOMPATIBLE", report: plan });
    if (apply) {
      for (const sql of AI_CREDIT_SCHEMAS) await connection.query(sql);
      const verified = await inspectAiCreditSchema(connection);
      if (!verified.ok || verified.create_tables.length) throw Object.assign(new Error("AI credit schema verification failed"), { code: "AI_CREDIT_SCHEMA_INCOMPATIBLE", report: verified });
    }
    return { ...plan, mode: apply ? "apply" : "dry-run", business_rows_changed: 0, accounts_created: 0, prices_created: 0 };
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT('ai_credit_schema_',LEFT(SHA2(DATABASE(),256),32)))");
  }
}

async function main() {
  const args = process.argv.slice(2), value = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  if (args.some(arg => arg !== "--apply" && !/^(?:--database|--mysql-admin-socket)=.+$/.test(arg))) throw new Error("Unknown migration argument");
  if (new Set(args.map(arg => arg.split("=")[0])).size !== args.length) throw new Error("Duplicate migration argument");
  const socketPath = value("--mysql-admin-socket"), database = value("--database");
  if (!socketPath || !database) throw new Error("Explicit --database and --mysql-admin-socket required; application credentials are never loaded");
  const connection = await mysql.createConnection({ socketPath, database, user: "root" });
  try {
    await connection.query("SET SESSION lock_wait_timeout = 5");
    const report = await migrateAiCredits(connection, { apply: args.includes("--apply") });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
  finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
