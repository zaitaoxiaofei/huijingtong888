#!/usr/bin/env node
import { closeMysqlPool } from "../src/mysql-pool.js";
import { forceSettleStaleDeliveredOrdersMysql } from "../src/services/mysql-cutover.js";

function numberArg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return Number(value?.slice(prefix.length) || fallback);
}

try {
  const result = await forceSettleStaleDeliveredOrdersMysql({
    write: process.argv.includes("--write"),
    age_days: numberArg("age-days", 30),
    limit: numberArg("limit", 5000)
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeMysqlPool();
}
