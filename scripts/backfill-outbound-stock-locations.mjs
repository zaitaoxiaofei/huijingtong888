import { closeMysqlPool } from "../src/mysql-pool.js";
import { backfillOutboundStockLocationsMysql } from "../src/services/mysql-cutover.js";

function flagValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
const limit = Number(flagValue("limit") || 0);

try {
  const result = await backfillOutboundStockLocationsMysql({ apply, force, limit });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    console.log("Dry run only. Re-run with --apply to update outbound_records and inventory_movements.");
  }
} finally {
  await closeMysqlPool();
}
