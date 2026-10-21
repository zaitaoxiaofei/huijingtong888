#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createOrderProfitCalculationTables } from "../src/services/order-profit-calculation-schema.js";
import { baselineProfitCalculationBatch, profitCalculationBaselineAudit } from "../src/services/order-profit-calculation-baseline.js";
import { retryProfitCalculationTransaction } from "../src/services/order-profit-calculation-versions.js";

function argument(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

export async function migrateProfitCalculationVersions(connection, options = {}) {
  const write = Boolean(options.write);
  if (options.createSchema && write) await createOrderProfitCalculationTables(connection);
  let tablesAvailable = true;
  try { await connection.query("SELECT 1 FROM order_profit_calc_state LIMIT 1"); }
  catch (error) { if (error.code !== "ER_NO_SUCH_TABLE") throw error; tablesAvailable = false; }
  if (write && !tablesAvailable) throw new Error("Profit calculation tables are missing; use --write --create-schema explicitly");
  const before = await profitCalculationBaselineAudit(connection, { tablesAvailable });
  const batches = [];
  let cursor = Number(options.afterId || 0);
  if (!options.schemaOnly && !options.auditOnly) do {
    const batch = await baselineProfitCalculationBatch({
      query: connection.query.bind(connection),
      transaction: (callback) => retryProfitCalculationTransaction(async (work) => {
        await connection.beginTransaction();
        try { const result = await work(connection); await connection.commit(); return result; }
        catch (error) { await connection.rollback(); throw error; }
      }, callback)
    }, { afterId: cursor, limit: options.batchSize || 250, write });
    batches.push(batch);
    cursor = batch.next_after_id;
    if (batch.complete || !options.all || !write) break;
  } while (true);
  const after = await profitCalculationBaselineAudit(connection, { tablesAvailable });
  const projectionUnchanged = ["item_count", "estimated_profit", "actual_profit", "locked_count"].every((key) => String(before[key]) === String(after[key]));
  // Concurrent business sync can change these totals; do not silently call it a
  // clean baseline audit. The command itself never repairs either side.
  if (!projectionUnchanged && !options.allowConcurrentWriters) throw new Error("Profit baseline audit detected changed business totals; inspect concurrent writers before continuing");
  return { mode: write ? "write" : "dry_run", before, after, projection_unchanged: projectionUnchanged,
    concurrent_writers_allowed: Boolean(options.allowConcurrentWriters),
    concurrent_business_totals_changed: !projectionUnchanged, batches, next_after_id: cursor };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/migrate-order-profit-calculation-versions.mjs [--write --create-schema] [--all] [--batch-size 250] [--after-id 0] [--schema-only|--audit] [--allow-concurrent-writers]");
    return;
  }
  const { createMysqlConnection, closeMysqlConnection } = await import("./mysql-runtime.mjs");
  const connection = await createMysqlConnection({ multipleStatements: false });
  try {
    await connection.query("SET time_zone = '+00:00'");
    const result = await migrateProfitCalculationVersions(connection, {
      write: args.includes("--write"), createSchema: args.includes("--create-schema"), all: args.includes("--all"),
      schemaOnly: args.includes("--schema-only"), auditOnly: args.includes("--audit"),
      allowConcurrentWriters: args.includes("--allow-concurrent-writers"),
      batchSize: Number(argument(args, "batch-size", "250")), afterId: Number(argument(args, "after-id", "0"))
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await closeMysqlConnection(connection); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
