import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { inspectPeopleAccountKind, preparePeopleAccountKind } from "../src/services/people-account-kind.js";
import { ACCOUNT_KIND_AUDIT_SQL, applyAccountKindReview, normalizeAccountKindReview } from "./lib/people-account-kind-review.mjs";

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
async function run() {
  const manifestPath = option("manifest");
  const manifest = manifestPath ? normalizeAccountKindReview(JSON.parse(await readFile(manifestPath, "utf8"))) : null;
  if (!process.argv.includes("--apply")) {
    const schema = await inspectPeopleAccountKind(mysqlQuery);
    const rows = await mysqlQuery(`SELECT id AS person_id, ${schema.exists ? "account_kind" : "'person' AS account_kind"}, active FROM people ORDER BY id`);
    return console.log(JSON.stringify({ mode: "dry-run", changes_database: false, schema, accounts: rows, review: manifest }));
  }
  const socketPath = option("mysql-admin-socket");
  if (!socketPath || !manifest) throw new Error("Apply requires --manifest and an explicit local --mysql-admin-socket; no accounts are inferred from names");
  const connection = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  const query = async (sql, params = []) => (await connection.query(sql, params))[0];
  try {
    await preparePeopleAccountKind(query);
    await query(ACCOUNT_KIND_AUDIT_SQL);
    await connection.beginTransaction();
    try { const result = await applyAccountKindReview(connection, manifest); await connection.commit(); console.log(JSON.stringify({ mode: "apply", ...result })); }
    catch (error) { await connection.rollback(); throw error; }
  } finally { await connection.end(); }
}
try { await run(); } finally { await closeMysqlPool(); }
