import { closeMysqlPool } from "../src/mysql-pool.js";
import { repairListingColorFieldPollution } from "../src/services/listing-automation.js";

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function optionNumber(name, fallback, min, max) {
  const arg = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`));
  const value = Number(arg?.split("=")[1] || fallback);
  return Math.min(Math.max(Number.isFinite(value) ? value : fallback, min), max);
}

function optionIds(name) {
  const arg = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`));
  return String(arg?.split("=")[1] || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

async function main() {
  const result = await repairListingColorFieldPollution({
    dryRun: !hasFlag("write"),
    limit: optionNumber("limit", 300, 1, 1000),
    previewLimit: optionNumber("preview", 80, 1, 300),
    draft_ids: optionIds("drafts"),
    template_ids: optionIds("templates")
  });
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} finally {
  await closeMysqlPool().catch(() => null);
}
