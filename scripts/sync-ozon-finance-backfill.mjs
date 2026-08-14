#!/usr/bin/env node
import { backfillOzonFinanceMysql } from "../src/services/mysql-cutover.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const body = {
  from: argValue("from"),
  to: argValue("to"),
  shop_id: argValue("shop-id") || argValue("shop_id"),
  window_days: Number(argValue("window-days", argValue("window_days", "14"))),
  write: hasFlag("write"),
  apply_profit: hasFlag("apply-profit") || hasFlag("apply_profit")
};

try {
  const result = await backfillOzonFinanceMysql(body);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
}
