import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { inspectDefaultTenantMemberships, membershipRepairLogSchema, normalizeRepairPersonIds, repairDefaultTenantMemberships } from "./lib/default-tenant-membership-repair.mjs";

const apply = process.argv.includes("--apply");
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

async function run() {
  if (!apply) {
    const report = await inspectDefaultTenantMemberships(mysqlQuery);
    console.log(JSON.stringify({ mode: "dry-run", changes_database: false, warning: "Candidates require human review; membership overlap alone does not prove unauthorized access.", ...report }));
    return;
  }
  const socketPath = option("mysql-admin-socket");
  const ids = normalizeRepairPersonIds(option("person-ids"));
  const reason = String(option("reason") || "").trim();
  if (!socketPath || !reason || reason.length > 500) throw new Error("Apply requires --mysql-admin-socket, reviewed --person-ids and --reason (1-500 characters).");
  const connection = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    await connection.execute(membershipRepairLogSchema);
    await connection.beginTransaction();
    try {
      const result = await repairDefaultTenantMemberships(connection, ids, reason);
      await connection.commit();
      console.log(JSON.stringify({ mode: "apply", ...result }));
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    await connection.end();
  }
}

try {
  await run();
} finally {
  await closeMysqlPool();
}
