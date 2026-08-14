import { closeMysqlPool } from "../src/mysql-pool.js";
import { repairDirectProcurementInboundLinksMysql } from "../src/services/mysql-cutover.js";

function parseArgs(argv = []) {
  const limitArg = argv.find((item) => item.startsWith("--limit="));
  return {
    limit: Math.max(1, Math.min(5000, Number(limitArg?.split("=")[1] || 1000) || 1000))
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await repairDirectProcurementInboundLinksMysql(options);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMysqlPool();
  });
