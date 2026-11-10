let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
  const probe = new DatabaseSync(":memory:");
  const supported = typeof probe.prepare("SELECT 1").setReadBigInts === "function";
  probe.close(); if (!supported) DatabaseSync = null;
} catch { DatabaseSync = null; }
export const aiCreditSqlFixtureAvailable = Boolean(DatabaseSync);
import { AI_CREDIT_SCHEMAS } from "../../src/services/ai-credit-schema.js";

// Run the actual ledger against a private SQL database with signed 64-bit
// integers. Only MySQL syntax/locking is adapted; this does not attest MySQL
// row-lock behavior. The separate MySQL socket fixtures cover that boundary.
export function createAiCreditSqlFixture() {
  const db = new DatabaseSync(":memory:");
  db.function("UTC_TIMESTAMP", () => new Date().toISOString().slice(0, 19).replace("T", " "));
  db.exec(`CREATE TABLE tenants (id INTEGER PRIMARY KEY, slug TEXT UNIQUE, plan_code TEXT DEFAULT 'monthly_team', status TEXT DEFAULT 'active', subscription_status TEXT DEFAULT 'active', subscription_expires_at TEXT, feature_flags_json TEXT);
    CREATE TABLE people (id INTEGER PRIMARY KEY, active INTEGER DEFAULT 1, role TEXT DEFAULT 'operations', roles_json TEXT);
    CREATE TABLE tenant_members (tenant_id INTEGER, person_id INTEGER, role TEXT DEFAULT 'member', active INTEGER DEFAULT 1, business_roles_json TEXT, PRIMARY KEY(tenant_id,person_id));
    CREATE TABLE platform_grants (person_id INTEGER PRIMARY KEY, role TEXT, active INTEGER DEFAULT 1);`);
  for (const sql of AI_CREDIT_SCHEMAS) db.exec(sql
    .replace(/\b(?:BIGINT|TINYINT|INT)(?: UNSIGNED)?/g, "INTEGER")
    .replace(/\b(?:CHAR|VARCHAR|DATETIME)\(\d+\)/g, "TEXT")
    .replace(/ CHARACTER SET \w+(?: COLLATE \w+)?/g, "")
    .replace(/CURRENT_TIMESTAMP\(\d+\)/g, "CURRENT_TIMESTAMP")
    .replace(/ ON UPDATE CURRENT_TIMESTAMP/g, "")
    .replace(/ NOT NULL AUTO_INCREMENT PRIMARY KEY/g, " PRIMARY KEY AUTOINCREMENT")
    .replace(/UNIQUE KEY \w+\s*\(/g, "UNIQUE (")
    .replace(/^\s*KEY \w+[^\n]*\n/gm, "")
    .replace(/,\s*\) ENGINE=[\s\S]*$/, ")")
    .replace(/\) ENGINE=[\s\S]*$/, ")"));
  const normalized = value => typeof value === "bigint" ? value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : String(value) : value;
  const queries = [];
  async function query(sql, params = []) {
    queries.push({ sql, params });
    const translated = sql.replace(/\s+FOR (?:UPDATE|SHARE)/g, "")
      .replace(/INSERT IGNORE/g, "INSERT OR IGNORE")
      .replace(/ON DUPLICATE KEY UPDATE id = id/g, "ON CONFLICT(price_key,version) DO NOTHING")
      .replace(/ON DUPLICATE KEY UPDATE status = VALUES\(status\)/g, "ON CONFLICT(tenant_id) DO UPDATE SET status = excluded.status");
    const statement = db.prepare(translated); statement.setReadBigInts(true);
    if (/^\s*SELECT\b/i.test(sql)) return statement.all(...params).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalized(value)])));
    const result = statement.run(...params);
    return { affectedRows: normalized(result.changes), insertId: normalized(result.lastInsertRowid) };
  }
  let tail = Promise.resolve();
  const transaction = operation => {
    const result = tail.then(async () => {
      db.exec("BEGIN");
      try { const value = await operation({ execute: async (...args) => [await query(...args)] }); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    tail = result.catch(() => {}); return result;
  };
  const seed = () => db.exec(`INSERT INTO tenants(id,slug) VALUES(1,'default'),(2,'customer-a'),(3,'customer-b');
    INSERT INTO people(id) VALUES(7),(8),(9); INSERT INTO platform_grants VALUES(9,'super_admin',1);
    INSERT INTO tenant_members(tenant_id,person_id,business_roles_json) VALUES(1,7,'["operations"]'),(2,7,'["operations"]'),(2,8,'["operations"]'),(3,7,'["operations"]');`);
  return { query, transaction, queries, seed, close: () => db.close() };
}
