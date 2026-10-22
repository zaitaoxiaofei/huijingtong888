import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { inspectSubscriptionVoucherSchema, SUBSCRIPTION_VOUCHER_SCHEMA } from "../src/services/subscription-voucher-schema.js";

export async function migrateSubscriptionVouchers(connection, { apply = false } = {}) {
  const query = async (sql, params = []) => (await connection.query(sql, params))[0];
  let locked = false;
  try {
    if (apply) {
      const [lock] = await query("SELECT GET_LOCK(CONCAT('subscription_vouchers_', LEFT(SHA2(DATABASE(),256),32)),10) AS acquired");
      if (Number(lock.acquired) !== 1) throw new Error("Subscription voucher schema migration lock unavailable");
      locked = true;
    }
    const before = await inspectSubscriptionVoucherSchema(query);
    if (!apply) return { mode: "dry-run", changes_database: false, ...before };
    if (before.exists && !before.ready) throw new Error(`Existing subscription voucher schema is incompatible; review required: ${before.problems.join(",")}`);
    if (!before.exists) await query(SUBSCRIPTION_VOUCHER_SCHEMA);
    const after = await inspectSubscriptionVoucherSchema(query);
    if (!after.ready) throw new Error("Subscription voucher schema verification failed");
    return { mode: "apply", changes_database: !before.exists, ...after };
  } finally {
    if (locked) await query("SELECT RELEASE_LOCK(CONCAT('subscription_vouchers_', LEFT(SHA2(DATABASE(),256),32)))");
  }
}

async function main() {
  const value = key => process.argv.find(arg => arg.startsWith(`${key}=`))?.slice(key.length + 1);
  const apply = process.argv.includes("--apply");
  const socketPath = value("--mysql-admin-socket");
  if (apply && !socketPath) throw new Error("Apply requires an explicit local --mysql-admin-socket");
  let database = value("--database"), options;
  if (socketPath && database) options = { socketPath, database, user: "root" };
  else {
    const { config } = await import("../src/config.js");
    database ||= config.dbName;
    options = socketPath ? { socketPath, database, user: "root" }
      : { host: config.dbHost, port: config.dbPort, user: config.dbUser, password: config.dbPassword, database,
        ...(process.env.DB_SOCKET_PATH ? { socketPath: process.env.DB_SOCKET_PATH } : {}) };
  }
  const connection = await mysql.createConnection({ ...options, timezone: "Z" });
  try { console.log(JSON.stringify(await migrateSubscriptionVouchers(connection, { apply }))); }
  finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
