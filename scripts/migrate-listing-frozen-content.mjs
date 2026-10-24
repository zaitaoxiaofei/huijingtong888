import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { LISTING_FROZEN_CONTENT_SCHEMA, assertListingFrozenContentReady } from "../src/services/listing-frozen-content.js";

export async function migrateListingFrozenContent(query, { database, apply = false } = {}) {
  if (!database || !/^[A-Za-z0-9_]+$/.test(database)) throw new Error("Explicit valid database required");
  const [selected] = await query("SELECT DATABASE() AS database_name");
  if (selected?.database_name !== database) throw new Error("Selected database differs from requested database");
  const [table] = await query("SELECT ENGINE AS engine FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='listing_frozen_content'");
  if (table) await assertListingFrozenContentReady(query,{required:true});
  if (apply && !table) await query(LISTING_FROZEN_CONTENT_SCHEMA);
  if (apply && !table) await assertListingFrozenContentReady(query,{required:true});
  return { mode: apply ? "apply" : "dry-run", database, changes_database: apply && !table, table_exists: Boolean(table) || apply, data_rows_changed: 0 };
}

async function main() {
  const value = (name) => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const database=value("--database"),socketPath=value("--mysql-admin-socket");
  if (!database || !socketPath) throw new Error("Explicit --database and --mysql-admin-socket required; default mode is read-only");
  const connection=await mysql.createConnection({database,socketPath,user:"root"});
  try {
    await connection.query("SET SESSION lock_wait_timeout = 5");
    console.log(JSON.stringify(await migrateListingFrozenContent(async(sql,params=[])=>(await connection.query(sql,params))[0],{database,apply:process.argv.includes("--apply")})));
  }
  finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
