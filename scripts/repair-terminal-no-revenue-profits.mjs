import { closeMysqlPool } from "../src/mysql-pool.js";
import { repairTerminalNoRevenueOrderProfitsMysql } from "../src/services/mysql-cutover.js";

function argValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

const body = {
  from: argValue("from"),
  to: argValue("to"),
  refresh_snapshots: !process.argv.includes("--no-refresh")
};

try {
  const result = await repairTerminalNoRevenueOrderProfitsMysql(body);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeMysqlPool();
}
