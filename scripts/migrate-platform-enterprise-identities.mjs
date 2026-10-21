import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { PLATFORM_GRANTS_SCHEMA_SQL } from "../src/services/platform-grants.js";
import { applyIdentitySeparationMysql, IDENTITY_MIGRATION_LOG_SCHEMA_SQL, inspectIdentitySeparation, normalizeIdentityManifest } from "./lib/platform-enterprise-identity-migration.mjs";

const apply = process.argv.includes("--apply");
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

async function run() {
  const manifestPath = option("manifest");
  const manifest = manifestPath ? normalizeIdentityManifest(JSON.parse(await readFile(manifestPath, "utf8"))) : null;
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", warning: "No grants or memberships are inferred from names or legacy roles. Review explicit IDs before apply.", ...(await inspectIdentitySeparation(mysqlQuery, manifest)) }));
    return;
  }
  const socketPath = option("mysql-admin-socket");
  if (!manifest || !socketPath) throw new Error("Apply requires --manifest and --mysql-admin-socket (a local administrator socket or Windows named pipe).");
  const connection = await mysql.createConnection({ socketPath, user: "root", database: config.dbName, timezone: "Z" });
  let locked = false;
  try {
    const [[lock]] = await connection.query("SELECT GET_LOCK('platform_enterprise_identity_migration_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Identity separation migration lock unavailable.");
    locked = true;
    await connection.execute(PLATFORM_GRANTS_SCHEMA_SQL);
    await connection.execute("ALTER TABLE tenant_members ADD COLUMN business_roles_json JSON NULL").catch(error => {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    });
    await connection.execute(IDENTITY_MIGRATION_LOG_SCHEMA_SQL);
    await connection.beginTransaction();
    try {
      const result = await applyIdentitySeparationMysql(connection, manifest);
      await connection.commit();
      console.log(JSON.stringify({ mode: "apply", ...result }));
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('platform_enterprise_identity_migration_v1')");
    await connection.end();
  }
}

try { await run(); } finally { await closeMysqlPool(); }
