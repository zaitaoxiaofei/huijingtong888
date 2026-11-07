import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { mysqlQuery, closeMysqlPool } from "../src/mysql-pool.js";
import { initializeInventoryNumberingSchemaMysql, ensureInventoryNumberingMysql, repairInventoryNumberCategoryMismatchMysql } from "../src/services/inventory-numbering.js";

// Run on ECS as root before activation. Keep the application account's privileges unchanged.
const socketPath = process.argv.find(arg => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
if (!socketPath) throw new Error("Specify --mysql-admin-socket for the local MySQL administrator connection");
let admin;
try {
  const [{ account }] = await mysqlQuery("SELECT CURRENT_USER() AS account");
  const at = account.lastIndexOf("@");
  admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  const [[lock]] = await admin.query("SELECT GET_LOCK('inventory_numbering_schema_v1', 60) AS acquired");
  if (Number(lock.acquired) !== 1) throw new Error("Inventory numbering migration lock unavailable");
  await initializeInventoryNumberingSchemaMysql(admin, {
    triggerDefiner: `${admin.escape(account.slice(0, at))}@${admin.escape(account.slice(at + 1))}`
  });
  await admin.query("SELECT RELEASE_LOCK('inventory_numbering_schema_v1')");
  await ensureInventoryNumberingMysql();
  const result = await repairInventoryNumberCategoryMismatchMysql();
  console.log(`Inventory numbering schema and backfill verified; repaired ${result.repaired} category-mismatched number(s); application privileges unchanged.`);
} finally {
  if (admin) await admin.end();
  await closeMysqlPool();
}
