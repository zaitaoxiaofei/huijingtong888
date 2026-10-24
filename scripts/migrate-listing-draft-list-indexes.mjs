import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { migrateListingDraftListIndexes } from "../src/services/listing-draft-list-schema.js";

export { migrateListingDraftListIndexes };

async function main() {
  const value = (name) => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const database = value("--database"), socketPath = value("--mysql-admin-socket");
  if (!database || !socketPath) throw new Error("Explicit --database and --mysql-admin-socket required; default mode is read-only");
  const connection = await mysql.createConnection({ database, socketPath, user: "root" });
  try {
    await connection.query("SET SESSION lock_wait_timeout = 5");
    const query = async (sql, params = []) => (await connection.query(sql, params))[0];
    console.log(JSON.stringify(await migrateListingDraftListIndexes(query, { database, apply: process.argv.includes("--apply") })));
  } finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
