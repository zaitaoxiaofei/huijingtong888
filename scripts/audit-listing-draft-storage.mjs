import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { auditListingDraftStorage } from "../src/services/listing-draft-storage-audit.js";

async function main() {
  const value = (name) => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const database = value("--database"), socketPath = value("--mysql-admin-socket"), tenantId = value("--tenant-id");
  if (!database || !/^[A-Za-z0-9_]+$/.test(database) || !socketPath || !tenantId) throw new Error("Explicit --database, --mysql-admin-socket and --tenant-id required; read-only audit");
  const connection = await mysql.createConnection({ database, socketPath, user: "root" });
  try {
    const query = async (sql, params = []) => (await connection.query(sql, params))[0];
    console.log(JSON.stringify(await auditListingDraftStorage(query, { tenantId, afterId: Number(value("--after-id") || 0), limit: Number(value("--limit") || 200) })));
  } finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
