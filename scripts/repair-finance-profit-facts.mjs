#!/usr/bin/env node
import { repairHistoricalFinanceProfitFactsMysql } from "../src/services/mysql-cutover.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const postingNumbers = process.argv
  .filter((arg) => arg.startsWith("--posting="))
  .map((arg) => arg.slice("--posting=".length).trim())
  .filter(Boolean);

const reasons = process.argv
  .filter((arg) => arg.startsWith("--reason="))
  .flatMap((arg) => arg.slice("--reason=".length).split(","))
  .map((value) => value.trim())
  .filter(Boolean);

const body = {
  from: argValue("from"),
  to: argValue("to"),
  limit: Number(argValue("limit", "100")),
  write: hasFlag("write"),
  only_issues: hasFlag("all") ? "0" : "1",
  posting_numbers: postingNumbers,
  reasons
};

try {
  const result = await repairHistoricalFinanceProfitFactsMysql(body);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
}
